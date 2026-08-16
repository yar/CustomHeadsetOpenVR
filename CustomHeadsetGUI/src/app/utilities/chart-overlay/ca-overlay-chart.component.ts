import { Component, computed, inject, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DriverSettingService } from '../../services/driver-setting.service';
import { BaseHeadsetConfig } from '../../services/JsonFileDefines';
import { DistortionProfileLookupService } from '../distortion/distortion-profile-lookup.service';
import { settingsFieldByHeadsetType } from '../fov-chart/headset-fields';
import { buildCaLineFacet, CaLineFacet, CaLineSeries, MARGIN, PLOT_H, PLOT_W } from '../fov-ca-chart/ca-chart-model';
import { CurvePoint, knotsFromFlat, sampleCurve, smoothPoints } from '../fov-ca-chart/radial-bezier-curves';
import { OverlayEntry } from './overlay-entry';

type CaOverlayViewModel = {
  red: CaLineFacet;
  blue: CaLineFacet;
  drawn: OverlayEntry[];
  /** entries whose profile has no chromatic aberration curves the GUI can draw */
  missing: OverlayEntry[];
  /** whether any entry is drawn with a correction strength other than 1 */
  scaled: boolean;
};

/**
 * The chromatic aberration curves of several profiles on shared axes: the red offsets from green of
 * every entry in one facet, the blue offsets in another, each with the correction strength of the
 * entry's headset tab applied like the driver applies it.
 */
@Component({
  selector: 'app-ca-overlay-chart',
  imports: [CommonModule],
  templateUrl: './ca-overlay-chart.component.html',
  styleUrl: './ca-overlay-chart.component.scss'
})
export class CaOverlayChartComponent {
  entries = input.required<OverlayEntry[]>();

  private dss = inject(DriverSettingService);
  private lookup = inject(DistortionProfileLookupService);

  chart = computed<CaOverlayViewModel | undefined>(() => {
    const entries = this.entries();
    const settings = this.dss.values();
    const drawn: OverlayEntry[] = [];
    const missing: OverlayEntry[] = [];
    const curves: { entry: OverlayEntry; red: CurvePoint[]; blue: CurvePoint[]; maxDegree: number }[] = [];
    let scaled = false;
    for (const entry of entries) {
      const definition = this.lookup.resolve(entry.profile).definition;
      if (!definition || definition.type !== 'RadialBezier' || !definition.distortions || definition.distortions.length < 4) {
        missing.push(entry);
        continue;
      }
      const green = definition.distortions;
      // the driver defaults to a constant offset when a profile omits a channel, and scales the whole
      // offset from green by the correction strength of the headset settings
      const field = settingsFieldByHeadsetType[entry.headsetType];
      const config = field ? settings?.[field] as BaseHeadsetConfig | undefined : undefined;
      const readScale = (value: number | undefined) => typeof value === 'number' && isFinite(value) ? value : 1;
      const scaleRed = readScale(config?.chromaticAberrationScaleRed);
      const scaleBlue = readScale(config?.chromaticAberrationScaleBlue);
      scaled ||= scaleRed !== 1 || scaleBlue !== 1;
      const redKnots = knotsFromFlat(definition.distortionsRed && definition.distortionsRed.length >= 4 ? definition.distortionsRed : [0, 0.5, 47.5, 0.5]);
      const blueKnots = knotsFromFlat(definition.distortionsBlue && definition.distortionsBlue.length >= 4 ? definition.distortionsBlue : [0, -0.7, 47.5, -0.7]);
      const applyScale = (curve: CurvePoint[], scale: number) => scale === 1 ? curve : curve.map(pt => ({ x: pt.x, y: pt.y * scale }));
      const greenKnots = knotsFromFlat(green);
      curves.push({
        entry,
        red: applyScale(smoothPoints(redKnots), scaleRed),
        blue: applyScale(smoothPoints(blueKnots), scaleBlue),
        maxDegree: greenKnots[greenKnots.length - 1].x,
      });
      drawn.push(entry);
    }
    if (!curves.length) {
      return undefined;
    }
    // one x axis for all, up to the furthest calibrated angle, each curve drawn to its own last knot
    const maxDegree = Math.max(...curves.map(c => c.maxDegree));
    const step = 0.5;
    const sample = (curve: CurvePoint[], toDegree: number) => {
      const points: CurvePoint[] = [];
      for (let d = 0; d <= toDegree + 1e-6; d += step) {
        points.push({ x: d, y: sampleCurve(curve, d) });
      }
      return points;
    };
    const redSeries: CaLineSeries[] = curves.map(c => ({ points: sample(c.red, c.maxDegree), color: c.entry.color }));
    const blueSeries: CaLineSeries[] = curves.map(c => ({ points: sample(c.blue, c.maxDegree), color: c.entry.color }));
    return {
      red: buildCaLineFacet(redSeries, maxDegree, '%'),
      blue: buildCaLineFacet(blueSeries, maxDegree, '%'),
      drawn,
      missing,
      scaled,
    };
  });

  plotTop = MARGIN.top;
  plotBottom = MARGIN.top + PLOT_H;
  plotLeft = MARGIN.left;
  plotRight = MARGIN.left + PLOT_W;
}
