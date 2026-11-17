#pragma once
#include <algorithm>
#include <cmath>

namespace ProjectionGeometry {
	struct Projection {
		double left, right, bottom, top;
	};

	struct Fov {
		double horizontal = 0;
		double vertical = 0;
		double overlap = 0;
	};

	// Horizontal angular bounds in the head frame, including outward eye rotation.
	// Either eye can supply either outer edge when the projections are asymmetric.
	inline Fov CalculateFov(const Projection& left, const Projection& right, double rotationDegrees, int disabledEyes = 0) {
		constexpr double degrees = 180.0 / 3.14159265358979323846;
		bool hasLeft = !(disabledEyes & 1) && left.left < left.right && left.bottom < left.top;
		bool hasRight = !(disabledEyes & 2) && right.left < right.right && right.bottom < right.top;
		if(!hasLeft && !hasRight) return {};
		double leftMin = std::atan(left.left) * degrees - rotationDegrees;
		double leftMax = std::atan(left.right) * degrees - rotationDegrees;
		double rightMin = std::atan(right.left) * degrees + rotationDegrees;
		double rightMax = std::atan(right.right) * degrees + rotationDegrees;
		if(!hasRight) return {leftMax - leftMin, (std::atan(left.top) - std::atan(left.bottom)) * degrees, 0};
		if(!hasLeft) return {rightMax - rightMin, (std::atan(right.top) - std::atan(right.bottom)) * degrees, 0};
		return {
			std::max(leftMax, rightMax) - std::min(leftMin, rightMin),
			(std::atan(std::max(left.top, right.top)) - std::atan(std::min(left.bottom, right.bottom))) * degrees,
			std::max(0.0, std::min(leftMax, rightMax) - std::max(leftMin, rightMin))
		};
	}
}
