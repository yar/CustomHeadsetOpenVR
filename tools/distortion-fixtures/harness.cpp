// Generates ground truth for the GUI's TypeScript port of the driver's distortion pipeline
// (CustomHeadsetGUI/src/app/utilities/distortion) straight from the driver sources: the profile
// math and the panel sampling below ARE the driver's code, included as is, and the lines around
// them are copied from BaseHeadsetShim::UpdateSettings / GetRecommendedRenderTargetSize and
// DistortionProfileConstructor. See README.md for how to build and run it.
//
// usage: harness <cases.json> <info.json> <out.json>
//   cases.json: {"sampleStride": 4, "cases": [{"name", "headset", "config": {overrides}, "profile": "<built-in name>" | {definition}}]}
//   info.json:  a driver info.json, its builtInDistortionProfiles are the profile definitions cases refer to by name
//   out.json:   the fixture consumed by distortion-evaluation.spec.ts
#include <algorithm>
#include <cmath>
#include <cstdarg>
#include <cstdio>
#include <fstream>
#include <iostream>
#include <string>
#include <vector>
#include "../../CustomHeadsetOpenVR/src/Distortion/RadialBezierDistortionProfile.cpp"
#include "../../CustomHeadsetOpenVR/src/Distortion/NoneDistortionProfile.h"
#include "../../CustomHeadsetOpenVR/src/Helpers/FovVisualization.cpp"

// the driver's log sinks, declared by DriverLog.h
void DriverLog(const char*, ...){}
void DebugDriverLog(const char*, ...){}
void DriverLogString(const char*){}

// the headset config classes with their built-in defaults, by the device name used in profiles and the GUI
static Config::BaseHeadsetConfig* MakeConfig(const std::string& headset){
	if(headset == "MeganeX8K") return new Config::MeganeX8KConfig();
	if(headset == "DreamAir") return new Config::DreamAirConfig();
	if(headset == "DreamAirSE") return new Config::DreamAirSEConfig();
	if(headset == "CrystalSuper50PPD") return new Config::CrystalSuper50PPDConfig();
	if(headset == "CrystalSuper57PPD") return new Config::CrystalSuper57PPDConfig();
	if(headset == "CrystalSuperUltrawide") return new Config::CrystalSuperUltrawideConfig();
	if(headset == "CrystalSuperMicroOLED") return new Config::CrystalSuperMicroOLEDConfig();
	if(headset == "CrystalLight") return new Config::CrystalLightConfig();
	if(headset == "CrystalOG") return new Config::CrystalOGConfig();
	if(headset == "Pimax5KSuper") return new Config::Pimax5KSuperConfig();
	if(headset == "Pimax5KPlus") return new Config::Pimax5KPlusConfig();
	if(headset == "Pimax8KX") return new Config::Pimax8KXConfig();
	if(headset == "Pimax8KPlus") return new Config::Pimax8KPlusConfig();
	if(headset == "PimaxArtisan") return new Config::PimaxArtisanConfig();
	std::cerr << "unknown headset " << headset << ", using the base defaults" << std::endl;
	return new Config::BaseHeadsetConfig();
}

template<typename T>
static void Override(const ordered_json& overrides, const char* key, T& field){
	if(overrides.contains(key)){
		field = overrides[key].get<T>();
	}
}

// the config fields that shape the distortion, in the same form the GUI reads them from info.json / settings.json
static void ApplyOverrides(Config::BaseHeadsetConfig& config, const ordered_json& overrides){
	Override(overrides, "distortionProfile", config.distortionProfile);
	Override(overrides, "resolutionX", config.resolutionX);
	Override(overrides, "resolutionY", config.resolutionY);
	Override(overrides, "displayRotation", config.displayRotation);
	Override(overrides, "maxFovX", config.maxFovX);
	Override(overrides, "maxFovY", config.maxFovY);
	Override(overrides, "fovZoom", config.fovZoom);
	Override(overrides, "flatFovZoom", config.flatFovZoom);
	Override(overrides, "distortionZoom", config.distortionZoom);
	Override(overrides, "chromaticAberrationScaleRed", config.chromaticAberrationScaleRed);
	Override(overrides, "chromaticAberrationScaleBlue", config.chromaticAberrationScaleBlue);
	Override(overrides, "fovClamping", config.fovClamping);
	Override(overrides, "fovBurnInPrevention", config.fovBurnInPrevention);
	Override(overrides, "disableEye", config.disableEye);
	Override(overrides, "disableEyeDecreaseFov", config.disableEyeDecreaseFov);
	Override(overrides, "eyeRotation", config.eyeRotation);
	Override(overrides, "renderResolutionMultiplierX", config.renderResolutionMultiplierX);
	Override(overrides, "renderResolutionMultiplierY", config.renderResolutionMultiplierY);
}

