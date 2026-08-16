#include "../Helpers/PvrAvailability.h"
#ifdef PVR_EXISTS

#include "PimaxDistortionProfile.h"
#include <algorithm>
#include <cmath>

#define NOMINMAX
#include "../Helpers/PimaxCommon.h"
#include "../Driver/DriverLog.h"

// The texture coordinates pvr_getHmdDistortedUV returns refer to the true, vertically asymmetric frustum of the
// eye, but pvr_getEyeRenderInfo reports the vertical fov symmetrized (up and down both set to the larger of the
// two). Measured on the Crystal Super 50PPD: the map puts the panel bottom at the reported down tangent exactly,
// while its top ends at 51.1 degrees where 58.7 are reported. Rendering with the reported fov would show the
// world shifted down by 12 degrees and stretched. The true split is recovered from where the optical axis
// (view direction straight ahead, texture tangent zero) lands in the texture: at the axis
// v0 = up / (up + down), so with the larger side known the smaller one follows. The horizontal fov is reported
// asymmetric where the optics are (Dream Air, micro-OLED) and matches the map, it is used as is.

// green channel texture uv for a display position in [0, 1]^2, false when PVR did not answer
static bool DistortedUv(pvrSessionHandle session, pvrEyeType eye, float x, float y, pvrVector2f& out){
	pvrVector2f uv[3];
	if(pvr_getHmdDistortedUV(session, eye, {x, y}, uv) != pvr_success){
		return false;
	}
	out = uv[1];
	return true;
}

// sum over rings around (cx, cy) of |uv(c + d) + uv(c - d) - 2 uv(c)|^2: the lens map is odd around its
// optical axis, so this is zero exactly there and grows with the distance from it
static double Asymmetry(pvrSessionHandle session, pvrEyeType eye, float cx, float cy, bool& ok){
	pvrVector2f c;
	ok = ok && DistortedUv(session, eye, cx, cy, c);
	const float radii[] = {0.04f, 0.08f};
	const int directions = 12;
	double sum = 0;
	for(float radius : radii){
		for(int i = 0; i < directions; i++){
			float angle = (float)(2.0 * 3.14159265358979 * i / directions);
			float dx = radius * std::cos(angle), dy = radius * std::sin(angle);
			pvrVector2f p, q;
			ok = ok && DistortedUv(session, eye, cx + dx, cy + dy, p) && DistortedUv(session, eye, cx - dx, cy - dy, q);
			if(!ok){
				return 0;
			}
			double ex = (double)p.x + q.x - 2.0 * c.x;
			double ey = (double)p.y + q.y - 2.0 * c.y;
			sum += ex * ex + ey * ey;
		}
	}
	return sum;
}

// golden section minimum of the asymmetry along one axis, the other coordinate fixed
static float GoldenSection(pvrSessionHandle session, pvrEyeType eye, bool alongX, float other, float lo, float hi, float tolerance, bool& ok){
	auto f = [&](float t){ return alongX ? Asymmetry(session, eye, t, other, ok) : Asymmetry(session, eye, other, t, ok); };
	const float g = 0.6180339887f;
	float a = lo, b = hi;
	float c = b - g * (b - a), d = a + g * (b - a);
	double fc = f(c), fd = f(d);
	while(b - a > tolerance && ok){
		if(fc < fd){
			b = d; d = c; fd = fc;
			c = b - g * (b - a); fc = f(c);
		}else{
			a = c; c = d; fc = fd;
			d = a + g * (b - a); fd = f(d);
		}
	}
	return (a + b) / 2;
}

// the display position of the optical axis in the input space of pvr_getHmdDistortedUV
static bool FindOpticalAxis(pvrSessionHandle session, pvrEyeType eye, float& cx, float& cy){
	bool ok = true;
	cx = 0.5f;
	cy = 0.5f;
	for(int round = 0; round < 3 && ok; round++){
		cx = GoldenSection(session, eye, true, cy, 0.15f, 0.85f, 1e-5f, ok);
		cy = GoldenSection(session, eye, false, cx, 0.15f, 0.85f, 1e-5f, ok);
	}
	return ok;
}

