#pragma once
#include "DistortionProfile.h"

#include <cstdint>
#include "../Helpers/PvrAvailability.h"

#ifdef PVR_EXISTS
#include <PVR.h>

// Distortion profile that takes the lens distortion and the projection from the Pimax PVR runtime.
class PimaxDistortionProfile : public DistortionProfile {
public:
	virtual void Initialize() override;

	virtual void GetProjectionRaw(vr::EVREye eEye, float* pfLeft, float* pfRight, float* pfBottom, float* pfTop) override;

	virtual Point2D ComputeDistortion(vr::EVREye eEye, ColorChannel colorChannel, float fU, float fV) override;

	virtual void GetRecommendedRenderTargetSize(uint32_t* pnWidth, uint32_t* pnHeight) override;

	virtual Point2D GetOpticalAxis(vr::EVREye eEye) override;

private:
	// the frustum the texture coordinates of pvr_getHmdDistortedUV refer to, per eye, see ReadFov
	pvrFovPort fov[2] = {};
	// the fov PVR reported when fov was derived, to notice a changed headset or projection mode
	pvrFovPort reportedFov[2] = {};
	bool haveFov = false;
	// PVR's parallel projection mode: the frustum and the map are for eyes looking straight ahead, cant included
	bool parallelFrame = false;

	// make sure fov is known, returns false when PVR is not available
	bool EnsureFov();
	// derive the frustums from PVR
	bool ReadFov();
};
#endif
