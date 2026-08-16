#include "PimaxSlam.h"

#ifdef PVR_EXISTS

#include "../Helpers/EyeTrackingOutput.h"
#include "../Helpers/PimaxCamera.h"
#include "../Helpers/PimaxHandTracking.h"
#include "../Helpers/MiscHelper.h"
#include "../Helpers/vr_blockqueue.h"

#include <chrono>
#include <cmath>
#include <DirectXMath.h>
#include <filesystem>
#include <memory>
#include "nlohmann/json.hpp"
#include <PVR_Math.h>
#include <shared_mutex>

// Matches driver_aapvr.
static constexpr uint64_t k_UniverseId = 30;

// The tracking space handed to SteamVR is the PVR space moved by this rigid transform, world = rotation * pvr + translation,
// through the world from driver part of every pose of the headset and the controllers. It is only ever a rotation about
// the vertical axis so the floor stays level. It starts as the identity and is set by recenter requests from the GUI,
// see RecenterPlayspace() and PvrTrackingThread(). It lives for the session only, the PVR space is different on every start.
//
// SteamVR shows the standing universe, which is this raw space moved once more by the room setup of the universe:
// standing = R(yaw) * raw + translation, with the standing entry of chaperone_info.vrchap giving the raw origin as seen
// from the standing space. A stale room setup (the PVR space is different on every start) puts the raw origin anywhere,
// so recentering goes in two steps: the headset is held at the raw origin while the GUI has SteamVR reset its standing
// origin to the headset (vrcmd --resetroomheight, which also resets the seated origin), which makes the room setup the
// identity but for the height it keeps between the headset and the floor. The GUI then reads that entry back and finishes
// the request, and the headset is lifted to eye height inside the standing space.
struct PlayspaceTransform {
	vr::HmdQuaternion_t rotation = { 1, 0, 0, 0 };
	double translation[3] = { 0, 0, 0 };

	void ApplyTo(vr::DriverPose_t& pose) const {
		pose.qWorldFromDriverRotation = rotation;
		pose.vecWorldFromDriverTranslation[0] = translation[0];
		pose.vecWorldFromDriverTranslation[1] = translation[1];
		pose.vecWorldFromDriverTranslation[2] = translation[2];
	}
};

// Computes the transform that puts the given head pose at the origin of the tracking space, facing forward. Only the yaw
// of the head counts, so looking up or down while recentering does not tilt the world. Lifting the head from there is a
// matter of adding to the translation, see PvrTrackingThread().
static PlayspaceTransform RecenterPlayspace(const pvrPosef& head) {
	const auto& q = head.Orientation;
	// yaw of the head, positive when turned to the left, from the horizontal projection of its forward (-Z) direction
	const double yaw = std::atan2(2.0 * (q.x * q.z + q.w * q.y), 1.0 - 2.0 * (q.x * q.x + q.y * q.y));
	// turn the space back by that yaw about the vertical axis
	const double angle = -yaw;
	PlayspaceTransform transform;
	transform.rotation = { std::cos(angle / 2), 0, std::sin(angle / 2), 0 };
	// where the head lands after the turn, the translation then moves it onto the origin
	const double turnedX = std::cos(angle) * head.Position.x + std::sin(angle) * head.Position.z;
	const double turnedZ = -std::sin(angle) * head.Position.x + std::cos(angle) * head.Position.z;
	transform.translation[0] = -turnedX;
	transform.translation[1] = -head.Position.y;
	transform.translation[2] = -turnedZ;
	return transform;
}

// A request from the GUI is only followed when it was made moments ago, so a commands.json left over from an earlier
// session does not recenter on the next start, nor does a request made while nothing was running to act on it.
static bool IsRecentRequest(uint64_t requestTimeMs) {
	const int64_t nowMs = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
	const int64_t ageMs = nowMs - (int64_t)requestTimeMs;
	return ageMs > -5000 && ageMs < 30000;
}

// A driver for Pimax Crystal controllers.
class PimaxCrystalControllerDriver : public vr::ITrackedDeviceServerDriver {
public:
	PimaxCrystalControllerDriver(vr::ETrackedControllerRole role) : role(role) {
	}

