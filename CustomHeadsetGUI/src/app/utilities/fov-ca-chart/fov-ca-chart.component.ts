import { Component, computed, inject, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DriverInfoService } from '../../services/driver-info.service';
import { DriverSettingService } from '../../services/driver-setting.service';
import { BaseHeadsetConfig, HeadsetType } from '../../services/JsonFileDefines';
import { DistortionProfileDisplayNames } from '../../pages/devices/DeviceConfigComponentBase';
import { settingsFieldByHeadsetType } from '../fov-chart/headset-fields';
import { CurvePoint, knotsFromFlat, sampleCurve, smoothPoints } from './radial-bezier-curves';

type Facet = {
  /** svg path of the red curve */
  redPath: string;
  bluePath: string;
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
};

/** chart drawing area in svg units, the svg scales to its box */
const PLOT_W = 300;
const PLOT_H = 170;
const MARGIN = { left: 38, right: 10, top: 8, bottom: 22 };

@Component({
  selector: 'app-fov-ca-chart',
  imports: [CommonModule],
  templateUrl: './fov-ca-chart.component.html',
  styleUrl: './fov-ca-chart.component.scss'
})
export class FovCaChartComponent {
  /** the headset type of the settings page hosting this chart */
  headsetType = input.required<HeadsetType>();

  private dis = inject(DriverInfoService);
  private dss = inject(DriverSettingService);

  /** the profile selected on this page, resolved to its curve definition */
  private profile = computed(() => {
    const settings = this.dss.values();
    const field = settingsFieldByHeadsetType[this.headsetType()];
    const config = field ? settings?.[field] as BaseHeadsetConfig : undefined;
    const name = config?.distortionProfile;
    if (!name || name === 'None') {
      return null;
    }
    const builtIn = this.dis.values()?.builtInDistortionProfiles?.[name];
    if (builtIn) {
      return { name, type: builtIn.type, green: builtIn.distortions, red: builtIn.distortionsRed, blue: builtIn.distortionsBlue, config };
    }
    const file = this.dss.distortionProfileList().find(p => p.name === name + '.json' || p.name === name);
    if (file) {
      return { name, type: file.type, green: file.distortions, red: file.distortionsRed, blue: file.distortionsBlue, config };
    }
    return { name, type: undefined, green: undefined, red: undefined, blue: undefined, config };
  });

  profileName = computed(() => {
    const p = this.profile();
    return p ? (DistortionProfileDisplayNames.get(p.name) ?? p.name) : '';
  });

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
    const red = smoothPoints(redKnots);
    const blue = smoothPoints(blueKnots);
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
    const offsetRed: CurvePoint[] = [];
    const offsetBlue: CurvePoint[] = [];
    const pixelRed: CurvePoint[] = [];
    const pixelBlue: CurvePoint[] = [];
    for (let d = 0; d <= maxDegree + 1e-6; d += step) {
      const g = sampleCurve(green, d);
      const r = sampleCurve(red, d);
      const b = sampleCurve(blue, d);
      offsetRed.push({ x: d, y: r });
      offsetBlue.push({ x: d, y: b });
      // displacement of the channel on the panel relative to green, in pixels
      pixelRed.push({ x: d, y: g * (r / 100) / 100 * halfMin });
      pixelBlue.push({ x: d, y: g * (b / 100) / 100 * halfMin });
    }
    return {
      offset: this.buildFacet(offsetRed, offsetBlue, redKnots, blueKnots, maxDegree, '%'),
      pixels: halfMin > 0 ? this.buildFacet(pixelRed, pixelBlue, [], [], maxDegree, 'px') : this.buildFacet([], [], [], [], maxDegree, 'px'),
      profileName: this.profileName(),
      maxDegree,
      edgeDegree,
    };
  });

  private buildFacet(red: CurvePoint[], blue: CurvePoint[], redNodes: CurvePoint[], blueNodes: CurvePoint[],
    maxDegree: number, unit: string): Facet {
    const all = [...red, ...blue, ...redNodes, ...blueNodes].map(p => p.y);
    let yMin = Math.min(0, ...all);
    let yMax = Math.max(0, ...all);
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
    const yStep = this.niceStep((yMax - yMin) / 4);
    const yTicks: { y: number; label: string }[] = [];
    for (let v = Math.ceil(yMin / yStep) * yStep; v <= yMax + 1e-9; v += yStep) {
      const label = unit === '%' ? `${v.toFixed(yStep < 0.1 ? 2 : yStep < 1 ? 1 : 0)}%` : `${Math.round(v)}`;
      yTicks.push({ y: yScale(v), label });
    }
    const xStep = maxDegree > 40 ? 10 : 5;
    const xTicks: { x: number; label: string }[] = [];
    for (let d = 0; d <= maxDegree + 1e-9; d += xStep) {
      xTicks.push({ x: xScale(d), label: `${d}°` });
    }
    return {
      redPath: toPath(red),
      bluePath: toPath(blue),
      redNodes: redNodes.map(p => ({ x: xScale(p.x), y: yScale(p.y) })),
      blueNodes: blueNodes.map(p => ({ x: xScale(p.x), y: yScale(p.y) })),
      yTicks,
      xTicks,
      zeroY: yScale(0),
      viewBox: `0 0 ${MARGIN.left + PLOT_W + MARGIN.right} ${MARGIN.top + PLOT_H + MARGIN.bottom}`,
    };
  }

  private niceStep(rough: number): number {
    const magnitude = Math.pow(10, Math.floor(Math.log10(rough)));
    const normalized = rough / magnitude;
    const nice = normalized < 1.5 ? 1 : normalized < 3.5 ? 2 : normalized < 7.5 ? 5 : 10;
    return nice * magnitude;
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
