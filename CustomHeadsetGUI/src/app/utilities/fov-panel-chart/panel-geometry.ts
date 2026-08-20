/**
 * Pure geometry for the panel angle map chart.
 *
 * The driver samples the active distortion profile over a grid covering each eye's
 * viewport and stores the render texture coordinate every panel spot shows. From that
 * this module derives the view angle for every spot, iso angle contours, the rendered
 * area boundary, the optical axis, and the hidden area mesh cut, all in the "as seen"
 * space of the eye (the space the distortion profile itself works in).
 */

/** raw projection half angle tangents, same convention as OpenVR GetProjectionRaw */
export type EyeProjection = { left: number; right: number; bottom: number; top: number };

/** hidden area mesh corner radii in viewport UV units, same as HiddenAreaMeshConfig */
export type HamRadii = {
  radiusTopOuter: number;
  radiusTopInner: number;
  radiusBottomInner: number;
  radiusBottomOuter: number;
};

export type Point = { x: number; y: number };

/** one eye and channel of the driver sampling, x/y are render texture coordinates */
export type PanelGrid = { size: number; x: Float64Array; y: Float64Array };

/** parse one channel's interleaved [x, y, ...] sample array from the driver */
export function parseGrid(samples: number[] | undefined, size: number): PanelGrid | null {
  if (!samples || samples.length !== size * size * 2) {
    return null;
  }
  const x = new Float64Array(size * size);
  const y = new Float64Array(size * size);
  for (let n = 0; n < size * size; n++) {
    x[n] = samples[n * 2];
    y[n] = samples[n * 2 + 1];
  }
  return { size, x, y };
}

/** average multiple grids of the same size point by point */
export function averageGrids(grids: PanelGrid[]): PanelGrid {
  const size = grids[0].size;
  const x = new Float64Array(size * size);
  const y = new Float64Array(size * size);
  for (let n = 0; n < size * size; n++) {
    for (const grid of grids) {
      x[n] += grid.x[n] / grids.length;
      y[n] += grid.y[n] / grids.length;
    }
  }
  return { size, x, y };
}

export type AngleField = {
  /** view angle in degrees away from forward at every grid node */
  angle: Float64Array;
  /** 1 when the node shows part of the rendered image */
  valid: Uint8Array;
  /** largest angle over the valid nodes */
  maxValidAngle: number;
};

/** view angle away from forward for every node, using the projection to convert UV to tangents */
export function computeAngleField(grid: PanelGrid, projection: EyeProjection, axis: Point = { x: 0, y: 0 }): AngleField {
  const count = grid.size * grid.size;
  const angle = new Float64Array(count);
  const valid = new Uint8Array(count);
  let maxValidAngle = 0;
  // the direction the angles are measured from: the optical axis of the lens, given as tangents in the
  // frame of the projection, zero when that frame is centered on it (see FovVisualizationData.opticalAxisLeft)
  const axisLength = Math.hypot(axis.x, axis.y, 1);
  for (let n = 0; n < count; n++) {
    const x = grid.x[n];
    const y = grid.y[n];
    // the samples are render texture coordinates, so y = -1 is the texture top and maps to
    // the top tangent of the frustum. Only visible with vertically asymmetric projections.
    const tangentX = projection.left + (projection.right - projection.left) * (x * 0.5 + 0.5);
    const tangentY = projection.top + (projection.bottom - projection.top) * (y * 0.5 + 0.5);
    const cosine = (tangentX * axis.x + tangentY * axis.y + 1) / (Math.hypot(tangentX, tangentY, 1) * axisLength);
    angle[n] = Math.acos(Math.min(1, Math.max(-1, cosine))) * 180 / Math.PI;
    if (Math.abs(x) <= 1 && Math.abs(y) <= 1) {
      valid[n] = 1;
      maxValidAngle = Math.max(maxValidAngle, angle[n]);
    }
  }
  return { angle, valid, maxValidAngle };
}