	vr::EVRInitError Activate(uint32_t unObjectId) override {
		deviceIndex = unObjectId;

		const bool isLeft = role == vr::TrackedControllerRole_LeftHand;

		const vr::PropertyContainerHandle_t container =
			vr::VRProperties()->TrackedDeviceToPropertyContainer(deviceIndex);

		vr::VRProperties()->SetInt32Property(container, vr::Prop_ControllerRoleHint_Int32, role);

		// Purely emulate an Oculus Touch controller for compatibility.
		vr::VRProperties()->SetStringProperty(container, vr::Prop_TrackingSystemName_String, "oculus");
		vr::VRProperties()->SetStringProperty(container, vr::Prop_ManufacturerName_String, "Oculus");
		vr::VRProperties()->SetStringProperty(
			container, vr::Prop_ModelNumber_String, isLeft ? "Oculus Quest2 (Left Controller)" : "Oculus Quest2 (Right Controller)");
		vr::VRProperties()->SetStringProperty(
			container, vr::Prop_InputProfilePath_String, "{oculus}/input/touch_profile.json");
		vr::VRProperties()->SetStringProperty(container, vr::Prop_ControllerType_String, "oculus_touch");
		if(k_UniverseId){
			vr::VRProperties()->SetUint64Property(container, vr::Prop_CurrentUniverseId_Uint64, k_UniverseId);
		}

		{
			using json = nlohmann::json;
			using namespace DirectX;

			std::filesystem::path renderModelPath = "{aapvr}/rendermodels/";
			std::string renderModel = isLeft ? "crystal_controller_left" : "crystal_controller_right";
			renderModelPath /= renderModel;

			vr::VRProperties()->SetStringProperty(
				container, vr::Prop_RenderModelName_String, renderModelPath.string().c_str());

			XMMATRIX originToGrip = XMMatrixIdentity();

			// SteamVR expects the pose at the origin of the render model.
			// Retrieve the tip transform from the rendermodel, and reverse it.
			const uint32_t length = vr::VRResources()->LoadSharedResource(
				(renderModelPath / (renderModel + ".json")).string().c_str(), nullptr, 0);
			std::string content;
			content.resize(length);
			vr::VRResources()->LoadSharedResource(
				(renderModelPath / (renderModel + ".json")).string().c_str(), content.data(), length);
			try {
				const auto modelJson = json::parse(content.cbegin(), content.cend(), nullptr, true, true);
				const auto componentLocal = modelJson["components"]["tip"]["component_local"];
				const auto orientation = componentLocal["rotate_xyz"].get<std::vector<float>>();
				const auto origin = componentLocal["origin"].get<std::vector<float>>();

				poseOffset = XMMatrixRotationRollPitchYaw(
					orientation[0] * 3.1415926f / 180,
					orientation[1] * 3.1415926f / 180,
					orientation[2] * 3.1415926f / 180);
				poseOffset.r[3] = XMVectorSet(origin[0], origin[1], origin[2], 1.f);
				poseOffset = XMMatrixInverse(nullptr, poseOffset);
			}
			catch (std::exception& exc) {
				DriverLog("Error parsing render model %s: %s", renderModel.c_str(), exc.what());
			}
		}

		// Setup the icons.
		vr::VRProperties()->SetStringProperty(
			container, vr::Prop_NamedIconPathDeviceOff_String, "{aapvr}/icons/crystal_controller_status_off.png");
		vr::VRProperties()->SetStringProperty(
			container, vr::Prop_NamedIconPathDeviceSearching_String, "{aapvr}/icons/crystal_controller_status_searching.gif");
		vr::VRProperties()->SetStringProperty(
			container, vr::Prop_NamedIconPathDeviceSearchingAlert_String, "{aapvr}/icons/crystal_controller_status_searching_alert.gif");
		vr::VRProperties()->SetStringProperty(
			container, vr::Prop_NamedIconPathDeviceReady_String, "{aapvr}/icons/crystal_controller_status_ready.png");
		vr::VRProperties()->SetStringProperty(
			container, vr::Prop_NamedIconPathDeviceReadyAlert_String, "{aapvr}/icons/crystal_controller_status_ready_alert.png");
		vr::VRProperties()->SetStringProperty(
			container, vr::Prop_NamedIconPathDeviceNotReady_String, "{aapvr}/icons/crystal_controller_status_error.png");
		vr::VRProperties()->SetStringProperty(
			container, vr::Prop_NamedIconPathDeviceAlertLow_String, "{aapvr}/icons/crystal_controller_status_ready_low.png");

		// Create the input components.
		vr::VRDriverInput()->CreateScalarComponent(container,
			"/input/trigger/value",
			&components[ComponentTrigger],
			vr::VRScalarType_Absolute,
			vr::VRScalarUnits_NormalizedOneSided);
		vr::VRProperties()->SetInt32Property(
			container, vr::Prop_Axis1Type_Int32, vr::EVRControllerAxisType::k_eControllerAxis_Trigger);
		vr::VRDriverInput()->CreateBooleanComponent(
			container, "/input/trigger/click", &components[ComponentTriggerClick]);
		vr::VRDriverInput()->CreateBooleanComponent(
			container, "/input/trigger/touch", &components[ComponentTriggerTouch]);
		vr::VRDriverInput()->CreateScalarComponent(container,
			"/input/grip/value",
			&components[ComponentGrip],
			vr::VRScalarType_Absolute,
			vr::VRScalarUnits_NormalizedOneSided);
		vr::VRProperties()->SetInt32Property(
			container, vr::Prop_Axis3Type_Int32, vr::EVRControllerAxisType::k_eControllerAxis_Trigger);
		vr::VRDriverInput()->CreateBooleanComponent(
			container, "/input/grip/click", &components[ComponentGripClick]);

		vr::VRDriverInput()->CreateScalarComponent(container,
			"/input/joystick/x",
			&components[ComponentThumbstickX],
			vr::VRScalarType_Absolute,
			vr::VRScalarUnits_NormalizedTwoSided);
		vr::VRDriverInput()->CreateScalarComponent(container,
			"/input/joystick/y",
			&components[ComponentThumbstickY],
			vr::VRScalarType_Absolute,
			vr::VRScalarUnits_NormalizedTwoSided);
		vr::VRProperties()->SetInt32Property(
			container, vr::Prop_Axis2Type_Int32, vr::EVRControllerAxisType::k_eControllerAxis_Joystick);
		vr::VRDriverInput()->CreateBooleanComponent(
			container, "/input/joystick/click", &components[ComponentThumbstickClick]);
		vr::VRDriverInput()->CreateBooleanComponent(
			container, "/input/joystick/touch", &components[ComponentThumbstickTouch]);
		vr::VRDriverInput()->CreateBooleanComponent(
			container, "/input/thumbrest/touch", &components[ComponentThumbrestTouch]);

		// The input profile does not support the system button on the right hand, however it still appears to work
		// in SteamVR to invoke the dashboard. It's a happy accident.
		vr::VRDriverInput()->CreateBooleanComponent(
			container, "/input/system/click", &components[ComponentMenu]);

		vr::VRDriverInput()->CreateBooleanComponent(
			container, isLeft ? "/input/y/click" : "/input/b/click", &components[ComponentButton1]);
		vr::VRDriverInput()->CreateBooleanComponent(
			container, isLeft ? "/input/y/touch" : "/input/b/touch", &components[ComponentButton1Touch]);
		vr::VRDriverInput()->CreateBooleanComponent(
			container, isLeft ? "/input/x/click" : "/input/a/click", &components[ComponentButton2]);
		vr::VRDriverInput()->CreateBooleanComponent(
			container, isLeft ? "/input/x/touch" : "/input/a/touch", &components[ComponentButton2Touch]);

		vr::VRInputComponentHandle_t componentHaptics;
		vr::VRDriverInput()->CreateHapticComponent(container, "/output/haptic", &componentHaptics);

		return vr::VRInitError_None;
	}