static ordered_json ConfigJson(const Config::BaseHeadsetConfig& config){
	return {
		{"distortionProfile", config.distortionProfile},
		{"distortionZoom", config.distortionZoom},
		{"fovZoom", config.fovZoom},
		{"flatFovZoom", config.flatFovZoom},
		{"chromaticAberrationScaleRed", config.chromaticAberrationScaleRed},
		{"chromaticAberrationScaleBlue", config.chromaticAberrationScaleBlue},
		{"resolutionX", config.resolutionX},
		{"resolutionY", config.resolutionY},
		{"displayRotation", config.displayRotation},
		{"maxFovX", config.maxFovX},
		{"maxFovY", config.maxFovY},
		{"fovBurnInPrevention", config.fovBurnInPrevention},
		{"fovClamping", config.fovClamping},
		{"renderResolutionMultiplierX", config.renderResolutionMultiplierX},
		{"renderResolutionMultiplierY", config.renderResolutionMultiplierY},
		{"eyeRotation", config.eyeRotation},
		{"disableEye", config.disableEye},
		{"disableEyeDecreaseFov", config.disableEyeDecreaseFov},
	};
}

// DistortionProfileConstructor::LoadDistortionProfile for a definition in the info.json / profile file form,
// followed by ReInitializeProfile with the given settings. Non RadialBezier types run the none profile.
static DistortionProfile* MakeProfile(const ordered_json& definition, NoneDistortionProfile& settings){
	DistortionProfile* profile = nullptr;
	if(definition.value("type", std::string("None")) == "RadialBezier"){
		RadialBezierDistortionProfile* radialBezierProfile = new RadialBezierDistortionProfile();
		auto readPoints = [](const ordered_json& array, std::vector<RadialBezierDistortionProfile::DistortionPoint>& points){
			// DistortionProfileConfig holds doubles, LoadDistortionProfile casts each to float
			std::vector<double> values = array.get<std::vector<double>>();
			if(values.size() >= 2){
				points.clear();
				for(size_t i = 0; i < values.size() / 2; i++){
					points.push_back({(float)values[i * 2], (float)values[i * 2 + 1]});
				}
			}
		};
		if(definition.contains("distortions")) readPoints(definition["distortions"], radialBezierProfile->distortions);
		if(definition.contains("distortionsRed")) readPoints(definition["distortionsRed"], radialBezierProfile->distortionsRed);
		if(definition.contains("distortionsBlue")) readPoints(definition["distortionsBlue"], radialBezierProfile->distortionsBlue);
		radialBezierProfile->legacySmoothing = definition.value("legacySmoothing", false);
		radialBezierProfile->smoothAmount = definition.value("smoothAmount", 0.66);
		// float fields in DistortionProfileConfig, parsed from doubles
		radialBezierProfile->offsetX = (float)definition.value("offsetX", 0.0);
		radialBezierProfile->offsetY = (float)definition.value("offsetY", 0.0);
		radialBezierProfile->eyeRotationOffset = (float)definition.value("eyeRotationOffset", 0.0);
		profile = radialBezierProfile;
	}else{
		profile = &settings;
	}
	// ReInitializeProfile
	profile->resolution = settings.resolution;
	profile->resolutionX = settings.resolutionX;
	profile->resolutionY = settings.resolutionY;
	profile->maxFovX = settings.maxFovX;
	profile->maxFovY = settings.maxFovY;
	profile->fovZoom = settings.fovZoom;
	profile->flatFovZoom = settings.flatFovZoom;
	profile->chromaticAberrationScaleRed = settings.chromaticAberrationScaleRed;
	profile->chromaticAberrationScaleBlue = settings.chromaticAberrationScaleBlue;
	profile->fovClamping = settings.fovClamping;
	if(profile->fovZoom == 0.0f){
		profile->fovZoom = 1.0f;
	}
	profile->Initialize();
	return profile;
}

// keep every stride-th grid point of a SampleChannel array so the fixture stays small
static ordered_json Subsample(const ordered_json& samples, int stride){
	ordered_json out = ordered_json::array();
	for(int j = 0; j < kGridSize; j += stride){
		for(int i = 0; i < kGridSize; i += stride){
			out.push_back(samples[(j * kGridSize + i) * 2]);
			out.push_back(samples[(j * kGridSize + i) * 2 + 1]);
		}
	}
	return out;
}

