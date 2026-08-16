#pragma once
#include "BaseHeadset.h"
#include "../Helpers/PimaxCommon.h"
#include <atomic>
#include <thread>

class PimaxSlamDriver : public BaseHeadsetShim, public PimaxCommon {
public:
	PimaxSlamDriver();
	virtual bool IsDesiredHeadset(std::string model, vr::PropertyContainerHandle_t container) override;

	virtual Config::BaseHeadsetConfig& GetConfig() override;
	virtual Config::BaseHeadsetConfig& GetConfigOld() override;

	virtual void PosTrackedDeviceGetComponent(const char*& pchComponentNameAndVersion, void*& returnComponent) override;
	virtual void PosTrackedDeviceActivate(uint32_t& unObjectId, vr::EVRInitError& returnValue) override;
	virtual void SubDeactivate() override;
	virtual void RunFrame() override;
	virtual void RunPvrBackground() override;
	virtual void HandleEvent(const vr::VREvent_t& event) override;

	void StartPvrTracking();
	void StopPvrTracking();

private:
	void PvrTrackingThread();

	std::thread pvrTrackingThread;
	std::atomic<bool> pvrTrackingRunning;
	// time of the last recenter request from commands.json that the tracking thread has seen, so a request is only
	// acted on once even when the thread is restarted after the headset reconnects
	uint64_t handledRecenterTime = 0;
};