	void Deactivate() override {
		deviceIndex = vr::k_unTrackedDeviceIndexInvalid;
	}

	void EnterStandby() override {
	}

	void* GetComponent(const char* pchComponentNameAndVersion) override {
		return nullptr;
	}

	vr::DriverPose_t GetPose() override {
		// This method is not used by SteamVR.
		return {};
	}

	void DebugRequest(const char* pchRequest, char* pchResponseBuffer, uint32_t unResponseBufferSize) override {
		if (unResponseBufferSize >= 1) {
			pchResponseBuffer[0] = 0;
		}
	}

	void BroadcastHapticEvent(const vr::VREvent_HapticVibration_t& data) {
		if (deviceIndex != vr::k_unTrackedDeviceIndexInvalid) {
			const vr::PropertyContainerHandle_t container =
				vr::VRProperties()->TrackedDeviceToPropertyContainer(deviceIndex);

			// Only pick the events applicable to us.
			if (container == data.containerHandle) {
				shared_lock_guard<std::shared_mutex> lock(PimaxCommon::pvrLock);
				pvr_triggerHapticPulse(PimaxCommon::GetPvrSession(),
					role == vr::TrackedControllerRole_LeftHand ? pvrTrackedDevice_LeftController : pvrTrackedDevice_RightController,
					data.fAmplitude,
					data.fDurationSeconds > 0.02f ? data.fDurationSeconds : 0.02f,
					data.fFrequency);
			}
		}
	}

	void UpdateInputState(const pvrInputState& inputState) {
		const auto pvrNow = PimaxCommon::GetPvrTime();
		const auto side = role == vr::TrackedControllerRole_LeftHand ? 0 : 1;

		if (deviceIndex != vr::k_unTrackedDeviceIndexInvalid) {
			const vr::PropertyContainerHandle_t container =
				vr::VRProperties()->TrackedDeviceToPropertyContainer(deviceIndex);

			const auto timeOffset = inputState.TimeInSeconds - pvrNow;

			// Update the state of each input component.
			vr::VRDriverInput()->UpdateScalarComponent(
				components[ComponentTrigger], inputState.Trigger[side], timeOffset);
			vr::VRDriverInput()->UpdateBooleanComponent(
				components[ComponentTriggerClick], inputState.HandButtons[side] & pvrButton_Trigger, timeOffset);
			vr::VRDriverInput()->UpdateBooleanComponent(
				components[ComponentTriggerTouch], inputState.HandTouches[side] & pvrButton_Trigger, timeOffset);
			vr::VRDriverInput()->UpdateScalarComponent(
				components[ComponentGrip], inputState.Grip[side], timeOffset);
			vr::VRDriverInput()->UpdateBooleanComponent(
				components[ComponentGripClick], inputState.HandButtons[side] & pvrButton_Grip, timeOffset);

			vr::VRDriverInput()->UpdateScalarComponent(
				components[ComponentThumbstickX], inputState.JoyStick[side].x, timeOffset);
			vr::VRDriverInput()->UpdateScalarComponent(
				components[ComponentThumbstickY], inputState.JoyStick[side].y, timeOffset);
			vr::VRDriverInput()->UpdateBooleanComponent(
				components[ComponentThumbstickClick], inputState.HandButtons[side] & pvrButton_JoyStick, timeOffset);
			vr::VRDriverInput()->UpdateBooleanComponent(
				components[ComponentThumbstickTouch], inputState.HandTouches[side] & pvrButton_JoyStick, timeOffset);
			vr::VRDriverInput()->UpdateBooleanComponent(
				components[ComponentThumbrestTouch], inputState.HandTouches[side] & pvrButton_TouchPad, timeOffset);

			vr::VRDriverInput()->UpdateBooleanComponent(
				components[ComponentButton1], inputState.HandButtons[side] & pvrButton_B, timeOffset);
			vr::VRDriverInput()->UpdateBooleanComponent(
				components[ComponentButton2], inputState.HandButtons[side] & pvrButton_A, timeOffset);
			vr::VRDriverInput()->UpdateBooleanComponent(
				components[ComponentButton1Touch], inputState.HandTouches[side] & pvrButton_B, timeOffset);
			vr::VRDriverInput()->UpdateBooleanComponent(
				components[ComponentButton2Touch], inputState.HandTouches[side] & pvrButton_A, timeOffset);
			vr::VRDriverInput()->UpdateBooleanComponent(
				components[ComponentMenu], inputState.HandButtons[side] & pvrButton_ApplicationMenu, timeOffset);

			// Update the battery level.
			shared_lock_guard<std::shared_mutex> lock(PimaxCommon::pvrLock);
			const int batteryPercentage = pvr_getTrackedDeviceIntProperty(
				PimaxCommon::GetPvrSession(),
				role == vr::TrackedControllerRole_LeftHand ? pvrTrackedDevice_LeftController : pvrTrackedDevice_RightController,
				pvrTrackedDeviceProp_BatteryPercent_int,
				-1);
			if (batteryPercentage > 0) {
				vr::VRProperties()->SetFloatProperty(
					container, vr::Prop_DeviceBatteryPercentage_Float, batteryPercentage / 100.f);
				vr::VRProperties()->SetBoolProperty(
					container, vr::Prop_DeviceProvidesBatteryStatus_Bool, true);
			}
		}
	}

