/**
 * The drawing of a panel angle map from a sampling: contours, the edge of the rendered area, the optical
 * axis, the degree labels and the hidden area cut, as SVG paths in seen space. Shared by the panel angle
 * map of a headset tab and the overlay of several profiles on the Charts tab.
 */
import {
  computeAngleField, computeCoverageField, computeHamField, computeValidMask, contourSegments, EyeProjection,
  findCenter, HamRadii, PanelGrid, Point, sampleField, segmentsToSvgPath, SeenSpaceMapping
} from './panel-geometry';

/** the sampling's grid, viewport and optical axes, the meta fields of FovVisualizationData */
export type PanelGridMeta = {
  gridSize: number; displayRotation: number; viewportWidth: number; viewportHeight: number;
  opticalAxisLeft?: number[]; opticalAxisRight?: number[];
};

/** where the lens of one eye is centered, as tangents in the frame of the projection; the frame's forward when not recorded */
export function panelOpticalAxis(meta: PanelGridMeta, isRight: boolean): Point {
  const axis = isRight ? meta.opticalAxisRight : meta.opticalAxisLeft;
  return axis && axis.length === 2 ? { x: axis[0], y: axis[1] } : { x: 0, y: 0 };
}

export type PanelLabel = { x: number; y: number; text: string };

/** contour step in degrees, every second one gets a label */
export const CONTOUR_STEP = 5;

/** the paths drawn for one channel grid of one eye */
export type PanelGridDrawing = {
  /** one path per contour, CONTOUR_STEP degrees apart */
  contours: string[];
  /** the edge of the rendered area */
  boundary: string;
  /** the optical axis of the lens, where the view angle is zero, in seen space with y down like SVG */
  center: { x: number; y: number };
  /** degree labels along the horizontal to the right of the center */
  labels: PanelLabel[];
};

/** the mapping from grid samples to seen space of one eye's panel */
export function panelMapping(meta: PanelGridMeta, isRight: boolean): SeenSpaceMapping {
  return new SeenSpaceMapping(meta.gridSize, meta.displayRotation, isRight, meta.viewportWidth, meta.viewportHeight);
}

/** the SVG viewBox showing the whole panel with a small margin */
export function panelViewBox(mapping: SeenSpaceMapping): string {
  const margin = 0.1;
  const width = (mapping.halfWidth + margin) * 2;
  const height = (mapping.halfHeight + margin) * 2;
  return `${-(mapping.halfWidth + margin)} ${-(mapping.halfHeight + margin)} ${width} ${height}`;
}

/**
 * contours, boundary, center and optionally labels of one grid, e.g. the green channel of one eye. The
 * angles are measured from the optical axis, so maps of the same panel compare whatever frame their
 * projections are in.
 */
export function drawPanelGrid(grid: PanelGrid, projection: EyeProjection, mapping: SeenSpaceMapping, withLabels: boolean, axis: Point = { x: 0, y: 0 }): PanelGridDrawing {
  const size = grid.size;
  const angles = computeAngleField(grid, projection, axis);
  const contours: string[] = [];
  for (let iso = CONTOUR_STEP; iso <= angles.maxValidAngle; iso += CONTOUR_STEP) {
    const segments = contourSegments(angles.angle, size, iso, angles.valid);
    if (segments.length) {
      contours.push(segmentsToSvgPath(segments, mapping));
    }
  }
  const coverage = computeCoverageField(grid);
  const boundary = segmentsToSvgPath(contourSegments(coverage, size, 1.0), mapping);
  const center = findCenter(angles.angle, size);
  const centerSeen = mapping.gridToSeen(center.x, center.y);
  const labels = withLabels ? contourLabels(angles.angle, angles.valid, size, mapping, centerSeen) : [];
  return { contours, boundary, center: { x: centerSeen.x, y: -centerSeen.y }, labels };
}

/**
 * the direction the head looks straight ahead in, as tangents in the projection frame of an eye that is
 * rotated outwards by yawDegrees (the eye rotation setting plus the profile's offset, the rotation the FOV
 * preview turns the eyes by): the eye frame is turned outwards, so straight ahead lies inwards in it
 */
export function forwardLookDirection(isRight: boolean, yawDegrees: number): Point {
  const inwards = Math.tan(yawDegrees * Math.PI / 180);
  return { x: isRight ? -inwards : inwards, y: 0 };
}

/**
 * the spot of the panel that shows a direction of the projection frame, in seen space with y down like SVG,
 * null when the direction is not on the panel. The nearest sample has to be close: the grid is a degree
 * or two apart, anything further means the direction lies outside the sampled area.
 */
export function panelDirectionSpot(grid: PanelGrid, projection: EyeProjection, mapping: SeenSpaceMapping, direction: Point): Point | null {
  const angles = computeAngleField(grid, projection, direction);
  const nearest = findCenter(angles.angle, grid.size);
  const index = Math.round(nearest.y) * grid.size + Math.round(nearest.x);
  if (!angles.valid[index] || angles.angle[index] > 3) {
    return null;
  }
  const seen = mapping.gridToSeen(nearest.x, nearest.y);
  return { x: seen.x, y: -seen.y };
}

/**
 * the hidden area mesh cut, based on the green channel like the compositor's clamping reference.
 * Masked to the rendered area like the angle contours: the corner cut field keeps extending past the
 * rendered area boundary, but there the panel shows no image and the mesh does not exist.
 */
export function panelHamPath(greenGrid: PanelGrid, isRight: boolean, ham: HamRadii, mapping: SeenSpaceMapping): string {
  const field = computeHamField(greenGrid, isRight, ham);
  const hamSegments = contourSegments(field, greenGrid.size, 0, computeValidMask(greenGrid));
  return segmentsToSvgPath(hamSegments, mapping);
}

/** place a degree label where each 10 degree contour crosses the horizontal ray from the center */
function contourLabels(angle: Float64Array, valid: Uint8Array, size: number,
  mapping: SeenSpaceMapping, centerSeen: { x: number; y: number }): PanelLabel[] {
  const labels: PanelLabel[] = [];
  const validField = Float64Array.from(valid);
  const step = 0.01;
  let previousAngle: number | null = null;
  let nextLabel = 10;
  for (let x = centerSeen.x; x <= mapping.halfWidth; x += step) {
    const gridPosition = mapping.seenToGrid(x, centerSeen.y);
    const value = sampleField(angle, size, gridPosition.x, gridPosition.y);
    const validity = sampleField(validField, size, gridPosition.x, gridPosition.y);
    if (value === null || (validity !== null && validity < 0.99)) {
      break;
    }
    if (previousAngle !== null && previousAngle < nextLabel && value >= nextLabel) {
      const t = (nextLabel - previousAngle) / (value - previousAngle);
      labels.push({ x: x - step + t * step, y: -centerSeen.y, text: `${nextLabel}°` });
      nextLabel += 2 * CONTOUR_STEP;
    }
    previousAngle = value;
  }
  return labels;
}
