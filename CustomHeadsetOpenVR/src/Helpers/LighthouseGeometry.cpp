#include "LighthouseGeometry.h"
#include <chrono>
#include <cmath>
#include <cstdio>
#include <fstream>
#include "nlohmann/json.hpp"
#include "../Driver/DriverLog.h"

using ordered_json = nlohmann::ordered_json;

// round to a tenth of a millimeter, plenty for a drawing and keeps the json small
static double QuantizeMeters(double value){
	return std::round(value * 10000.0) / 10000.0;
}

// read a [x, y, z] number array from the json, returns false and leaves out untouched otherwise
static bool ReadVector3(const ordered_json& value, double* out){
	if(!value.is_array() || value.size() != 3){
		return false;
	}
	for(int i = 0; i < 3; i++){
		if(!value[i].is_number()){
			return false;
		}
	}
	for(int i = 0; i < 3; i++){
		out[i] = value[i].get<double>();
	}
	return true;
}

static ordered_json Vector3ToJson(const double* value, bool quantize = true){
	if(quantize){
		return ordered_json::array({QuantizeMeters(value[0]), QuantizeMeters(value[1]), QuantizeMeters(value[2])});
	}
	return ordered_json::array({value[0], value[1], value[2]});
}

// read a frame definition block like "head": the position of the frame's origin and the
// directions of its +x and +z axes, all in the object coordinate system of the sensor model
static ordered_json ReadFrame(const ordered_json& block, bool& valid){
	valid = false;
	if(!block.is_object()){
		return nullptr;
	}
	double position[3] = {0, 0, 0};
	double plusX[3] = {1, 0, 0};
	double plusZ[3] = {0, 0, 1};
	bool hasPosition = block.contains("position") && ReadVector3(block["position"], position);
	bool hasPlusX = block.contains("plus_x") && ReadVector3(block["plus_x"], plusX);
	bool hasPlusZ = block.contains("plus_z") && ReadVector3(block["plus_z"], plusZ);
	if(!hasPosition && !hasPlusX && !hasPlusZ){
		return nullptr;
	}
	valid = true;
	return {
		{"position", Vector3ToJson(position)},
		{"plusX", Vector3ToJson(plusX, false)},
		{"plusZ", Vector3ToJson(plusZ, false)},
	};
}

// read the 3x4 extrinsics matrix of one eye from tracking_to_eye_transform, null when absent
static ordered_json ReadExtrinsics(const ordered_json& eye){
	if(!eye.is_object() || !eye.contains("extrinsics") || !eye["extrinsics"].is_array() || eye["extrinsics"].size() != 3){
		return nullptr;
	}
	ordered_json rows = ordered_json::array();
	for(const ordered_json& row : eye["extrinsics"]){
		if(!row.is_array() || row.size() != 4){
			return nullptr;
		}
		ordered_json values = ordered_json::array();
		for(const ordered_json& value : row){
			if(!value.is_number()){
				return nullptr;
			}
			values.push_back(value.get<double>());
		}
		rows.push_back(values);
	}
	return rows;
}

void LighthouseGeometry::Write(const ordered_json& config, const ordered_json* originalHead, Config::HeadsetType headsetType, const std::string& configFolder){
	if(!config.is_object()){
		return;
	}
	bool headValid = false;
	ordered_json head = config.contains("head") ? ReadFrame(config["head"], headValid) : nullptr;

	// the optical sensors, positions in meters with the direction each one faces
	ordered_json sensors = ordered_json::array();
	if(config.contains("lighthouse_config") && config["lighthouse_config"].is_object()){
		const ordered_json& lighthouseConfig = config["lighthouse_config"];
		if(lighthouseConfig.contains("modelPoints") && lighthouseConfig["modelPoints"].is_array()){
			const ordered_json& points = lighthouseConfig["modelPoints"];
			const ordered_json* normals = nullptr;
			if(lighthouseConfig.contains("modelNormals") && lighthouseConfig["modelNormals"].is_array() && lighthouseConfig["modelNormals"].size() == points.size()){
				normals = &lighthouseConfig["modelNormals"];
			}
			for(size_t i = 0; i < points.size(); i++){
				double position[3];
				if(!ReadVector3(points[i], position)){
					continue;
				}
				ordered_json sensor = {
					{"position", Vector3ToJson(position)},
				};
				double normal[3];
				if(normals != nullptr && ReadVector3((*normals)[i], normal)){
					sensor["normal"] = ordered_json::array({
						std::round(normal[0] * 1000.0) / 1000.0,
						std::round(normal[1] * 1000.0) / 1000.0,
						std::round(normal[2] * 1000.0) / 1000.0,
					});
				}
				sensors.push_back(sensor);
			}
		}
	}
	if(!headValid && sensors.empty()){
		// nothing worth drawing
		return;
	}

	// the head block before any user override, so the GUI can show what was changed
	bool headOverridden = false;
	ordered_json originalHeadJson = nullptr;
	if(originalHead != nullptr){
		bool originalValid = false;
		originalHeadJson = ReadFrame(*originalHead, originalValid);
		if(originalValid && head != originalHeadJson){
			headOverridden = true;
		}
	}

	// the lens extrinsics of the two eyes when the config has them, these are used by the lighthouse
	// driver for its own eye to head transform on headsets that do not get one from this driver
	ordered_json eyeExtrinsics = nullptr;
	if(config.contains("tracking_to_eye_transform") && config["tracking_to_eye_transform"].is_array() && config["tracking_to_eye_transform"].size() == 2){
		ordered_json left = ReadExtrinsics(config["tracking_to_eye_transform"][0]);
		ordered_json right = ReadExtrinsics(config["tracking_to_eye_transform"][1]);
		if(!left.is_null() && !right.is_null()){
			eyeExtrinsics = ordered_json::array({left, right});
		}
	}

	auto stringField = [&](const char* key) -> std::string {
		return (config.contains(key) && config[key].is_string()) ? config[key].get<std::string>() : "";
	};

	ordered_json data = {
		{"about", "Tracking geometry of the lighthouse tracked headset for the eye position visualization in the GUI, taken from the device's lighthouse config. Positions are in meters in the object coordinate system of the sensor model. This file is not for configuration."},
		{"writtenTime", std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count() / 1000.0},
		{"headsetType", (int)headsetType},
		{"modelNumber", stringField("model_number")},
		{"manufacturer", stringField("manufacturer")},
		{"serial", stringField("device_serial_number")},
		// the frame the pose is reported in, its origin should be between the user's pupils
		{"head", head},
		{"headOverridden", headOverridden},
		{"originalHead", headOverridden ? originalHeadJson : ordered_json(nullptr)},
		{"sensors", sensors},
		{"eyeExtrinsics", eyeExtrinsics},
	};
	std::string path = configFolder + "lighthouseGeometry.json";
	std::ofstream file(path);
	if(!file.is_open()){
		DriverLog("Failed to open %s for writing", path.c_str());
		return;
	}
	file << data.dump();
	DriverLog("Wrote lighthouse geometry of %s (%i sensors) to lighthouseGeometry.json", stringField("model_number").c_str(), (int)sensors.size());
}

void LighthouseGeometry::Clear(const std::string& configFolder){
	std::string path = configFolder + "lighthouseGeometry.json";
	if(std::remove(path.c_str()) == 0){
		DriverLog("Removed the lighthouse geometry of the previous session");
	}
}