	// playspace is the transform of the tracking space shared with the headset so the hands stay where they are seen
	void UpdateTrackingState(const pvrPoseStatef& poseState, const PlayspaceTransform& playspace) {
		const auto pvrNow = PimaxCommon::GetPvrTime();

		vr::DriverPose_t pose = {};
		pose.qWorldFromDriverRotation.w = pose.qDriverFromHeadRotation.w = pose.qRotation.w = 1.0;
		playspace.ApplyTo(pose);
		if (deviceIndex != vr::k_unTrackedDeviceIndexInvalid) {
			isConnected = isConnected || (poseState.StatusFlags & pvrStatus_OrientationTracked);
			pose.deviceIsConnected = isConnected;
			pose.result = vr::TrackingResult_Running_OutOfRange;

			if (isConnected) {
				pose.vecPosition[0] = poseState.ThePose.Position.x;
				pose.vecPosition[1] = poseState.ThePose.Position.y;
				pose.vecPosition[2] = poseState.ThePose.Position.z;
				pose.qRotation.x = poseState.ThePose.Orientation.x;
				pose.qRotation.y = poseState.ThePose.Orientation.y;
				pose.qRotation.z = poseState.ThePose.Orientation.z;
				pose.qRotation.w = poseState.ThePose.Orientation.w;

				pose.vecVelocity[0] = poseState.LinearVelocity.x;
				pose.vecVelocity[1] = poseState.LinearVelocity.y;
				pose.vecVelocity[2] = poseState.LinearVelocity.z;
				pose.vecAngularVelocity[0] = poseState.AngularVelocity.x;
				pose.vecAngularVelocity[1] = poseState.AngularVelocity.y;
				pose.vecAngularVelocity[2] = poseState.AngularVelocity.z;

				// Add the offset to align with the controller model.
				DirectX::XMVECTOR position, orientation, scale;
				DirectX::XMMatrixDecompose(&scale, &orientation, &position, poseOffset);
				pose.vecDriverFromHeadTranslation[0] = DirectX::XMVectorGetX(position);
				pose.vecDriverFromHeadTranslation[1] = DirectX::XMVectorGetY(position);
				pose.vecDriverFromHeadTranslation[2] = DirectX::XMVectorGetZ(position);
				pose.qDriverFromHeadRotation.x = DirectX::XMVectorGetX(orientation);
				pose.qDriverFromHeadRotation.y = DirectX::XMVectorGetY(orientation);
				pose.qDriverFromHeadRotation.z = DirectX::XMVectorGetZ(orientation);
				pose.qDriverFromHeadRotation.w = DirectX::XMVectorGetW(orientation);

				pose.poseTimeOffset = poseState.TimeInSeconds - pvrNow;

				pose.poseIsValid = true;
				pose.result = vr::TrackingResult_Running_OK;
			}
			vr::VRServerDriverHost()->TrackedDevicePoseUpdated(deviceIndex, pose, sizeof(pose));
		}
	}

	void Disconnect() {
		vr::DriverPose_t pose = {};
		pose.qWorldFromDriverRotation.w = pose.qDriverFromHeadRotation.w = pose.qRotation.w = 1.0;
		isConnected = false;
		pose.result = vr::TrackingResult_Running_OutOfRange;
		vr::VRServerDriverHost()->TrackedDevicePoseUpdated(deviceIndex, pose, sizeof(pose));
	}

private:
	enum Components {
		ComponentTrigger,
		ComponentTriggerClick,
		ComponentTriggerTouch,
		ComponentGrip,
		ComponentGripClick,
		ComponentThumbstickX,
		ComponentThumbstickY,
		ComponentThumbstickClick,
		ComponentThumbstickTouch,
		ComponentThumbrestTouch,
		ComponentButton1,
		ComponentButton1Touch,
		ComponentButton2,
		ComponentButton2Touch,
		ComponentMenu,

