#pragma once

// Defines PVR_EXISTS when the Pimax PVR SDK can be used: it is Windows-only and its headers live in
// ThirdParty/pvr. Every file that checks #ifdef PVR_EXISTS must include this header first, otherwise the
// check silently fails and the PVR dependent code is left out of the build.
#if defined(_WIN32) && __has_include("PVR.h")
	#ifndef PVR_EXISTS
		#define PVR_EXISTS
	#endif
#endif