bool PimaxDistortionProfile::ReadFov(){
	pvrSessionHandle session = PimaxCommon::GetPvrSession();
	pvrFovPort derived[2] = {};
	pvrFovPort reported[2] = {};
	for(int e = 0; e < 2; e++){
		pvrEyeType eye = (pvrEyeType)e;
		pvrEyeRenderInfo info = {};
		if(pvr_getEyeRenderInfo(session, eye, &info) != pvr_success){
			return false;
		}
		reported[e] = info.Fov;
		derived[e] = info.Fov;
		float axisX, axisY;
		pvrVector2f atAxis;
		if(!FindOpticalAxis(session, eye, axisX, axisY) || !DistortedUv(session, eye, axisX, axisY, atAxis)){
			return false;
		}
		// texture v runs from the top (v = 0, tangent up) to the bottom (v = 1, tangent -down), the axis is where
		// the tangent is zero: v0 = up / (up + down). PVR reports the larger of up and down for both.
		float larger = std::max(info.Fov.UpTan, info.Fov.DownTan);
		float v0 = std::min(std::max(atAxis.y, 0.05f), 0.95f);
		if(v0 <= 0.5f){
			derived[e].DownTan = larger;
			derived[e].UpTan = larger * v0 / (1.f - v0);
		}else{
			derived[e].UpTan = larger;
			derived[e].DownTan = larger * (1.f - v0) / v0;
		}
		DriverLog("Pimax PVR distortion eye %d: optical axis at display (%.4f, %.4f), texture (%.4f, %.4f); fov reported up %.4f down %.4f left %.4f right %.4f, derived up %.4f down %.4f",
			e, axisX, axisY, atAxis.x, atAxis.y, info.Fov.UpTan, info.Fov.DownTan, info.Fov.LeftTan, info.Fov.RightTan, derived[e].UpTan, derived[e].DownTan);
	}
	for(int e = 0; e < 2; e++){
		fov[e] = derived[e];
		reportedFov[e] = reported[e];
	}
	haveFov = true;
	return true;
}

bool PimaxDistortionProfile::EnsureFov(){
	pvrSessionHandle session = PimaxCommon::GetPvrSession();
	// redo the derivation when PVR reports a different fov than last time, for a changed projection mode or headset
	if(haveFov){
		for(int e = 0; e < 2; e++){
			pvrEyeRenderInfo info = {};
			if(pvr_getEyeRenderInfo(session, (pvrEyeType)e, &info) == pvr_success
				&& (info.Fov.UpTan != reportedFov[e].UpTan || info.Fov.DownTan != reportedFov[e].DownTan
					|| info.Fov.LeftTan != reportedFov[e].LeftTan || info.Fov.RightTan != reportedFov[e].RightTan)){
				haveFov = false;
			}
		}
	}
	if(!haveFov){
		ReadFov();
	}
	// In PVR's parallel projection mode (view_rotation_fix) the frustum and the map are for eyes looking straight
	// ahead, the cant of the panels is inside them, so the eyes must not be rotated outwards on top of that.
	// BaseHeadset rotates them by eyeRotation + eyeRotationOffset for the eye to head transforms, the combined
	// fov and the GUI charts alike, so the profile cancels the configured rotation here. In the canted mode the
	// configured rotation is the cant itself and stays.
	parallelFrame = pvr_getIntConfig(session, "view_rotation_fix", 0) != 0;
	eyeRotationOffset = parallelFrame ? -(float)PimaxCommon::GetHeadsetConfig().eyeRotation : 0.f;
	return haveFov;
}

Point2D PimaxDistortionProfile::GetOpticalAxis(vr::EVREye eEye){
	if(!parallelFrame){
		return {0.f, 0.f};
	}
	// straight ahead frame: the lens axis points outwards by the cant PVR reports for the eyes
	float cant = std::tan(PimaxCommon::GetInfo().cantingAngle * 3.14159265f / 180.f);
	return {eEye == vr::Eye_Left ? -cant : cant, 0.f};
}