		ComponentCount,
	};

	const vr::ETrackedControllerRole role;
	vr::TrackedDeviceIndex_t deviceIndex = vr::k_unTrackedDeviceIndexInvalid;
	vr::VRInputComponentHandle_t components[ComponentCount] = {};
	bool isConnected = false;

	DirectX::XMMATRIX poseOffset = DirectX::XMMatrixIdentity();
};


static std::unique_ptr<PimaxCrystalControllerDriver> s_controllerDriver[2];
static std::shared_mutex s_controllerDriverMutex;
static std::unique_ptr<PimaxCamera> s_cameraDriver;

PimaxSlamDriver::PimaxSlamDriver() {
	// Setting up the camera component must be done early, prior to any GetComponent().
	s_cameraDriver = PimaxCamera::TryCreatePassthrough();
}

bool PimaxSlamDriver::IsDesiredHeadset(std::string model, vr::PropertyContainerHandle_t container) {
	return true;
}

Config::BaseHeadsetConfig& PimaxSlamDriver::GetConfig(){
	return GetHeadsetConfig();
}

Config::BaseHeadsetConfig& PimaxSlamDriver::GetConfigOld(){
	return GetHeadsetConfigOld();
}

void PimaxSlamDriver::PosTrackedDeviceGetComponent(const char*& pchComponentNameAndVersion, void*& returnComponent) {
	BaseHeadsetShim::PosTrackedDeviceGetComponent(pchComponentNameAndVersion, returnComponent);
	if (strcmp(pchComponentNameAndVersion, vr::IVRCameraComponent_Version) == 0 && s_cameraDriver) {
		returnComponent = s_cameraDriver.get();
	}
}

void PimaxSlamDriver::PosTrackedDeviceActivate(uint32_t& unObjectId, vr::EVRInitError& returnValue) {
	vr::PropertyContainerHandle_t container = vr::VRProperties()->TrackedDeviceToPropertyContainer(unObjectId);

	vr::VRProperties()->SetStringProperty(container, vr::Prop_TrackingSystemName_String, "aapvr");
	vr::VRProperties()->SetStringProperty(container, vr::Prop_ManufacturerName_String, "Pimax");
	vr::VRProperties()->SetStringProperty(container, vr::Prop_ModelNumber_String, GetHmdInfo().ProductName);
	vr::VRProperties()->SetStringProperty(container, vr::Prop_RenderModelName_String, "generic_hmd");
	if(k_UniverseId){
		vr::VRProperties()->SetUint64Property(container, vr::Prop_CurrentUniverseId_Uint64, k_UniverseId);
	}

	vr::VRProperties()->SetStringProperty(
		container, vr::Prop_InputProfilePath_String, ("{" + driverConfigLoader.info.driverName + "}/input/pimaxhmd_profile.json").c_str());
	vr::VRDriverInput()->CreateBooleanComponent(
		container, "/input/system/click", &inputComponents[ComponentSystemClick]);
	vr::VRDriverInput()->CreateBooleanComponent(container, "/input/tap/click", &inputComponents[ComponentTap]);
	
	shared_lock_guard<std::shared_mutex> lock(PimaxCommon::pvrLock);
	
	// We need to set this config value before UpdateSettings() runs.
	// This is only necessary when using the PimaxDistortionProfile.
	pvr_setIntConfig(GetPvrSession(), "view_rotation_fix", GetConfig().parallelProjection);

	// We need to set the mesh values before UpdateSettings() runs.
	if (GetConfig().hiddenArea.enable && GetConfig().hiddenArea.autoHiddenArea) {
		SetVisibilityMeshes();
	}

	if (HasEyeTracking()) {
		eyeTrackingOutput.Initialize();
	}

	if (s_cameraDriver) {
		s_cameraDriver->Activate(unObjectId);
	}

	// lets the GUI know that recenter requests have somewhere to go, and whose room setup they concern
	driverConfigLoader.info.pimaxSlamActive = true;
	driverConfigLoader.info.recenterUniverseId = k_UniverseId;
	driverConfigLoader.info.needToWrite = true;

	returnValue = vr::VRInitError_None;
	BaseHeadsetShim::PosTrackedDeviceActivate(unObjectId, returnValue);
}

void PimaxSlamDriver::SubDeactivate() {
	StopPvrTracking();
	StopEyeTracking();
	pimaxHandTracking.Stop();
	driverConfigLoader.info.pimaxSlamActive = false;
	driverConfigLoader.info.needToWrite = true;
}

