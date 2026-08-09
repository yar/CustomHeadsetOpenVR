#include "FovVisualization.h"
#include <algorithm>
#include <chrono>
#include <cmath>
#include <fstream>
#include "nlohmann/json.hpp"
#include "../Driver/DriverLog.h"

using ordered_json = nlohmann::ordered_json;

// grid resolution per eye per channel, higher is smoother contours but a larger file
static const int kGridSize = 65;

// round to 4 decimals to keep the json small
static double Quantize(float value){
	return std::round((double)value * 10000.0) / 10000.0;
}

// sample one eye and channel over the viewport into a flat [x0, y0, x1, y1, ...] array.
// the values are the render texture coordinates in [-1, 1] that end up on that spot of
// the panel, values outside [-1, 1] mean that spot shows nothing of the rendered image
static ordered_json SampleChannel(DistortionProfile* profile, const Config::BaseHeadsetConfig& config, vr::EVREye eye, ColorChannel channel){
	ordered_json samples = ordered_json::array();
	float minResolution = (float)std::min(config.resolutionX, config.resolutionY);
	float distortionZoom = (float)config.distortionZoom;
	int displayRotation = config.displayRotation;
	for(int j = 0; j < kGridSize; j++){
		for(int i = 0; i < kGridSize; i++){
			// this mirrors BaseHeadsetShim::PreDisplayComponentComputeDistortion / transformUV
			// without the subpixel offsets, so the samples match what the compositor sees.
			// like in transformUV the aspect scaling comes after the rotation, so it is applied
			// on the panel-native axes for every displayRotation
			float u = ((float)i / (kGridSize - 1) - 0.5f) * 2.0f;
			float v = ((float)j / (kGridSize - 1) - 0.5f) * 2.0f;
			if(displayRotation == 1 || displayRotation == 3){
				if(eye == vr::Eye_Left){
					float tmp = u;
					u = -v;
					v = tmp;
				}else{
					float tmp = u;
					u = v;
					v = -tmp;
				}
			}
			if(displayRotation == 2 || displayRotation == 3){
				u *= -1;
				v *= -1;
			}
			u *= config.resolutionX / minResolution;
			v *= config.resolutionY / minResolution;
			u /= distortionZoom;
			v /= distortionZoom;
			Point2D distortion = profile->ComputeDistortion(eye, channel, u, v);
			samples.push_back(Quantize(distortion.x));
			samples.push_back(Quantize(distortion.y));
		}
	}
	return samples;
}

void FovVisualization::Write(DistortionProfile* profile, const Config::BaseHeadsetConfig& config, const std::string& configFolder){
	if(profile == nullptr){
		return;
	}
	int viewportWidth = config.resolutionX;
	int viewportHeight = config.resolutionY;
	if(config.displayRotation == 1 || config.displayRotation == 3){
		std::swap(viewportWidth, viewportHeight);
	}
	Point2D axisLeft = profile->GetOpticalAxis(vr::Eye_Left);
	Point2D axisRight = profile->GetOpticalAxis(vr::Eye_Right);
	ordered_json data = {
		{"about", "Sampling of the active distortion profile for the FOV visualization in the GUI. This file is not for configuration."},
		// identify what this sampling belongs to so the GUI can tell where and how current it is
		{"headsetType", (int)config.headsetType},
		{"distortionProfile", config.distortionProfile},
		{"writtenTime", std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count() / 1000.0},
		{"gridSize", kGridSize},
		{"displayRotation", config.displayRotation},
		{"viewportWidth", viewportWidth},
		{"viewportHeight", viewportHeight},
		// where the lens is centered, as tangents in the frame of the projections (x right, y up), the direction
		// the GUI measures the view angles of the panel map from. zero unless the profile's frame is not the
		// eye's optical frame, like the Pimax PVR profile in parallel projection mode
		{"opticalAxisLeft", {Quantize(axisLeft.x), Quantize(axisLeft.y)}},
		{"opticalAxisRight", {Quantize(axisRight.x), Quantize(axisRight.y)}},
		{"left", {
			{"red", SampleChannel(profile, config, vr::Eye_Left, ColorChannelRed)},
			{"green", SampleChannel(profile, config, vr::Eye_Left, ColorChannelGreen)},
			{"blue", SampleChannel(profile, config, vr::Eye_Left, ColorChannelBlue)},
		}},
		{"right", {
			{"red", SampleChannel(profile, config, vr::Eye_Right, ColorChannelRed)},
			{"green", SampleChannel(profile, config, vr::Eye_Right, ColorChannelGreen)},
			{"blue", SampleChannel(profile, config, vr::Eye_Right, ColorChannelBlue)},
		}},
	};
	std::string path = configFolder + "fovVisualization.json";
	std::ofstream file(path);
	if(!file.is_open()){
		DriverLog("Failed to open %s for writing", path.c_str());
		return;
	}
	file << data.dump();
	DriverLog("Wrote FOV visualization sampling to fovVisualization.json");
}