void PimaxDistortionProfile::Initialize(){
	// the settings copied into the profile do not change PVR's map, so the derivation is only redone when
	// PVR reports something new; it takes a moment (a few thousand PVR calls per eye)
	if(!EnsureFov()){
		DriverLog("Pimax PVR distortion: could not derive the frustum from PVR, using the reported fov until it answers");
	}
}

void PimaxDistortionProfile::GetProjectionRaw(vr::EVREye eEye, float* pfLeft, float* pfRight, float* pfBottom, float* pfTop) {
	int e = eEye == vr::Eye_Left ? 0 : 1;
	pvrFovPort port;
	if(EnsureFov()){
		port = fov[e];
	}else{
		pvrEyeRenderInfo eyeInfo = {};
		pvr_getEyeRenderInfo(PimaxCommon::GetPvrSession(), (pvrEyeType)e, &eyeInfo);
		port = eyeInfo.Fov;
	}
	// the profile convention: tangents of the half angles, bottom negative, top positive
	*pfLeft = -port.LeftTan;
	*pfRight = port.RightTan;
	*pfBottom = -port.DownTan;
	*pfTop = port.UpTan;
}

Point2D PimaxDistortionProfile::ComputeDistortion(vr::EVREye eEye, ColorChannel colorChannel, float fU, float fV) {
    pvrVector2f outUV[3];

    Config::BaseHeadsetConfig& headsetConfig = PimaxCommon::GetHeadsetConfigDefault();
    // Counteract the display rotation and scaling applied in BaseHeadset::transformUV.
    // Inverse operations applied in reverse order of the forward transform.
    // Un-scale non-square resolution
    const float minResolution = (float)std::min(resolutionX, resolutionY);
    float displayRotation = (float)headsetConfig.displayRotation;
    fU *= minResolution / resolutionX;
    fV *= minResolution / resolutionY;
    // Counteract negation for 180 and 270 rotation
    if(displayRotation == 2 || displayRotation == 3){
        fU *= -1;
        fV *= -1;
    }
    // Counteract swap for 90 and 270 rotation
    if(displayRotation == 1 || displayRotation == 3){
        float tmp = fU;
        if(eEye == vr::Eye_Left){
            fU = fV;
            fV = -tmp;
        }else{
            fU = -fV;
            fV = tmp;
        }
    }
    // Convert from [-1,1] back to [0,1] and adjust for resolution aspect
    fU = fU / 2.0f + 0.5f;
    fV = fV / 2.0f + 0.5f;

    pvr_getHmdDistortedUV(PimaxCommon::GetPvrSession(), (pvrEyeType)eEye, { fU, fV }, outUV);

    float fX = (outUV[colorChannel].x - 0.5f) * 2.f;
    float fY = (outUV[colorChannel].y - 0.5f) * 2.f;

    return { fX, fY };
}

void PimaxDistortionProfile::GetRecommendedRenderTargetSize(uint32_t* pnWidth, uint32_t* pnHeight) {
	pvrFovPort port;
	if(EnsureFov()){
		port = fov[0];
	}else{
		pvrEyeRenderInfo eyeInfo = {};
		pvr_getEyeRenderInfo(PimaxCommon::GetPvrSession(), pvrEye_Left, &eyeInfo);
		port = eyeInfo.Fov;
	}
	pvrSizei viewportSize = {};
	pvr_getFovTextureSize(PimaxCommon::GetPvrSession(), pvrEye_Left, port, 1.f, &viewportSize);

	*pnWidth = (uint32_t)viewportSize.w;
	*pnWidth = (*pnWidth + 3) / 4 * 4;
	*pnHeight = (uint32_t)viewportSize.h;
	*pnHeight = (*pnHeight + 3) / 4 * 4;
}

#endif // PVR_EXISTS