void PimaxSlamDriver::RunFrame() {
	if(!isActive){
		// don't do anything if not the active device
		return;
	}
	shared_lock_guard<std::shared_mutex> lock(PimaxCommon::pvrLock);
	
	if (driverConfig.hasBeenUpdated) {
		// We need to set this config value before UpdateSettings() runs.
		// This is only necessary when using the PimaxDistortionProfile.
		pvr_setIntConfig(GetPvrSession(), "view_rotation_fix", GetConfig().parallelProjection);
	}

	if (driverConfig.hasBeenUpdated &&
		(GetConfig().hiddenArea != GetConfigOld().hiddenArea || GetConfigOld().disableEye != GetConfig().disableEye)) {
		// We need to set the mesh values before UpdateSettings() runs.
		if (GetConfig().hiddenArea.enable && GetConfig().hiddenArea.autoHiddenArea) {
			SetVisibilityMeshes();
		}
	}

	BaseHeadsetShim::RunFrame();

	// Make sure to run BaseHeadsetShim::RunFrame() for housekeeping before checking for lost connection.
	if (CheckPvrDeviceLost()) {
		StopPvrTracking();
		StopEyeTracking();
		return;
	}

	StartPvrTracking();

	

	// Update eye tracking.
	if (HasEyeTracking() && GetConfig().enableEyeTracking) {
		StartEyeTracking();
	}
	else {
		StopEyeTracking();
	}
	eyeTrackingOutput.ipd = (float)(GetConfig().ipd + GetConfig().ipdOffset);
	eyeTrackingOutput.RunFrame();

	

	if (s_cameraDriver) {
		s_cameraDriver->RunFrame();
	}
}

void PimaxSlamDriver::RunPvrBackground() {
	pvr_setIntConfig(GetPvrSession(), "view_rotation_fix", GetConfig().parallelProjection);
	
	// Update controller state and buttons.
	pvrInputState inputState = {};
	pvr_getInputState(GetPvrSession(), &inputState);

	for (uint32_t side = 0; side < 2; side++) {
		// Detect controllers.
		const auto controllerType = pvr_getTrackedDeviceStringPropertyHelper(
			GetPvrSession(),
			side == 0 ? pvrTrackedDevice_LeftController : pvrTrackedDevice_RightController,
			pvrTrackedDeviceProp_ControllerType_String);
		const bool isActive = !controllerType.empty();
		{
			// Protects creation of s_controllerDriver[] and setting the isConnected flag inside PimaxCrystalControllerDriver.
			std::unique_lock lock(s_controllerDriverMutex);

			if (isActive) {
				if (!s_controllerDriver[side]) {
					const bool isPimaxController = controllerType == "pimax_crystal";
					if (isPimaxController) {
						s_controllerDriver[side] = std::make_unique<PimaxCrystalControllerDriver>(
							side == 0 ? vr::TrackedControllerRole_LeftHand : vr::TrackedControllerRole_RightHand);

						vr::VRServerDriverHost()->TrackedDeviceAdded(
							side == 0 ? "PIMAXLEFT" : "PIMAXRIGHT", vr::TrackedDeviceClass_Controller, s_controllerDriver[side].get());
					}
				}
			}
			else if (s_controllerDriver[side]) {
				s_controllerDriver[side]->Disconnect();
			}
		}

		if (s_controllerDriver[side]) {
			s_controllerDriver[side]->UpdateInputState(inputState);
		}
	}
	
	// Update the hand tracking state.
	pimaxHandTracking.RunBackground();

	// Update proximity sensor.
	pvrHmdStatus hmdStatus = {};
	if(GetConfig().proximitySensorType == Config::ProximitySensorType::ProximitySensorTypeHardware){
		pvrHmdStatus hmdStatus = {};
		pvr_getHmdStatus(GetPvrSession(), &hmdStatus);
		if(inputComponents[ComponentProximity]){
			vr::VRDriverInput()->UpdateBooleanComponent(inputComponents[ComponentProximity], hmdStatus.HmdMounted, 0);
		}
	}
	// Update the buttons state.
	bool systemClick = false, doubleTap = false;
	GetHmdButtonsState(systemClick, doubleTap);
	if(inputComponents[ComponentSystemClick]){
		vr::VRDriverInput()->UpdateBooleanComponent(inputComponents[ComponentSystemClick], systemClick, 0);
	}
	if(inputComponents[ComponentTap]){
		vr::VRDriverInput()->UpdateBooleanComponent(inputComponents[ComponentTap], doubleTap, 0);
	}
	
	
	if(GetInfo().headsetType == Config::HeadsetType::CrystalOG){
		// Update the battery level (Crystal OG).
		const vr::PropertyContainerHandle_t container = vr::VRProperties()->TrackedDeviceToPropertyContainer(deviceIndex);
		const int batteryPercentage = pvr_getTrackedDeviceIntProperty(
			GetPvrSession(), pvrTrackedDevice_HMD, pvrTrackedDeviceProp_BatteryPercent_int, -1);
		if (batteryPercentage > 0) {
			vr::VRProperties()->SetFloatProperty(container, vr::Prop_DeviceBatteryPercentage_Float, batteryPercentage / 100.f);
			vr::VRProperties()->SetBoolProperty(container, vr::Prop_DeviceProvidesBatteryStatus_Bool, true);
		}
	}

	PollMagicAttach();
}

