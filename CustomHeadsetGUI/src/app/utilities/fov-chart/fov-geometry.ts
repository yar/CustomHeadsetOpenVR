/**
 * Pure geometry for the WimFOV style FOV preview chart.
 *
 * All shapes are handled in an azimuthal equidistant projection around the head forward axis:
 * a direction is mapped to polar coordinates where the radius is the angle in degrees away from
 * straight forward and the polar angle is the screen direction (0 = right, 90 = up).
 * Areas and overlaps are computed on the sphere the same way WimFOV does it.
 */

/** raw projection half angle tangents, same convention as OpenVR GetProjectionRaw */
export type EyeProjection = {
  left: number;
  right: number;
  bottom: number;
  top: number;
};

/** hidden area mesh corner radii in viewport UV units, same as HiddenAreaMeshConfig */
export type HamRadii = {
  radiusTopOuter: number;
  radiusTopInner: number;
  radiusBottomInner: number;
  radiusBottomOuter: number;
};

export type EyeShapeInput = {
  projection: EyeProjection;
  isRight: boolean;
  /** outward rotation of the eye in degrees (eyeRotation setting + profile eyeRotationOffset) */
  rotationDeg: number;
  /** corner cutting from the hidden area mesh, null when the mesh is disabled */
  ham: HamRadii | null;
};

export type Point = { x: number; y: number };

export type EyeShape = {
  /** closed outline in chart coordinates (degrees, x right, y up) */
  outline: Point[];
  /** extent in degrees away from forward for EXTENT_SAMPLES uniformly spaced directions */
  extents: Float64Array;
};

/** number of uniformly spaced directions used for extents, divisible by SPOKE_COUNT */
export const EXTENT_SAMPLES = 720;
/** number of directions that get angle labels, matching the WimFOV layout */
export const SPOKE_COUNT = 16;

const DEG = Math.PI / 180;
const ARC_SEGMENTS = 14;

/** build the outline of the visible area of one eye in tangent space */
function tangentOutline(projection: EyeProjection, isRight: boolean, ham: HamRadii | null): Point[] {
  const clampRadius = (r: number) => Math.min(Math.max(r, 0.001), 0.499);
  // corner radii by (u, v) corner, mirrored between eyes, matching HiddenArea::CreateHiddenAreaMesh
  const radii = ham ? [
    clampRadius(isRight ? ham.radiusTopOuter : ham.radiusTopInner),       // (1,1) top right
    clampRadius(isRight ? ham.radiusTopInner : ham.radiusTopOuter),       // (0,1) top left
    clampRadius(isRight ? ham.radiusBottomInner : ham.radiusBottomOuter), // (0,0) bottom left
    clampRadius(isRight ? ham.radiusBottomOuter : ham.radiusBottomInner), // (1,0) bottom right
  ] : [0, 0, 0, 0];
  const corners = [
    { u: 1, v: 1 },
    { u: 0, v: 1 },
    { u: 0, v: 0 },
    { u: 1, v: 0 },
  ];
  const uvPoints: Point[] = [];
  let baseAngle = 0;
  for (let c = 0; c < 4; c++) {
    const corner = corners[c];
    const radius = radii[c];
    if (radius <= 0) {
      uvPoints.push({ x: corner.u, y: corner.v });
    } else {
      // quarter circle arc around a center pushed inwards from the corner
      const centerU = corner.u + Math.sign(0.5 - corner.u) * radius;
      const centerV = corner.v + Math.sign(0.5 - corner.v) * radius;
      for (let i = 0; i <= ARC_SEGMENTS; i++) {
        const angle = baseAngle + (Math.PI / 2) * (i / ARC_SEGMENTS);
        uvPoints.push({ x: centerU + radius * Math.cos(angle), y: centerV + radius * Math.sin(angle) });
      }
    }
    baseAngle += Math.PI / 2;
  }
  // subdivide the straight edges, they become curves in the azimuthal projection
  const densified: Point[] = [];
  for (let i = 0; i < uvPoints.length; i++) {
    const a = uvPoints[i];
    const b = uvPoints[(i + 1) % uvPoints.length];
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 0.05));
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      densified.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  // map viewport UV to tangent space
  return densified.map(p => ({
    x: projection.left + (projection.right - projection.left) * p.x,
    y: projection.bottom + (projection.top - projection.bottom) * p.y,
  }));
}

/** convert a tangent space outline to chart coordinates, applying the outward eye rotation */
function projectOutline(tangentPoints: Point[], isRight: boolean, rotationDeg: number): Point[] {
  const rotation = rotationDeg * DEG * (isRight ? 1 : -1);
  const cosR = Math.cos(rotation);
  const sinR = Math.sin(rotation);
  return tangentPoints.map(p => {
    // direction of this tangent point in eye space (x right, y up, z forward)
    const len = Math.sqrt(p.x * p.x + p.y * p.y + 1);
    let x = p.x / len;
    const y = p.y / len;
    let z = 1 / len;
    // rotate outwards around the vertical axis
    const rx = x * cosR + z * sinR;
    const rz = -x * sinR + z * cosR;
    x = rx;
    z = rz;
    // azimuthal equidistant projection
    const r = Math.acos(Math.min(Math.max(z, -1), 1)) / DEG;
    const planar = Math.atan2(y, x);
    return { x: r * Math.cos(planar), y: r * Math.sin(planar) };
  });
}