static ordered_json RunCase(const ordered_json& testCase, const ordered_json& builtInProfiles, int stride){
	std::string headset = testCase.value("headset", std::string("MeganeX8K"));
	Config::BaseHeadsetConfig* config = MakeConfig(headset);
	if(testCase.contains("config")){
		ApplyOverrides(*config, testCase["config"]);
	}
	ordered_json definition;
	std::string profileName;
	if(testCase["profile"].is_string()){
		profileName = testCase["profile"].get<std::string>();
		definition = builtInProfiles.at(profileName);
	}else{
		definition = testCase["profile"];
		profileName = testCase.value("name", std::string("custom"));
	}
	config->distortionProfile = profileName;

	// BaseHeadsetShim: the distortion settings from the config
	NoneDistortionProfile settings;
	settings.resolution = (float)std::min(config->resolutionX, config->resolutionY);
	settings.resolutionX = (float)config->resolutionX;
	settings.resolutionY = (float)config->resolutionY;
	settings.noneDistortionFovHorizontal = 95;
	settings.noneDistortionFovVertical = 95;
	settings.maxFovX = (float)config->maxFovX;
	settings.maxFovY = (float)config->maxFovY;
	settings.fovZoom = (float)config->fovZoom;
	settings.flatFovZoom = (float)config->flatFovZoom;
	settings.chromaticAberrationScaleRed = (float)config->chromaticAberrationScaleRed;
	settings.chromaticAberrationScaleBlue = (float)config->chromaticAberrationScaleBlue;
	settings.fovClamping = config->fovClamping;
	// the burn-in prevention shift is a per session random value, the fixture is for a session where it is 0

	DistortionProfile* profile = MakeProfile(definition, settings);

	// projections and their disabled eye handling
	float leftEyeLeft, leftEyeRight, leftEyeTop, leftEyeBottom;
	profile->GetProjectionRaw(vr::Eye_Left, &leftEyeLeft, &leftEyeRight, &leftEyeBottom, &leftEyeTop);
	float rightEyeLeft, rightEyeRight, rightEyeTop, rightEyeBottom;
	profile->GetProjectionRaw(vr::Eye_Right, &rightEyeLeft, &rightEyeRight, &rightEyeBottom, &rightEyeTop);
	// GetRecommendedRenderTargetSize reads the render fov from the left eye before that handling
	double renderFovX = (std::atan(leftEyeRight) - std::atan(leftEyeLeft)) * 180.0 / kPi;
	double renderFovY = (std::atan(leftEyeTop) - std::atan(leftEyeBottom)) * 180.0 / kPi;
	if(config->disableEye & 1 && config->disableEyeDecreaseFov){
		leftEyeRight = leftEyeTop = 0.000001f;
		leftEyeBottom = leftEyeLeft = -leftEyeTop;
	}
	if(config->disableEye & 2 && config->disableEyeDecreaseFov){
		rightEyeLeft = rightEyeTop = 0.000001f;
		rightEyeBottom = rightEyeRight = -rightEyeTop;
	}

	// max fov of the profile from a 170 degree clamped instance, times 1.1 when clamping is off
	NoneDistortionProfile maxFovSettings = settings;
	maxFovSettings.maxFovX = 170;
	maxFovSettings.maxFovY = 170;
	maxFovSettings.fovClamping = true;
	DistortionProfile* maxFovProfile = MakeProfile(definition, maxFovSettings);
	float maxLeft, maxRight, maxTop, maxBottom;
	maxFovProfile->GetProjectionRaw(vr::Eye_Left, &maxLeft, &maxRight, &maxBottom, &maxTop);
	double renderFovMaxX = (std::atan(maxRight) - std::atan(maxLeft)) * 180.0 / kPi;
	double renderFovMaxY = (std::atan(maxTop) - std::atan(maxBottom)) * 180.0 / kPi;
	if(!config->fovClamping){
		renderFovMaxX *= 1.1;
		renderFovMaxY *= 1.1;
	}

	// combined fov
	double combinedFovX = (std::atan(rightEyeRight) - std::atan(leftEyeLeft)) * 180.0 / kPi + config->eyeRotation * 2 + profile->eyeRotationOffset * 2;
	double combinedFovY = (std::atan(leftEyeTop) - std::atan(leftEyeBottom)) * 180.0 / kPi;

	// DistortionProfileConstructor::GetRecommendedRenderTargetSize and the BaseHeadset multipliers
	uint32_t originalWidth = (uint32_t)settings.resolutionX;
	uint32_t originalHeight = (uint32_t)settings.resolutionY;
	uint32_t renderWidth = originalWidth;
	uint32_t renderHeight = originalHeight;
	profile->GetRecommendedRenderTargetSize(&renderWidth, &renderHeight);
	double targetPixels = originalWidth * originalHeight;
	double renderPixels = renderWidth * renderHeight;
	renderWidth = (uint32_t)(renderWidth * std::sqrt(targetPixels / renderPixels));
	renderHeight = (uint32_t)(renderHeight * std::sqrt(targetPixels / renderPixels));
	renderWidth = std::min(renderWidth, 16384u);
	renderHeight = std::min(renderHeight, 16384u);
	renderWidth = static_cast<uint32_t>(renderWidth * config->renderResolutionMultiplierX);
	renderHeight = static_cast<uint32_t>(renderHeight * config->renderResolutionMultiplierY);
	uint32_t oneToOneWidth = 0;
	uint32_t oneToOneHeight = 0;
	profile->GetRecommendedRenderTargetSize(&oneToOneWidth, &oneToOneHeight);
	double requiredPercentX = (double)(oneToOneWidth * oneToOneWidth) / (double)(renderWidth * renderWidth);
	double requiredPercentY = (double)(oneToOneHeight * oneToOneHeight) / (double)(renderHeight * renderHeight);
	double requiredPercent = std::max(requiredPercentX, requiredPercentY);

	int viewportWidth = config->resolutionX;
	int viewportHeight = config->resolutionY;
	if(config->displayRotation == 1 || config->displayRotation == 3){
		std::swap(viewportWidth, viewportHeight);
	}
	ordered_json result = {
		{"name", testCase.value("name", profileName)},
		{"headset", headset},
		{"config", ConfigJson(*config)},
		{"profileName", profileName},
		{"profile", definition},
		{"expected", {
			{"resolution", {
				{"fovX", renderFovX},
				{"fovY", renderFovY},
				{"fovMaxX", renderFovMaxX},
				{"fovMaxY", renderFovMaxY},
				{"combinedFovX", combinedFovX},
				{"combinedFovY", combinedFovY},
				{"projectionLeft", {leftEyeLeft, leftEyeRight, leftEyeBottom, leftEyeTop}},
				{"projectionRight", {rightEyeLeft, rightEyeRight, rightEyeBottom, rightEyeTop}},
				{"eyeRotationOffset", profile->eyeRotationOffset},
				{"renderResolution1To1X", oneToOneWidth},
				{"renderResolution1To1Y", oneToOneHeight},
				{"renderResolution1To1Percent", requiredPercent * 100.0},
				{"renderResolution100PercentX", renderWidth},
				{"renderResolution100PercentY", renderHeight},
			}},
			// FovVisualization::SampleChannel, the driver's own sampling, thinned by the stride
			{"sampling", {
				{"gridSize", kGridSize},
				{"sampleStride", stride},
				{"displayRotation", config->displayRotation},
				{"viewportWidth", viewportWidth},
				{"viewportHeight", viewportHeight},
				{"left", {
					{"red", Subsample(SampleChannel(profile, *config, vr::Eye_Left, ColorChannelRed), stride)},
					{"green", Subsample(SampleChannel(profile, *config, vr::Eye_Left, ColorChannelGreen), stride)},
					{"blue", Subsample(SampleChannel(profile, *config, vr::Eye_Left, ColorChannelBlue), stride)},
				}},
				{"right", {
					{"red", Subsample(SampleChannel(profile, *config, vr::Eye_Right, ColorChannelRed), stride)},
					{"green", Subsample(SampleChannel(profile, *config, vr::Eye_Right, ColorChannelGreen), stride)},
					{"blue", Subsample(SampleChannel(profile, *config, vr::Eye_Right, ColorChannelBlue), stride)},
				}},
			}},
		}},
	};
	if(profile != &settings) delete profile;
	if(maxFovProfile != &maxFovSettings) delete maxFovProfile;
	delete config;
	return result;
}

