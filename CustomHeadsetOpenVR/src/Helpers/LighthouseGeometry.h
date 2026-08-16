#pragma once
#include <string>
#include "../Config/Config.h"
#include "nlohmann/json_fwd.hpp"

// Writes lighthouseGeometry.json, the tracking geometry of the lighthouse tracked HMD taken from
// the device's lighthouse config json: the optical sensors and the head frame that the
// lighthouse driver reports the pose in. Together with the eye to head transforms recorded in
// info.json the GUI uses this to draw where SteamVR places the eyes relative to the sensors.
// This is only used for visualization and never feeds back into the driver.
namespace LighthouseGeometry {
	// extract the geometry from the parsed lighthouse config of an hmd class device and write it
	// to lighthouseGeometry.json in the given config folder (with trailing slash).
	// config is the json as it is handed to the lighthouse driver, so with any overrides applied,
	// originalHead is the head block as it came from the device (or null when it is not known)
	void Write(const nlohmann::ordered_json& config, const nlohmann::ordered_json* originalHead, Config::HeadsetType headsetType, const std::string& configFolder);
	// remove the file of the previous session so a headset without lighthouse tracking does not show stale geometry
	void Clear(const std::string& configFolder);
};
