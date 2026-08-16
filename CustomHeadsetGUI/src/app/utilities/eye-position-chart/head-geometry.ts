import { LighthouseFrame, LighthouseGeometryData, LighthouseSensor } from './lighthouse-geometry.service';

export type Vec3 = [number, number, number];

/** an orthonormal basis, the axes of a frame expressed in the coordinates of its parent frame */
export type Basis = { origin: Vec3; x: Vec3; y: Vec3; z: Vec3 };

export type EyePose = {
  /** position of the rendering camera of this eye in the head frame, meters */
  position: Vec3;
  /** unit vector the eye looks along in the head frame, the -Z axis of the eye */
  forward: Vec3;
};

/** everything the chart draws, expressed in the SteamVR head frame: +X right, +Y up, -Z forward, meters */
export type HeadSpaceGeometry = {
  sensors: { position: Vec3; normal: Vec3 | null }[];
  /** the head origin the device came with when it was overridden, in the current head frame */
  originalHeadOrigin: Vec3 | null;
  eyes: { left: EyePose; right: EyePose } | null;
};

function toVec3(value: number[] | undefined | null): Vec3 | null {
  if (!value || value.length !== 3 || value.some(v => typeof v !== 'number' || !isFinite(v))) {
    return null;
  }
  return [value[0], value[1], value[2]];
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function scale(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function length(a: Vec3): number {
  return Math.sqrt(dot(a, a));
}

export function normalize(a: Vec3): Vec3 | null {
  const l = length(a);
  return l > 1e-9 ? scale(a, 1 / l) : null;
}

/**
 * Build the basis of a frame from a lighthouse config block. plus_x and plus_z are the frame's
 * axes in the object coordinate system, y follows from the right handed rule and x is
 * re-derived so the basis is orthonormal even if the config values are slightly off.
 * Falls back to the identity orientation at the given position when the axes are unusable.
 */
export function frameBasis(frame: LighthouseFrame | null | undefined): Basis | null {
  if (!frame) {
    return null;
  }
  const origin = toVec3(frame.position) ?? [0, 0, 0];
  const plusX = normalize(toVec3(frame.plusX) ?? [1, 0, 0]);
  const plusZ = normalize(toVec3(frame.plusZ) ?? [0, 0, 1]);
  if (!plusX || !plusZ) {
    return { origin, x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
  }
  const y = normalize(cross(plusZ, plusX));
  if (!y) {
    return { origin, x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
  }
  const x = cross(y, plusZ);
  return { origin, x, y, z: plusZ };
}

/** express a point given in the parent frame in the coordinates of the basis' frame */
export function pointToFrame(point: Vec3, basis: Basis): Vec3 {
  const d = sub(point, basis.origin);
  return [dot(d, basis.x), dot(d, basis.y), dot(d, basis.z)];
}

/** express a direction given in the parent frame in the coordinates of the basis' frame */
export function directionToFrame(direction: Vec3, basis: Basis): Vec3 {
  return [dot(direction, basis.x), dot(direction, basis.y), dot(direction, basis.z)];
}

/** the eye pose held in a row major 3x4 eye to head matrix, null when it is malformed */
export function eyePoseFromMatrix(matrix: number[][] | undefined): EyePose | null {
  if (!matrix || matrix.length !== 3) {
    return null;
  }
  for (const row of matrix) {
    if (!row || row.length !== 4 || row.some(v => typeof v !== 'number' || !isFinite(v))) {
      return null;
    }
  }
  const forward = normalize([-matrix[0][2], -matrix[1][2], -matrix[2][2]]);
  if (!forward) {
    return null;
  }
  return {
    position: [matrix[0][3], matrix[1][3], matrix[2][3]],
    forward,
  };
}

/**
 * The eye poses the driver builds from its settings when no recorded transform is available,
 * this mirrors BaseHeadsetShim::SetIPD: the eyes sit on the head origin, ipd apart, shifted
 * sideways by the horizontal offset, towards the back by the viewpoint depth correction, and
 * each yawed outwards by the eye rotation.
 */
export function eyePosesFromSettings(ipdMeters: number, eyeRotationDegrees: number, horizontalOffsetMeters: number, depthOffsetMeters: number): { left: EyePose; right: EyePose } {
  const angle = eyeRotationDegrees * Math.PI / 180;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return {
    left: { position: [-ipdMeters / 2 + horizontalOffsetMeters, 0, depthOffsetMeters], forward: [-s, 0, -c] },
    right: { position: [ipdMeters / 2 + horizontalOffsetMeters, 0, depthOffsetMeters], forward: [s, 0, -c] },
  };
}

/** transform the geometry of the config into the head frame the pose is reported in */
export function toHeadSpace(data: LighthouseGeometryData, eyes: { left: EyePose; right: EyePose } | null): HeadSpaceGeometry | null {
  const head = frameBasis(data.head) ?? { origin: [0, 0, 0] as Vec3, x: [1, 0, 0] as Vec3, y: [0, 1, 0] as Vec3, z: [0, 0, 1] as Vec3 };
  const sensors: { position: Vec3; normal: Vec3 | null }[] = [];
  for (const sensor of (data.sensors ?? []) as LighthouseSensor[]) {
    const position = toVec3(sensor.position);
    if (!position) {
      continue;
    }
    const normal = toVec3(sensor.normal);
    sensors.push({
      position: pointToFrame(position, head),
      normal: normal ? normalize(directionToFrame(normal, head)) : null,
    });
  }
  if (!sensors.length && !data.head) {
    return null;
  }
  const originalHead = data.headOverridden ? frameBasis(data.originalHead) : null;
  return {
    sensors,
    originalHeadOrigin: originalHead ? pointToFrame(originalHead.origin, head) : null,
    eyes,
  };
}

/** angle in degrees between the two eye forward directions divided by two, the outward cant of each eye */
export function eyeCantDegrees(eyes: { left: EyePose; right: EyePose }): number {
  const cosine = Math.max(-1, Math.min(1, dot(eyes.left.forward, eyes.right.forward)));
  return Math.acos(cosine) * 180 / Math.PI / 2;
}
