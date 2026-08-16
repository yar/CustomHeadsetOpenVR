/**
 * The axes and scaling of the chromatic aberration line charts, shared by the chart of a headset tab
 * and the overlay of several profiles on the Charts tab.
 */
import { CurvePoint } from './radial-bezier-curves';

/** chart drawing area in svg units, the svg scales to its box */
export const PLOT_W = 300;
export const PLOT_H = 170;
export const MARGIN = { left: 38, right: 10, top: 8, bottom: 22 };

export type CaAxisTick = { y: number; label: string };
export type CaAxisTickX = { x: number; label: string };

/** a step of 1, 2 or 5 times a power of ten close to the rough size */
export function niceStep(rough: number): number {
  const magnitude = Math.pow(10, Math.floor(Math.log10(rough)));
  const normalized = rough / magnitude;
  const nice = normalized < 1.5 ? 1 : normalized < 3.5 ? 2 : normalized < 7.5 ? 5 : 10;
  return nice * magnitude;
}

/** the scales and ticks of a facet whose y range covers the given values and zero, with a little padding */
export function caFacetAxes(values: number[], maxDegree: number, unit: '%' | 'px') {
  let yMin = Math.min(0, ...values);
  let yMax = Math.max(0, ...values);
  if (yMax - yMin < 1e-9) {
    yMin = -1;
    yMax = 1;
  }
  const pad = (yMax - yMin) * 0.08;
  yMin -= pad;
  yMax += pad;
  const xScale = (x: number) => MARGIN.left + x / maxDegree * PLOT_W;
  const yScale = (y: number) => MARGIN.top + (yMax - y) / (yMax - yMin) * PLOT_H;
  const toPath = (points: CurvePoint[]) => points.length
    ? points.map((p, i) => `${i === 0 ? 'M' : 'L'}${xScale(p.x).toFixed(2)} ${yScale(p.y).toFixed(2)}`).join('')
    : '';
  const yStep = niceStep((yMax - yMin) / 4);
  const yTicks: CaAxisTick[] = [];
  for (let v = Math.ceil(yMin / yStep) * yStep; v <= yMax + 1e-9; v += yStep) {
    const label = unit === '%' ? `${v.toFixed(yStep < 0.1 ? 2 : yStep < 1 ? 1 : 0)}%` : `${Math.round(v)}`;
    yTicks.push({ y: yScale(v), label });
  }
  const xStep = maxDegree > 40 ? 10 : 5;
  const xTicks: CaAxisTickX[] = [];
  for (let d = 0; d <= maxDegree + 1e-9; d += xStep) {
    xTicks.push({ x: xScale(d), label: `${d}°` });
  }
  return {
    xScale,
    yScale,
    toPath,
    yTicks,
    xTicks,
    zeroY: yScale(0),
    viewBox: `0 0 ${MARGIN.left + PLOT_W + MARGIN.right} ${MARGIN.top + PLOT_H + MARGIN.bottom}`,
  };
}

/** one curve of a multi profile facet */
export type CaLineSeries = { points: CurvePoint[]; color: string };

export type CaLineFacet = {
  lines: { path: string; color: string }[];
  yTicks: CaAxisTick[];
  xTicks: CaAxisTickX[];
  zeroY: number;
  viewBox: string;
};

/** a facet with the curves of several profiles, all sharing the axes */
export function buildCaLineFacet(series: CaLineSeries[], maxDegree: number, unit: '%' | 'px'): CaLineFacet {
  const axes = caFacetAxes(series.flatMap(s => s.points.map(p => p.y)), maxDegree, unit);
  return {
    lines: series.map(s => ({ path: axes.toPath(s.points), color: s.color })),
    yTicks: axes.yTicks,
    xTicks: axes.xTicks,
    zeroY: axes.zeroY,
    viewBox: axes.viewBox,
  };
}