/** how far outside the rendered image a node is, the rendered area boundary is the 1.0 contour */
export function computeCoverageField(grid: PanelGrid): Float64Array {
  const count = grid.size * grid.size;
  const coverage = new Float64Array(count);
  for (let n = 0; n < count; n++) {
    coverage[n] = Math.max(Math.abs(grid.x[n]), Math.abs(grid.y[n]));
  }
  return coverage;
}

/**
 * signed distance like field for the hidden area mesh corner cuts, positive inside a cut,
 * mirrors the corner construction in HiddenArea::CreateHiddenAreaMesh
 */
export function computeHamField(grid: PanelGrid, isRight: boolean, ham: HamRadii): Float64Array {
  const clampRadius = (r: number) => Math.min(Math.max(r, 0.001), 0.499);
  const corners = [
    { u: 1, v: 1, radius: clampRadius(isRight ? ham.radiusTopOuter : ham.radiusTopInner) },
    { u: 0, v: 1, radius: clampRadius(isRight ? ham.radiusTopInner : ham.radiusTopOuter) },
    { u: 0, v: 0, radius: clampRadius(isRight ? ham.radiusBottomInner : ham.radiusBottomOuter) },
    { u: 1, v: 0, radius: clampRadius(isRight ? ham.radiusBottomOuter : ham.radiusBottomInner) },
  ].map(corner => ({
    centerU: corner.u + Math.sign(0.5 - corner.u) * corner.radius,
    centerV: corner.v + Math.sign(0.5 - corner.v) * corner.radius,
    directionU: Math.sign(corner.u - 0.5),
    directionV: Math.sign(corner.v - 0.5),
    radius: corner.radius,
  }));
  const count = grid.size * grid.size;
  const field = new Float64Array(count);
  for (let n = 0; n < count; n++) {
    const u = grid.x[n] * 0.5 + 0.5;
    const v = grid.y[n] * 0.5 + 0.5;
    let best = -1;
    for (const corner of corners) {
      const du = (u - corner.centerU) * corner.directionU;
      const dv = (v - corner.centerV) * corner.directionV;
      const outsideArc = Math.hypot(u - corner.centerU, v - corner.centerV) - corner.radius;
      best = Math.max(best, Math.min(du, dv, outsideArc));
    }
    field[n] = best;
  }
  return field;
}

// marching squares edge pairs by case index, edges: 0 bottom, 1 right, 2 top, 3 left
const CONTOUR_EDGES: number[][][] = [
  [], [[3, 0]], [[0, 1]], [[3, 1]],
  [[1, 2]], [[3, 0], [1, 2]], [[0, 2]], [[3, 2]],
  [[2, 3]], [[2, 0]], [[0, 1], [2, 3]], [[2, 1]],
  [[1, 3]], [[1, 0]], [[0, 3]], [],
];

/**
 * marching squares over a scalar field, returns line segments in grid coordinates
 * as [x1, y1, x2, y2, ...]. Cells with a masked corner are skipped when a mask is given.
 */