int main(int argc, char** argv){
	if(argc < 4){
		std::cerr << "usage: harness <cases.json> <info.json> <out.json>" << std::endl;
		return 1;
	}
	std::ifstream casesFile(argv[1]);
	std::ifstream infoFile(argv[2]);
	if(!casesFile.is_open() || !infoFile.is_open()){
		std::cerr << "could not open the cases or info file" << std::endl;
		return 1;
	}
	ordered_json cases = ordered_json::parse(casesFile, nullptr, true, true);
	ordered_json info = ordered_json::parse(infoFile, nullptr, true, true);
	int stride = cases.value("sampleStride", 4);
	ordered_json out = {
		{"about", "Ground truth for the TypeScript port of the driver's distortion pipeline, generated by tools/distortion-fixtures/harness.cpp "
			"from the driver sources: projections, render sizes and the FovVisualization sampling (every sampleStride-th grid point of the "
			"driver's grid) for each case. Regenerate when the C++ distortion code changes."},
		{"driverVersion", info.value("driverVersion", std::string(""))},
		{"cases", ordered_json::array()},
	};
	for(const auto& testCase : cases["cases"]){
		out["cases"].push_back(RunCase(testCase, info["builtInDistortionProfiles"], stride));
		std::cout << "ran " << out["cases"].back()["name"].get<std::string>() << std::endl;
	}
	std::ofstream outFile(argv[3]);
	outFile << out.dump();
	std::cout << "wrote " << argv[3] << std::endl;
	return 0;
}