void PimaxSlamDriver::HandleEvent(const vr::VREvent_t& event) {
	switch (event.eventType) {
	case vr::VREvent_Input_HapticVibration:
		// CustomHeadsetDeviceProvider invokes this call back from the same context as RunFrame(). No need to acquire s_controllerDriverMutex.
		for (uint32_t side = 0; side < 2; side++) {
			if (s_controllerDriver[side]) {
				s_controllerDriver[side]->BroadcastHapticEvent(event.data.hapticVibration);
			}
		}
		break;
	case vr::VREvent_SceneApplicationChanged:
		SetSceneApplicationProcess(event.data.process.pid);
		break;
	}
}

void PimaxSlamDriver::StartPvrTracking() {
	shared_lock_guard<std::shared_mutex> lock(PimaxCommon::pvrLock);
	if (GetPvrSession() && !pvrTrackingRunning.exchange(true) ) {
		DriverLog("Starting PVR tracking thread");
		pvrTrackingThread = std::thread(&PimaxSlamDriver::PvrTrackingThread, this);
	}
}

void PimaxSlamDriver::StopPvrTracking() {
	if (pvrTrackingRunning.exchange(false) && pvrTrackingThread.joinable()) {
		DriverLog("Stopping PVR tracking thread");
		pvrTrackingThread.join();
		pvrTrackingThread = {};
	}
}