/**
 * sample the extent of a star shaped outline for uniformly spaced directions
 * by intersecting rays from the origin with the outline segments
 */
function sampleExtents(outline: Point[], samples: number): Float64Array {
  const extents = new Float64Array(samples);
  for (let k = 0; k < samples; k++) {
    const phi = (k / samples) * 2 * Math.PI;
    const dx = Math.cos(phi);
    const dy = Math.sin(phi);
    let best = 0;
    for (let i = 0; i < outline.length; i++) {
      const a = outline[i];
      const b = outline[(i + 1) % outline.length];
      // solve a + t * (b - a) = s * d
      const ex = b.x - a.x;
      const ey = b.y - a.y;
      const denominator = dx * ey - dy * ex;
      if (Math.abs(denominator) < 1e-12) {
        continue;
      }
      const t = (dy * a.x - dx * a.y) / denominator;
      if (t < -1e-9 || t > 1 + 1e-9) {
        continue;
      }
      const s = Math.abs(dx) > Math.abs(dy)
        ? (a.x + t * ex) / dx
        : (a.y + t * ey) / dy;
      if (s > best) {
        best = s;
      }
    }
    extents[k] = best;
  }
  return extents;
}

/** compute the shape of one eye, returns null for degenerate projections (e.g. disabled eyes) */
export function computeEyeShape(input: EyeShapeInput): EyeShape | null {
  const { left, right, bottom, top } = input.projection;
  if (!(right > left) || !(top > bottom) || (right - left) < 1e-5 || (top - bottom) < 1e-5) {
    return null;
  }
  const outline = projectOutline(tangentOutline(input.projection, input.isRight, input.ham), input.isRight, input.rotationDeg);
  return { outline, extents: sampleExtents(outline, EXTENT_SAMPLES) };
}

/** solid angle in steradians of a star shaped region given by its extents in degrees */
export function solidAngle(extents: Float64Array): number {
  let sum = 0;
  for (let i = 0; i < extents.length; i++) {
    sum += 1 - Math.cos(extents[i] * DEG);
  }
  return sum * (2 * Math.PI / extents.length);
}

export type FovMetrics = {
  /**
   * horizontal binocular overlap in degrees: the span along the horizontal line through the center that
   * both eyes see, from the right eye's inner edge to the left eye's inner edge
   */
  stereoOverlapDegrees: number;
  /** percentage of the full sphere covered by the union of both eyes */
  sphereCoveragePercent: number;
  /** per eye extent in degrees at each spoke, NaN when the eye has no shape */
  innerLeft: number[];
  innerRight: number[];
  /** combined extent of both eyes along the full line through each spoke direction */
  outer: number[];
};

export function computeMetrics(left: EyeShape | null, right: EyeShape | null): FovMetrics {
  const samples = EXTENT_SAMPLES;
  const union = new Float64Array(samples);
  const intersection = new Float64Array(samples);
  for (let i = 0; i < samples; i++) {
    const l = left ? left.extents[i] : 0;
    const r = right ? right.extents[i] : 0;
    union[i] = Math.max(l, r);
    intersection[i] = Math.min(left ? l : 0, right ? r : 0);
  }
  const unionSolidAngle = solidAngle(union);
  const step = samples / SPOKE_COUNT;
  const innerLeft: number[] = [];
  const innerRight: number[] = [];
  const outer: number[] = [];
  for (let spoke = 0; spoke < SPOKE_COUNT; spoke++) {
    const index = spoke * step;
    const oppositeIndex = (index + samples / 2) % samples;
    innerLeft.push(left ? left.extents[index] : NaN);
    innerRight.push(right ? right.extents[index] : NaN);
    outer.push(union[index] + union[oppositeIndex]);
  }
  return {
    // the intersection's extent to the right plus to the left, index 0 is straight right, samples / 2 straight left
    stereoOverlapDegrees: intersection[0] + intersection[samples / 2],
    sphereCoveragePercent: unionSolidAngle / (4 * Math.PI) * 100,
    innerLeft,
    innerRight,
    outer,
  };
}

/** convert an outline in chart coordinates to an SVG path (SVG y axis points down) */
export function outlineToSvgPath(outline: Point[]): string {
  if (outline.length === 0) {
    return '';
  }
  const parts = outline.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(2)} ${(-p.y).toFixed(2)}`);
  return parts.join('') + 'Z';
}
