#pragma once
#include "Config.h"
#include <string>
#include <vector>
#include <mutex>
#include <atomic>
#include <cstdint>


// One shot requests from utilities like the GUI, read from commands.json in the config folder.
// Every request carries the unix time in milliseconds it was made at, which is also its identity: a request is only
// acted on when that time changes, and requests older than a few seconds are ignored so a leftover file does not
// fire again on the next start. The outcome is reported back through info.json.
class DriverCommands{
public:
	// {"recenter": {"time": ..., "phase": "zero" | "finish", "standing": {"translation": [x, y, z], "yaw": r}}}
	// asks to recenter the tracking space on the headset in two steps, see PimaxSlamDriver::PvrTrackingThread():
	// the request holds the headset at the origin of the raw space, "finish" for the same time then lifts it to eye
	// height, with the SteamVR standing origin as it ended up in the raw space so it can be folded in
	class Recenter{
	public:
		uint64_t time = 0;
		bool finish = false;
		bool hasStanding = false;
		double standingTranslation[3] = {0, 0, 0};
		double standingYaw = 0;
	};
	// increases with every change of the request, so readers only take the lock when there is something new
	std::atomic<uint32_t> version{0};
	Recenter GetRecenter(){
		std::lock_guard<std::mutex> guard(lock);
		return recenter;
	}
	void SetRecenter(const Recenter& newRecenter){
		{
			std::lock_guard<std::mutex> guard(lock);
			recenter = newRecenter;
		}
		version++;
	}
private:
	std::mutex lock;
	Recenter recenter;
};

// global commands object, updated by the config loader when commands.json changes
extern DriverCommands driverCommands;


// This class loads config files and watches for changes to them, updating the global config object as needed.
class ConfigLoader{
public:
	// class to contain info from elsewhere in the driver to write to info.json
	// this is not structured in the same way as the json file so check WriteInfo in ConfigLoader.cpp
	class Info{
	public:
		double renderFovX = 0;
		double renderFovY = 0;
		double renderFovMaxX = 0;
		double renderFovMaxY = 0;
		double combinedFovX = 0;
		double combinedFovY = 0;
		// raw projection half angle tangents for each eye as [left, right, bottom, top]
		// these are in eye space and do not include eye rotation
		double projectionLeft[4] = {0, 0, 0, 0};
		double projectionRight[4] = {0, 0, 0, 0};
		// eye rotation offset in degrees applied by the active distortion profile on top of the eyeRotation setting
		double eyeRotationOffset = 0;
		uint32_t renderResolution1To1X = 0;
		uint32_t renderResolution1To1Y = 0;
		double renderResolution1To1Percent = 0;
		uint32_t renderResolution100PercentX = 0;
		uint32_t renderResolution100PercentY = 0;
		// output resolution of the compositor per eye
		uint32_t outputResolutionX = 0;
		uint32_t outputResolutionY = 0;
		// the eye to head transforms last handed to SteamVR with SetDisplayEyeToHead, row major 3x4 in meters.
		// these place the rendering cameras relative to the tracked pose, the GUI draws them against the lighthouse geometry
		bool eyeToHeadValid = false;
		double eyeToHeadLeft[3][4] = {};
		double eyeToHeadRight[3][4] = {};
		std::string debugLog = "";
		std::string driverName = "";
		std::string driverResources = "";
		std::string steamvrResources = "";
		Config::HeadsetType connectedHeadset = Config::HeadsetType::None;
		// if a headset that does not use the steamvr compositor is connected
		bool nonNativeHeadsetFound = false;
		// if the SteamVR dashboard is currently open
		bool isDashboardOpen = false;
		// if the Pimax SLAM headset implementation is running the active headset, it is what acts on recenter requests
		bool pimaxSlamActive = false;
		// progress of the last recenter request from commands.json: the request time it answers and
		// "idle" (no request this session), "waiting" (for tracking), "zeroed" (holding the headset at the origin
		// until the request is finished), "done" or "noTracking" (gave up)
		uint64_t recenterRequestTime = 0;
		std::string recenterState = "idle";
		// the SteamVR tracking universe of the headset that recenters, whose room setup the GUI resets while zeroed
		uint64_t recenterUniverseId = 0;
		// used when watching info
		bool hasBeenUpdated = true;
		// notifies thread that it should be written (uses diagnostic thread)
		bool needToWrite = true;
	};
	Info info;

	// class to contain diagnostic data written to diagnostic.json at 4 times per second
	class DiagnosticInfo{
	public:
		// SteamVR server process ID
		uint32_t vrserverPID = 0;
		
		// Eye tracking data
		bool eyeTrackingValid = false;
		float leftAngleX = 0;
		float leftAngleY = 0;
		float rightAngleX = 0;
		float rightAngleY = 0;
		float focalPointX = 0;
		float focalPointY = 0;
		float focalPointZ = 0;
	};
	DiagnosticInfo diagnosticInfo;

	bool started = false;
	// read from info. used in the compositor to get info from the main driver
	bool watchInfo = false;
	// parse the config file into the global config object
	void ParseConfig();
	// load a distortion profile config from disk
	DistortionProfileConfig ParseDistortionConfig(std::string name);
	// save the info.json file to disk
	void WriteInfo();
	// remember the eye to head transforms handed to SteamVR and queue an info write
	void SetEyeToHead(const float left[3][4], const float right[3][4]);
	// record the outcome of a recenter request and queue an info write
	void SetRecenterState(uint64_t requestTime, const std::string& state);
	// read the info.json file from disk
	void ReadInfo();
	// read commands.json from disk into the global commands object
	void ParseCommands();
	// write the diagnostic.json file to disk (high frequency, 4 times per second)
	void WriteDiagnosticInfo();
	// start the config parser
	void Start();
	// create basic directory structure
	void CreateDirectories();
	// thread to write info
	// void WriteInfoThread();
	// thread to write diagnostic info at 4 times per second
	void WriteDiagnosticInfoThread();
	// thread to watch for file changes
	void WatcherThread();
	// thread for watching distortions if enabled
	void WatcherThreadDistortions();
	// get folder with trailin slash for config files
	std::string GetConfigFolder();
private:
	bool hasLoggedConfigFileNotFound = false;
	std::mutex infoWriteLock;
	std::mutex diagnosticWriteLock;
};

// global config loader object, used to load config files and watch for changes
extern ConfigLoader driverConfigLoader;

// check if custom shaders are enabled for the current headset type
inline bool IsCustomShaderEnabled(){
	if(!driverConfig.customShader.enable){
		return false;
	}
	if(driverConfigLoader.info.connectedHeadset == Config::HeadsetType::MeganeX8K){
		return driverConfig.customShader.enableForMeganeX8K;
	}
	if(Config::IsPimaxHeadset(driverConfigLoader.info.connectedHeadset)){
		return driverConfig.customShader.enableForPimax;
	}
	// all other headsets that do not have explicit toggles
	if(driverConfigLoader.info.connectedHeadset != Config::HeadsetType::None){
		return driverConfig.customShader.enableForOther;
	}
	return false;
}