export function contourSegments(field: Float64Array, size: number, iso: number, mask?: Uint8Array): number[] {
  const segments: number[] = [];
  const edgePoint = (edge: number, i: number, j: number, v0: number, v1: number, v2: number, v3: number): Point => {
    switch (edge) {
      case 0: return { x: i + (iso - v0) / (v1 - v0), y: j };
      case 1: return { x: i + 1, y: j + (iso - v1) / (v2 - v1) };
      case 2: return { x: i + (iso - v3) / (v2 - v3), y: j + 1 };
      default: return { x: i, y: j + (iso - v0) / (v3 - v0) };
    }
  };
  for (let j = 0; j < size - 1; j++) {
    for (let i = 0; i < size - 1; i++) {
      const n0 = j * size + i;
      const n1 = n0 + 1;
      const n2 = n1 + size;
      const n3 = n0 + size;
      if (mask && !(mask[n0] && mask[n1] && mask[n2] && mask[n3])) {
        continue;
      }
      const v0 = field[n0];
      const v1 = field[n1];
      const v2 = field[n2];
      const v3 = field[n3];
      const caseIndex = (v0 >= iso ? 1 : 0) | (v1 >= iso ? 2 : 0) | (v2 >= iso ? 4 : 0) | (v3 >= iso ? 8 : 0);
      for (const [edgeA, edgeB] of CONTOUR_EDGES[caseIndex]) {
        const a = edgePoint(edgeA, i, j, v0, v1, v2, v3);
        const b = edgePoint(edgeB, i, j, v0, v1, v2, v3);
        segments.push(a.x, a.y, b.x, b.y);
      }
    }
  }
  return segments;
}

/**
 * Grid position of the smallest value of a field shaped like a cone around its minimum, like the view
 * angle away from an axis. The value grows nearly linearly away from the minimum, so a parabola through
 * the nodes around the kink would place the minimum too close to its node; instead each axis takes the
 * midpoint of two crossings of an iso value, which the cone's symmetry puts at the true minimum, on
 * slopes straight enough for linear interpolation.
 */
export function findCenter(field: Float64Array, size: number): Point {
  let bestIndex = 0;
  for (let n = 1; n < size * size; n++) {
    if (field[n] < field[bestIndex]) {
      bestIndex = n;
    }
  }
  const i = bestIndex % size;
  const j = Math.floor(bestIndex / size);
  return {
    x: i + refineConeMinimum(t => field[j * size + t], i, size - 1),
    y: j + refineConeMinimum(t => field[t * size + i], j, size - 1),
  };
}

/**
 * Sub node offset of the minimum of a cone shaped 1d slice from the minimum node: the midpoint of the
 * first crossings of an iso value walking out both ways. Near the grid edge, where a crossing may not
 * exist, the intersection of the slopes on both sides of the node serves as fallback.
 */
function refineConeMinimum(valueAt: (node: number) => number, node: number, lastNode: number): number {
  const value = valueAt(node);
  // how much the field rises to the next node, the slope of the cone
  const rise = Math.max(
    node > 0 ? valueAt(node - 1) - value : 0,
    node < lastNode ? valueAt(node + 1) - value : 0);
  if (rise <= 0) {
    return 0;
  }
  // crossings a few nodes out: far enough from the kink at the minimum for linear interpolation,
  // close enough to it that the two slopes still mirror each other
  const iso = value + rise * 2.5;
  const crossing = (direction: number): number | null => {
    for (let t = node; t + direction >= 0 && t + direction <= lastNode; t += direction) {
      const inner = valueAt(t);
      const outer = valueAt(t + direction);
      if (outer >= iso) {
        return t + direction * (iso - inner) / (outer - inner);
      }
    }
    return null;
  };
  const before = crossing(-1);
  const after = crossing(1);
  if (before !== null && after !== null) {
    return (before + after) / 2 - node;
  }
  if (node <= 0 || node >= lastNode) {
    return 0;
  }
  // both nodes of the higher side lie on one straight slope, so the rise is the slope of both sides
  return Math.min(Math.max((valueAt(node - 1) - valueAt(node + 1)) / (2 * rise), -0.5), 0.5);
}

/**
 * Mapping between grid coordinates and the "as seen" space of an eye. Grid coordinates
 * cover the viewport in panel orientation, the seen space is the upright space the
 * distortion works in, normalized so the smaller panel dimension spans -1 to 1.
 * This mirrors the transformUV logic in BaseHeadsetShim (without distortion zoom,
 * the chart shows where things land on the physical panel).
 */
export class SeenSpaceMapping {
  private panelResolutionX: number;
  private panelResolutionY: number;
  private minResolution: number;
  /** half extents of the viewport rectangle in seen space */
  halfWidth: number;
  halfHeight: number;