void PimaxSlamDriver::PvrTrackingThread() {
	SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_TIME_CRITICAL);

	const HANDLE timer = CreateWaitableTimer(nullptr, false, nullptr);
	const LARGE_INTEGER noDelay = {};
	// TODO: Make sure this is a reasonable value. 500Hz is quite high, but it doesn't seem to largely increase CPU/GPU utilization.
	const LONG periodMs = 2;
	SetWaitableTimer(timer, &noDelay, periodMs, nullptr, nullptr, true);
	
	bool hasRecentered = false;
	double trackingSinceTime = 0;
	// the space handed to SteamVR is moved by recenter requests from the GUI within this session, see PlayspaceTransform
	PlayspaceTransform playspace = {};
	// where a recenter request stands: waiting for the headset to be tracked, holding it at the origin until the
	// request is finished, or finished with the head lifted to eye height, which then follows the eye height setting
	enum class RecenterStage { None, WaitingForTracking, Zeroed, Lifted };
	RecenterStage recenterStage = RecenterStage::None;
	// pvr time the current stage was entered, for giving up on it
	double recenterStageSince = 0;
	// the transform that holds the head at the origin, the lift is added on top of it
	PlayspaceTransform zeroPlayspace = {};
	// the raw origin as seen from the SteamVR standing space after the room setup was reset, from the finish request
	double standingOffset[3] = { 0, 0, 0 };
	// commands.json version last looked at, one behind so a request made just before the thread started is seen
	uint32_t handledCommandsVersion = driverCommands.version - 1;

	// lifts the head from the origin to eye height inside the standing space, the eye height setting is followed live
	const auto liftPlayspace = [&]() {
		playspace = zeroPlayspace;
		playspace.translation[0] -= standingOffset[0];
		playspace.translation[1] += GetHeadsetConfig().recenterEyeHeight - standingOffset[1];
		playspace.translation[2] -= standingOffset[2];
	};

	while (true) {
		WaitForSingleObject(timer, 100);
		if (!pvrTrackingRunning) {
			break;
		}

		const auto pvrNow = GetPvrTime();

		pvrTrackingState trackingState = {};
		{
			shared_lock_guard<std::shared_mutex> lock(PimaxCommon::pvrLock);
			pvr_getTrackingState(GetPvrSession(), pvrNow, &trackingState);
		}
		
		if((trackingState.HeadPose.StatusFlags & 2) == 0 || trackingSinceTime == 0){
			// reset whenever the headset is not in 6dof mode
			trackingSinceTime = pvrNow;
		}
		
		// Recenter after fully tracking for two seconds
		if(!hasRecentered && GetHeadsetConfig().recenterPimaxPlayspace && pvrNow - trackingSinceTime > 2){
			// Doing an auto-recenter is not ideal, but it's better than PVR spawning us in the middle of nowhere.
			// Players tend to start from a similar location at every boot.
			pvr_setTrackingOriginType(GetPvrSession(), pvrTrackingOrigin_FloorLevel);
			pvr_recenterTrackingOrigin(GetPvrSession());
			DriverLog("Recentered PVR tracking");
			hasRecentered = true;
			// the PVR space moved, a transform computed in the old space no longer fits
			playspace = {};
			recenterStage = RecenterStage::None;
		}

		// Recenter the tracking space on the headset when the GUI asks for it through commands.json, see the notes at
		// PlayspaceTransform. The player has just put the headset on and faces forward, so the headset becomes the center
		// of the space, its facing direction forward, and the floor is placed the configured eye height below it. This does
		// not touch the PVR origin, everything happens in the world from driver transform of the poses.
		if(const uint32_t commandsVersion = driverCommands.version; commandsVersion != handledCommandsVersion){
			handledCommandsVersion = commandsVersion;
			const DriverCommands::Recenter request = driverCommands.GetRecenter();
			if(!request.finish){
				if(request.time != handledRecenterTime){
					handledRecenterTime = request.time;
					if(IsRecentRequest(request.time)){
						recenterStage = RecenterStage::WaitingForTracking;
						recenterStageSince = pvrNow;
						driverConfigLoader.SetRecenterState(request.time, "waiting");
					}
				}
			}else if(request.time == handledRecenterTime && recenterStage == RecenterStage::Zeroed){
				// the GUI has reset the SteamVR origin to the zeroed headset, so lift it inside the standing space it left
				for(int i = 0; i < 3; i++){
					standingOffset[i] = request.hasStanding ? request.standingTranslation[i] : 0;
				}
				liftPlayspace();
				recenterStage = RecenterStage::Lifted;
				DriverLog("Recentered the tracking space on the headset, standing origin offset %.2f %.2f %.2f yaw %.3f%s",
					standingOffset[0], standingOffset[1], standingOffset[2], request.standingYaw, request.hasStanding ? "" : " (not reset)");
				driverConfigLoader.SetRecenterState(request.time, "done");
			}
		}
		if(recenterStage == RecenterStage::WaitingForTracking){
			// wait for the automatic recenter above to have moved the PVR space, and for the head to be tracked in it
			const bool autoRecenterDone = hasRecentered || !GetHeadsetConfig().recenterPimaxPlayspace;
			const unsigned int tracked6Dof = pvrStatus_OrientationTracked | pvrStatus_PositionTracked;
			if(autoRecenterDone && (trackingState.HeadPose.StatusFlags & tracked6Dof) == tracked6Dof){
				zeroPlayspace = RecenterPlayspace(trackingState.HeadPose.ThePose);
				playspace = zeroPlayspace;
				recenterStage = RecenterStage::Zeroed;
				recenterStageSince = pvrNow;
				DriverLog("Holding the headset at the origin for recentering, it was %.2f m above the PVR origin", trackingState.HeadPose.ThePose.Position.y);
				driverConfigLoader.SetRecenterState(handledRecenterTime, "zeroed");
			}else if(pvrNow - recenterStageSince > 10){
				recenterStage = RecenterStage::None;
				DriverLog("Did not recenter the tracking space, the headset was not tracked");
				driverConfigLoader.SetRecenterState(handledRecenterTime, "noTracking");
			}
		}else if(recenterStage == RecenterStage::Zeroed && pvrNow - recenterStageSince > 15){
			// nothing finished the request, lift the head anyway rather than leaving it on the floor
			for(double& offset : standingOffset){
				offset = 0;
			}
			liftPlayspace();
			recenterStage = RecenterStage::Lifted;
			DriverLog("Recentered the tracking space on the headset without the SteamVR origin being reset");
			driverConfigLoader.SetRecenterState(handledRecenterTime, "done");
		}else if(recenterStage == RecenterStage::Lifted){
			// the floor follows the eye height setting so it can be tuned while wearing the headset
			liftPlayspace();
		}

		// Update the headset pose.
		{
			vr::DriverPose_t pose = {};
			pose.qWorldFromDriverRotation.w = pose.qDriverFromHeadRotation.w = pose.qRotation.w = 1.0;
			playspace.ApplyTo(pose);
			pose.deviceIsConnected = true;
			pose.result = vr::TrackingResult_Running_OutOfRange;
			if (trackingState.HeadPose.StatusFlags & pvrStatus_OrientationTracked) {
				pose.vecPosition[0] = trackingState.HeadPose.ThePose.Position.x;
				pose.vecPosition[1] = trackingState.HeadPose.ThePose.Position.y;
				pose.vecPosition[2] = trackingState.HeadPose.ThePose.Position.z;
				pose.qRotation.x = trackingState.HeadPose.ThePose.Orientation.x;
				pose.qRotation.y = trackingState.HeadPose.ThePose.Orientation.y;
				pose.qRotation.z = trackingState.HeadPose.ThePose.Orientation.z;
				pose.qRotation.w = trackingState.HeadPose.ThePose.Orientation.w;

				pose.vecVelocity[0] = trackingState.HeadPose.LinearVelocity.x;
				pose.vecVelocity[1] = trackingState.HeadPose.LinearVelocity.y;
				pose.vecVelocity[2] = trackingState.HeadPose.LinearVelocity.z;

				pose.vecAngularVelocity[0] = trackingState.HeadPose.AngularVelocity.x;
				pose.vecAngularVelocity[1] = trackingState.HeadPose.AngularVelocity.y;
				pose.vecAngularVelocity[2] = trackingState.HeadPose.AngularVelocity.z;

				pose.poseTimeOffset = trackingState.HeadPose.TimeInSeconds - pvrNow;

				pose.poseIsValid = true;
				pose.result = vr::TrackingResult_Running_OK;
			}
			vr::VRServerDriverHost()->TrackedDevicePoseUpdated(deviceIndex, pose, sizeof(pose));
		}

		{
			std::shared_lock lock(s_controllerDriverMutex);

			for (uint32_t side = 0; side < 2; side++) {
				if (s_controllerDriver[side]) {
					s_controllerDriver[side]->UpdateTrackingState(trackingState.HandPoses[side], playspace);
				}
			}
		}

		// Update the hand tracking state.
		pimaxHandTracking.RunFrame();
	}

	CloseHandle(timer);

	DriverLog("PVR tracking thread stopped");
}

#endif // PVR_EXISTS
