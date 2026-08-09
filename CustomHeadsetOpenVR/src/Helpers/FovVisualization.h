#pragma once
#include <string>
#include "../Config/Config.h"
#include "../Distortion/DistortionProfile.h"

// Writes fovVisualization.json, a sampling of the active distortion profile used by the
// GUI to draw how view angles map onto the panels. This is only used for visualization
// and is kept separate from the rest of the driver so it can not affect rendering.
namespace FovVisualization {
	// sample the distortion of both eyes for all color channels and write the result
	// to fovVisualization.json in the given config folder (with trailing slash)
	void Write(DistortionProfile* profile, const Config::BaseHeadsetConfig& config, const std::string& configFolder);
};
