/**
 * Port of the curve math in RadialBezierDistortionProfile.cpp (SmoothPoints2, PolyBezierPathUtil,
 * SampleFromPoints), so the GUI can draw exactly the curves the driver builds from a profile's
 * knots. Points are [degree, value] pairs; for the main distortion the value is the position on
 * the panel in percent, for the red and blue curves it is the percent offset applied to it.
 */

export type CurvePoint = { x: number; y: number };

/** the driver inserts this many smoothed points between each pair of knots */
const IN_BETWEEN_POINTS = 20;

/** flat [d0, v0, d1, v1, ...] knot array from a profile to points */
export function knotsFromFlat(flat: number[] | undefined): CurvePoint[] {
  const points: CurvePoint[] = [];
  if (!flat) {
    return points;
  }
  for (let i = 0; i + 1 < flat.length; i += 2) {
    points.push({ x: flat[i], y: flat[i + 1] });
  }
  return points;
}

function bezierPoint(t: number, p0: CurvePoint, p1: CurvePoint, p2: CurvePoint, p3: CurvePoint): CurvePoint {
  const mt = 1 - t;
  const a = mt * mt * mt;
  const b = 3 * mt * mt * t;
  const c = 3 * mt * t * t;
  const d = t * t * t;
  return { x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y };
}

/** PolyBezierPathUtil::computeControlPoints, twice differentiable poly bezier through the knots */
function computeControlPoints(knots: CurvePoint[]): CurvePoint[] {
  const n = knots.length - 1;
  if (n < 2) {
    return [];
  }
  const target: CurvePoint[] = new Array(n);
  target[0] = { x: knots[0].x + 2 * knots[1].x, y: knots[0].y + 2 * knots[1].y };
  for (let i = 1; i < n - 1; i++) {
    target[i] = { x: 2 * (2 * knots[i].x + knots[i + 1].x), y: 2 * (2 * knots[i].y + knots[i + 1].y) };
  }
  target[n - 1] = { x: 8 * knots[n - 1].x + knots[n].x, y: 8 * knots[n - 1].y + knots[n].y };

  const lower = new Array<number>(n - 1).fill(1);
  lower[n - 2] = 2;
  const main = new Array<number>(n).fill(4);
  main[0] = 2;
  main[n - 1] = 7;
  const upper = new Array<number>(n - 1).fill(1);

  const newUpper = new Array<number>(n - 1).fill(0);
  const newTarget: CurvePoint[] = new Array(n);
  newUpper[0] = upper[0] / main[0];
  newTarget[0] = { x: target[0].x / main[0], y: target[0].y / main[0] };
  for (let i = 1; i < n - 1; i++) {
    newUpper[i] = upper[i] / (main[i] - lower[i - 1] * newUpper[i - 1]);
  }
  for (let i = 1; i < n; i++) {
    const scale = 1 / (main[i] - lower[i - 1] * newUpper[i - 1]);
    newTarget[i] = {
      x: (target[i].x - newTarget[i - 1].x * lower[i - 1]) * scale,
      y: (target[i].y - newTarget[i - 1].y * lower[i - 1]) * scale,
    };
  }
  const result: CurvePoint[] = new Array(2 * n);
  result[n - 1] = newTarget[n - 1];
  for (let i = n - 2; i >= 0; i--) {
    result[i] = { x: newTarget[i].x - result[i + 1].x * newUpper[i], y: newTarget[i].y - result[i + 1].y * newUpper[i] };
  }
  for (let i = 0; i < n - 1; i++) {
    result[n + i] = { x: 2 * knots[i + 1].x - result[i + 1].x, y: 2 * knots[i + 1].y - result[i + 1].y };
  }
  result[2 * n - 1] = { x: 0.5 * knots[n].x + 0.5 * result[n - 1].x, y: 0.5 * knots[n].y + 0.5 * result[n - 1].y };
  return result;
}

/** SmoothPoints2: the dense piecewise linear curve the driver samples from */
export function smoothPoints(knots: CurvePoint[]): CurvePoint[] {
  if (knots.length === 0) {
    return [{ x: 0, y: 0 }, { x: 0, y: 0 }];
  }
  if (knots.length === 1) {
    return new Array(IN_BETWEEN_POINTS + 1).fill(knots[0]);
  }
  if (knots.length === 2) {
    const out: CurvePoint[] = [];
    for (let i = 0; i <= IN_BETWEEN_POINTS; i++) {
      const t = i / IN_BETWEEN_POINTS;
      out.push({ x: knots[0].x + t * (knots[1].x - knots[0].x), y: knots[0].y + t * (knots[1].y - knots[0].y) });
    }
    return out;
  }
  const control = computeControlPoints(knots);
  const half = control.length / 2;
  const out: CurvePoint[] = [];
  for (let i = 0; i < knots.length - 1; i++) {
    out.push(knots[i]);
    for (let j = 0; j < IN_BETWEEN_POINTS; j++) {
      const t = (j + 1) / (IN_BETWEEN_POINTS + 1);
      out.push(bezierPoint(t, knots[i], control[i], control[i + half], knots[i + 1]));
    }
  }
  out.push(knots[knots.length - 1]);
  return out;
}

/** SampleFromPoints: linear interpolation, clamped below the first point, extrapolated past the last */
export function sampleCurve(points: CurvePoint[], x: number): number {
  for (let i = 0; i < points.length - 1; i++) {
    if (x >= points[i].x && x <= points[i + 1].x) {
      const t = (x - points[i].x) / (points[i + 1].x - points[i].x);
      return points[i].y + t * (points[i + 1].y - points[i].y);
    }
  }
  if (x < points[0].x) {
    return points[0].y;
  }
  const i = points.length - 2;
  const t = (x - points[i].x) / (points[i + 1].x - points[i].x);
  return points[i].y + t * (points[i + 1].y - points[i].y);
}
