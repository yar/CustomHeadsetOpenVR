import { Component, computed, inject, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DriverSettingService } from '../../services/driver-setting.service';
import { BaseHeadsetConfig, HeadsetType } from '../../services/JsonFileDefines';
import { settingsFieldByHeadsetType } from '../fov-chart/headset-fields';
import { ChartCompareButtonComponent } from '../distortion/chart-compare-button.component';
import { DistortionProfileLookupService } from '../distortion/distortion-profile-lookup.service';
import { CurvePoint, knotsFromFlat, sampleCurve, smoothPoints } from './radial-bezier-curves';
import { caFacetAxes, MARGIN, PLOT_H, PLOT_W } from './ca-chart-model';

type Facet = {
  /** svg path of the red curve as applied, with the chromatic aberration scale */
  redPath: string;
  bluePath: string;
  /** the profile's own curves, drawn beneath the scaled ones when the scale is not 1, empty otherwise */
  redDefaultPath: string;
  blueDefaultPath: string;
  /** knot markers, only on the offset facet where the knots live */
  redNodes: CurvePoint[];
  blueNodes: CurvePoint[];
  yTicks: { y: number; label: string }[];
  xTicks: { x: number; label: string }[];
  /** y coordinate of zero in chart units */
  zeroY: number;
  viewBox: string;
};

type CaChartViewModel = {
  offset: Facet;
  pixels: Facet;
  profileName: string;
  maxDegree: number;
  edgeDegree: number | null;
  /** the chromatic aberration scales the curves are drawn with */
  scaleRed: number;
  scaleBlue: number;
};

@Component({
  selector: 'app-fov-ca-chart',
  imports: [CommonModule, ChartCompareButtonComponent],
  templateUrl: './fov-ca-chart.component.html',
  styleUrl: './fov-ca-chart.component.scss'
})
export class FovCaChartComponent {
  /** the headset type of the settings page hosting this chart */
  headsetType = input.required<HeadsetType>();
  /**
   * the chromatic aberration scale currently set on the page. Passed in as an input because the
   * settings pages mutate the config objects in place, so the settings signal does not change
   * while a slider is dragged and a computed reading it would not update; an input binding is
   * re-evaluated by change detection on every edit.
   */
  scaleRed = input<number | null | undefined>(1);
  scaleBlue = input<number | null | undefined>(1);
  /** the profile name currently selected on the page, an input for the same reason as the scale */
  profileNameInput = input<string | null | undefined>(undefined, { alias: 'profile' });
  /** the button taking this chart to the Charts tab, off where the chart already is one of its tiles */
  showCompare = input(true);

  private dss = inject(DriverSettingService);
  private lookup = inject(DistortionProfileLookupService);

  /** the profile selected on this page, resolved to its curve definition like the driver resolves it */
  private profile = computed(() => {
    const settings = this.dss.values();
    const field = settingsFieldByHeadsetType[this.headsetType()];
    const config = field ? settings?.[field] as BaseHeadsetConfig : undefined;
    const name = this.profileNameInput() ?? config?.distortionProfile;
    if (!name || name === 'None') {
      return null;
    }
    const resolved = this.lookup.resolve(name);
    const definition = resolved.definition;
    return {
      name, displayName: resolved.displayName, type: definition?.type,
      green: definition?.distortions, red: definition?.distortionsRed, blue: definition?.distortionsBlue, config
    };
  });

  profileName = computed(() => this.profile()?.displayName ?? '');
  /** the profile name as selected, for the compare button */
  profileId = computed(() => this.profile()?.name ?? '');

  /** why nothing can be drawn, empty when the chart is available */
  unavailableReason = computed(() => {
    const p = this.profile();
    if (!p) {
      return $localize`No distortion profile is selected.`;
    }
    if (p.type !== undefined && p.type !== 'RadialBezier') {
      return $localize`This profile type does not define chromatic aberration curves.`;
    }
    if (!p.green || p.green.length < 4) {
      return $localize`The curves of this profile are not available to the GUI.`;
    }
    return '';
  });

