import type { ResolutionInfo } from '../../services/JsonFileDefines';
import type { ProjectionRaw } from './radial-bezier-profile';

/** Angular bounds of the rendered frustums, before hidden-area corner cuts. Mirrors ProjectionGeometry.h. */
export function projectionFov(left: ProjectionRaw, right: ProjectionRaw, rotationDegrees: number, disabledEyes = 0) {
  const degrees = 180 / Math.PI;
  const hasLeft = !(disabledEyes & 1) && left.left < left.right && left.bottom < left.top;
  const hasRight = !(disabledEyes & 2) && right.left < right.right && right.bottom < right.top;
  if (!hasLeft && !hasRight) return { combinedFovX: 0, combinedFovY: 0, overlap: 0 };
  const leftMin = Math.atan(left.left) * degrees - rotationDegrees;
  const leftMax = Math.atan(left.right) * degrees - rotationDegrees;
  const rightMin = Math.atan(right.left) * degrees + rotationDegrees;
  const rightMax = Math.atan(right.right) * degrees + rotationDegrees;
  if (!hasRight) return { combinedFovX: leftMax - leftMin, combinedFovY: (Math.atan(left.top) - Math.atan(left.bottom)) * degrees, overlap: 0 };
  if (!hasLeft) return { combinedFovX: rightMax - rightMin, combinedFovY: (Math.atan(right.top) - Math.atan(right.bottom)) * degrees, overlap: 0 };
  return {
    combinedFovX: Math.max(leftMax, rightMax) - Math.min(leftMin, rightMin),
    combinedFovY: (Math.atan(Math.max(left.top, right.top)) - Math.atan(Math.min(left.bottom, right.bottom))) * degrees,
    overlap: Math.max(0, Math.min(leftMax, rightMax) - Math.max(leftMin, rightMin)),
  };
}

/** Prefer the raw projections, including when reading info.json written by an older driver. */
export function resolutionFov(res: ResolutionInfo, eyeRotation: number, disabledEyes = 0) {
  const rotation = eyeRotation + (res.eyeRotationOffset ?? 0);
  if (res.projectionLeft?.length === 4 && res.projectionRight?.length === 4) {
    const fromArray = (p: number[]): ProjectionRaw => ({ left: p[0], right: p[1], bottom: p[2], top: p[3] });
    return projectionFov(fromArray(res.projectionLeft), fromArray(res.projectionRight), rotation, disabledEyes);
  }
  // Older drivers without raw projections can only provide a symmetric approximation.
  return {
    combinedFovX: disabledEyes === 3 ? 0 : disabledEyes ? res.fovX : res.combinedFovX,
    combinedFovY: disabledEyes === 3 ? 0 : res.combinedFovY,
    overlap: disabledEyes ? 0 : Math.max(0, res.fovX - Math.abs(rotation) * 2),
  };
}