  constructor(private gridSize: number, private displayRotation: number, private isRight: boolean,
    viewportWidth: number, viewportHeight: number) {
    const rotated = displayRotation === 1 || displayRotation === 3;
    this.panelResolutionX = rotated ? viewportHeight : viewportWidth;
    this.panelResolutionY = rotated ? viewportWidth : viewportHeight;
    this.minResolution = Math.min(viewportWidth, viewportHeight);
    const corner = this.gridToSeen(gridSize - 1, gridSize - 1);
    this.halfWidth = Math.abs(corner.x);
    this.halfHeight = Math.abs(corner.y);
  }

  /** grid coordinates (fractional node index) to seen space, y up */
  gridToSeen(gridX: number, gridY: number): Point {
    let x = (gridX / (this.gridSize - 1) - 0.5) * 2;
    let y = (gridY / (this.gridSize - 1) - 0.5) * 2;
    if (this.displayRotation === 1 || this.displayRotation === 3) {
      const tmp = x;
      if (!this.isRight) {
        x = -y;
        y = tmp;
      } else {
        x = y;
        y = -tmp;
      }
    }
    if (this.displayRotation === 2 || this.displayRotation === 3) {
      x *= -1;
      y *= -1;
    }
    // like transformUV the aspect scaling comes after the rotation, on the panel-native axes
    x *= this.panelResolutionX / this.minResolution;
    y *= this.panelResolutionY / this.minResolution;
    // the profile space follows the render texture axes where y points down as seen,
    // flip it so seen space is y up
    return { x, y: -y };
  }

  /** seen space back to grid coordinates, inverse of gridToSeen */
  seenToGrid(seenX: number, seenY: number): Point {
    let x = seenX * this.minResolution / this.panelResolutionX;
    let y = -seenY * this.minResolution / this.panelResolutionY;
    if (this.displayRotation === 2 || this.displayRotation === 3) {
      x *= -1;
      y *= -1;
    }
    if (this.displayRotation === 1 || this.displayRotation === 3) {
      const tmp = y;
      if (!this.isRight) {
        y = -x;
        x = tmp;
      } else {
        y = x;
        x = -tmp;
      }
    }
    return {
      x: (x * 0.5 + 0.5) * (this.gridSize - 1),
      y: (y * 0.5 + 0.5) * (this.gridSize - 1),
    };
  }
}

/** bilinear sample of a grid field at fractional grid coordinates, null outside */
export function sampleField(field: Float64Array, size: number, gridX: number, gridY: number): number | null {
  if (gridX < 0 || gridY < 0 || gridX > size - 1 || gridY > size - 1) {
    return null;
  }
  const i = Math.min(Math.floor(gridX), size - 2);
  const j = Math.min(Math.floor(gridY), size - 2);
  const fx = gridX - i;
  const fy = gridY - j;
  const v00 = field[j * size + i];
  const v10 = field[j * size + i + 1];
  const v01 = field[(j + 1) * size + i];
  const v11 = field[(j + 1) * size + i + 1];
  return v00 * (1 - fx) * (1 - fy) + v10 * fx * (1 - fy) + v01 * (1 - fx) * fy + v11 * fx * fy;
}

/** convert marching squares segments in grid coordinates to an SVG path in seen space (SVG y down) */
export function segmentsToSvgPath(segments: number[], mapping: SeenSpaceMapping): string {
  const parts: string[] = [];
  for (let s = 0; s < segments.length; s += 4) {
    const a = mapping.gridToSeen(segments[s], segments[s + 1]);
    const b = mapping.gridToSeen(segments[s + 2], segments[s + 3]);
    parts.push(`M${a.x.toFixed(4)} ${(-a.y).toFixed(4)}L${b.x.toFixed(4)} ${(-b.y).toFixed(4)}`);
  }
  return parts.join('');
}