  chart = computed<CaChartViewModel | null>(() => {
    const p = this.profile();
    if (!p || this.unavailableReason()) {
      return null;
    }
    const greenKnots = knotsFromFlat(p.green);
    // the driver defaults to a constant offset when a profile omits a channel
    const redKnots = knotsFromFlat(p.red && p.red.length >= 4 ? p.red : [0, 0.5, 47.5, 0.5]);
    const blueKnots = knotsFromFlat(p.blue && p.blue.length >= 4 ? p.blue : [0, -0.7, 47.5, -0.7]);
    const green = smoothPoints(greenKnots);
    const redDefault = smoothPoints(redKnots);
    const blueDefault = smoothPoints(blueKnots);
    // the chromatic aberration scales, mirroring RadialBezierDistortionProfile::Initialize: the
    // whole offset from green of each channel is multiplied by its scale
    const readScale = (value: number | null | undefined) => typeof value === 'number' && isFinite(value) ? value : 1;
    const scaleRed = readScale(this.scaleRed());
    const scaleBlue = readScale(this.scaleBlue());
    const scaled = scaleRed !== 1 || scaleBlue !== 1;
    const applyScale = (curve: CurvePoint[], scale: number) => scale === 1 ? curve : curve.map(pt => ({ x: pt.x, y: pt.y * scale }));
    const red = applyScale(redDefault, scaleRed);
    const blue = applyScale(blueDefault, scaleBlue);
    const maxDegree = greenKnots[greenKnots.length - 1].x;
    // where the panel edge falls in degrees: the green curve reaches the half height (100 percent)
    let edgeDegree: number | null = null;
    for (let i = 0; i < green.length - 1; i++) {
      if (green[i].y <= 100 && green[i + 1].y >= 100) {
        edgeDegree = green[i].x + (100 - green[i].y) / (green[i + 1].y - green[i].y) * (green[i + 1].x - green[i].x);
        break;
      }
    }
    const config = p.config;
    // half of the smaller panel dimension in pixels, the unit of the position percent
    const halfMin = Math.min(config?.resolutionX || 0, config?.resolutionY || 0) / 2;

    const step = 0.5;
    const series = { offset: this.emptySeries(), pixels: this.emptySeries() };
    for (let d = 0; d <= maxDegree + 1e-6; d += step) {
      const g = sampleCurve(green, d);
      const r = sampleCurve(red, d);
      const b = sampleCurve(blue, d);
      const r0 = sampleCurve(redDefault, d);
      const b0 = sampleCurve(blueDefault, d);
      series.offset.red.push({ x: d, y: r });
      series.offset.blue.push({ x: d, y: b });
      series.offset.redDefault.push({ x: d, y: r0 });
      series.offset.blueDefault.push({ x: d, y: b0 });
      // displacement of the channel on the panel relative to green, in pixels
      const toPixels = (offset: number) => g * (offset / 100) / 100 * halfMin;
      series.pixels.red.push({ x: d, y: toPixels(r) });
      series.pixels.blue.push({ x: d, y: toPixels(b) });
      series.pixels.redDefault.push({ x: d, y: toPixels(r0) });
      series.pixels.blueDefault.push({ x: d, y: toPixels(b0) });
    }
    // the profile's own knots, scaled the same way, so the nodes sit on the curve that is applied
    return {
      offset: this.buildFacet(series.offset, applyScale(redKnots, scaleRed), applyScale(blueKnots, scaleBlue), maxDegree, '%', scaled),
      pixels: halfMin > 0 ? this.buildFacet(series.pixels, [], [], maxDegree, 'px', scaled) : this.buildFacet(this.emptySeries(), [], [], maxDegree, 'px', false),
      profileName: this.profileName(),
      maxDegree,
      edgeDegree,
      scaleRed,
      scaleBlue,
    };
  });

  private emptySeries() {
    return { red: [] as CurvePoint[], blue: [] as CurvePoint[], redDefault: [] as CurvePoint[], blueDefault: [] as CurvePoint[] };
  }

  private buildFacet(series: { red: CurvePoint[]; blue: CurvePoint[]; redDefault: CurvePoint[]; blueDefault: CurvePoint[] },
    redNodes: CurvePoint[], blueNodes: CurvePoint[], maxDegree: number, unit: '%' | 'px', showDefault: boolean): Facet {
    const { red, blue, redDefault, blueDefault } = series;
    const all = [...red, ...blue, ...redNodes, ...blueNodes, ...(showDefault ? [...redDefault, ...blueDefault] : [])].map(p => p.y);
    const axes = caFacetAxes(all, maxDegree, unit);
    return {
      redPath: axes.toPath(red),
      bluePath: axes.toPath(blue),
      redDefaultPath: showDefault ? axes.toPath(redDefault) : '',
      blueDefaultPath: showDefault ? axes.toPath(blueDefault) : '',
      redNodes: redNodes.map(p => ({ x: axes.xScale(p.x), y: axes.yScale(p.y) })),
      blueNodes: blueNodes.map(p => ({ x: axes.xScale(p.x), y: axes.yScale(p.y) })),
      yTicks: axes.yTicks,
      xTicks: axes.xTicks,
      zeroY: axes.zeroY,
      viewBox: axes.viewBox,
    };
  }

  /** the x position of the panel edge marker in a facet, null when unknown */
  edgeX(vm: CaChartViewModel): number | null {
    return vm.edgeDegree === null ? null : MARGIN.left + vm.edgeDegree / vm.maxDegree * PLOT_W;
  }
  plotTop = MARGIN.top;
  plotBottom = MARGIN.top + PLOT_H;
  plotLeft = MARGIN.left;
  plotRight = MARGIN.left + PLOT_W;
}
