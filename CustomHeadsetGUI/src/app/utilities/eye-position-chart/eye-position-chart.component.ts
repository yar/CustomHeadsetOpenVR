import { Component, computed, inject, input, OnDestroy, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DriverInfoService } from '../../services/driver-info.service';
import { DriverSettingService } from '../../services/driver-setting.service';
import { BaseHeadsetConfig, HeadsetType } from '../../services/JsonFileDefines';
import { DeviceConfigComponentBase } from '../../pages/devices/DeviceConfigComponentBase';
import { settingsFieldByHeadsetType } from '../fov-chart/headset-fields';
import { LighthouseGeometryService } from './lighthouse-geometry.service';
import {
  add, eyeCantDegrees, eyePoseFromMatrix, eyePosesFromSettings, EyePose, HeadSpaceGeometry, length, scale, sub, toHeadSpace, Vec3
} from './head-geometry';

/** the three orthographic views of the head frame */
export type ViewKind = 'top' | 'side' | 'rear';

type ChartPoint = { x: number; y: number };

type SensorMark = { x: number; y: number; tickX: number; tickY: number; hasTick: boolean };

type EyeMark = {
  cls: 'left' | 'right';
  pupil: ChartPoint;
  ball: ChartPoint;
  ballRadius: number;
  look: ChartPoint | null;
};

type Dimension = { x1: number; y1: number; x2: number; y2: number; labelX: number; labelY: number; text: string; vertical: boolean };

type ViewLabel = { x: number; y: number; text: string; anchor: 'start' | 'middle' | 'end'; cls: string };

export type EyeChartView = {
  kind: ViewKind;
  viewBox: string;
  widthPx: number;
  heightPx: number;
  gridPath: string;
  axisPath: string;
  sensors: SensorMark[];
  origin: ChartPoint;
  originalOrigin: ChartPoint | null;
  eyes: EyeMark[];
  frontPlane: { x1: number; y1: number; x2: number; y2: number } | null;
  depthDimension: Dimension | null;
  labels: ViewLabel[];
};

/** numbers shown under the drawing, all in millimeters or degrees, in the head frame */
export type EyeChartReadout = {
  /** how far the eye cameras sit behind the front-most sensor, positive is behind */
  eyeDepthBehindFrontSensors: number | null;
  /** height of the eye cameras above the center of the sensor ring, negative is below */
  eyeHeightAboveSensorCenter: number | null;
  /** how far the eye cameras sit behind the tracked pose origin, positive is behind */
  eyeDepthBehindOrigin: number | null;
  /** height of the eye cameras above the tracked pose origin */
  eyeHeightAboveOrigin: number | null;
  /** true when the eye cameras sit on the pose origin apart from the ipd */
  eyesOnOrigin: boolean;
  ipd: number | null;
  cant: number | null;
  /** where the device's own head origin was when it is overridden, as right, up, forward of the current one */
  originalOriginRight: number | null;
  originalOriginUp: number | null;
  originalOriginForward: number | null;
  sensorCount: number;
};

export type EyeChartViewModel = {
  views: EyeChartView[];
  readout: EyeChartReadout;
  /** the readout as label and sentence pairs */
  rows: { label: string; value: string }[];
  /** where the eye poses came from */
  eyeSource: 'driver' | 'settings' | 'none';
  headOverridden: boolean;
  modelNumber: string;
};

/** radius of a drawn eyeball in mm, an average human eye */
const EYEBALL_RADIUS = 12;
/** how far the eyeball center sits behind the camera position of the eye in mm */
const EYEBALL_CENTER_BEHIND_PUPIL = 10;
/** length of the drawn viewing direction in mm */
const LOOK_LENGTH = 30;
/** length of the drawn sensor facing direction in mm */
const SENSOR_TICK_LENGTH = 6;
/** grid spacing in mm */
const GRID_STEP = 10;
/** margin around the drawn content in mm */
const MARGIN = 6;
/** height of the tallest view in pixels, the views share one scale */
const TARGET_HEIGHT_PX = 230;

@Component({
  selector: 'app-eye-position-chart',
  imports: [CommonModule],
  templateUrl: './eye-position-chart.component.html',
  styleUrl: './eye-position-chart.component.scss',
  // without geometry, or while the host keeps it folded away, there is nothing to show, take the slot out of the layout as well
  host: { '[class.unavailable]': '!visible() || !chart()' }
})
export class EyePositionChartComponent implements OnDestroy {
  /** the headset type of the settings page hosting this chart */
  headsetType = input.required<HeadsetType>();
  /** whether the host wants the chart drawn, chart() still tells whether there is anything to draw */
  visible = input(true);

  private dis = inject(DriverInfoService);
  private dss = inject(DriverSettingService);
  private lgs = inject(LighthouseGeometryService);

  steamVRRunning = signal({ updated: false, running: false }, { equal: (a, b) => a.running === b.running && a.updated === b.updated });
  private pullingRef = DeviceConfigComponentBase.steamVRStatePulling.createRef(value => {
    this.steamVRRunning.set({ updated: true, running: value });
  });

  constructor() {
    this.pullingRef.start();
  }

  ngOnDestroy(): void {
    this.pullingRef.stop();
  }

  /** the geometry belongs to the connected headset, only show it on that headset's page */
  applicable = computed(() => {
    const connected = this.dis.values()?.connectedHeadset ?? HeadsetType.None;
    if (connected === HeadsetType.None || connected !== this.headsetType()) {
      return false;
    }
    // the driver records the headset type when it can tell, then it has to match as well
    const dataHeadsetType = this.lgs.values()?.headsetType;
    return dataHeadsetType === undefined || dataHeadsetType === HeadsetType.None || dataHeadsetType === this.headsetType();
  });

  /** the data is not being updated when the headset is not actively running */
  notLive = computed(() => {
    const state = this.steamVRRunning();
    return state.updated && !state.running;
  });

  chart = computed<EyeChartViewModel | undefined>(() => {
    if (!this.applicable()) {
      return undefined;
    }
    const data = this.lgs.values();
    if (!data || (!data.sensors?.length && !data.head)) {
      return undefined;
    }
    const info = this.dis.values();
    const settings = this.dss.values();
    const field = settingsFieldByHeadsetType[this.headsetType()];
    const config = field ? settings?.[field] as BaseHeadsetConfig | undefined : undefined;

    // the eye cameras as the driver handed them to SteamVR, or rebuilt from the settings when
    // no session recorded them yet
    let eyes: { left: EyePose; right: EyePose } | null = null;
    let eyeSource: 'driver' | 'settings' | 'none' = 'none';
    const recorded = info?.eyes;
    if (recorded?.valid) {
      const left = eyePoseFromMatrix(recorded.eyeToHeadLeft);
      const right = eyePoseFromMatrix(recorded.eyeToHeadRight);
      if (left && right) {
        eyes = { left, right };
        eyeSource = 'driver';
      }
    }
    if (!eyes && config) {
      const ipd = ((config.ipd ?? 63) + (config.ipdOffset ?? 0)) / 1000;
      const rotation = (config.eyeRotation ?? 0) + (info?.resolution?.eyeRotationOffset ?? 0);
      eyes = eyePosesFromSettings(ipd, rotation, (config.horizontalIPDOffset ?? 0) / 1000, (config.viewpointDepthCorrection ?? 0) / 1000);
      eyeSource = 'settings';
    }

    const geometry = toHeadSpace(data, eyes);
    if (!geometry) {
      return undefined;
    }
    const readout = this.buildReadout(geometry);
    const views = this.buildViews(geometry, readout);
    return {
      views,
      readout,
      rows: this.buildRows(readout, eyeSource),
      eyeSource,
      headOverridden: !!data.headOverridden,
      modelNumber: data.modelNumber ?? '',
    };
  });

  /** the readout as sentences, values below a twentieth of a millimeter count as zero */
  private buildRows(readout: EyeChartReadout, eyeSource: 'driver' | 'settings' | 'none'): { label: string; value: string }[] {
    const rows: { label: string; value: string }[] = [];
    const mm = (value: number) => Math.abs(value).toFixed(1);
    const isZero = (value: number) => Math.abs(value) < 0.05;
    // -Z is forward, the depth values are positive behind their reference. the reference is only
    // named once per sentence, the following parts leave it out
    const depth = (value: number, reference: string) => isZero(value)
      ? $localize`at the same depth as ${reference}:reference:`
      : value > 0 ? $localize`${mm(value)}:mm: mm behind ${reference}:reference:` : $localize`${mm(value)}:mm: mm in front of ${reference}:reference:`;
    const heightOf = (value: number, reference: string) => isZero(value)
      ? $localize`at the same height as ${reference}:reference:`
      : value > 0 ? $localize`${mm(value)}:mm: mm above ${reference}:reference:` : $localize`${mm(value)}:mm: mm below ${reference}:reference:`;
    const height = (value: number) => isZero(value)
      ? $localize`at the same height`
      : value > 0 ? $localize`${mm(value)}:mm: mm above` : $localize`${mm(value)}:mm: mm below`;

    if (readout.eyeDepthBehindFrontSensors !== null && readout.eyeHeightAboveSensorCenter !== null) {
      rows.push({
        label: $localize`Eye cameras`,
        value: depth(readout.eyeDepthBehindFrontSensors, $localize`the front-most sensor`) + ', ' + heightOf(readout.eyeHeightAboveSensorCenter, $localize`the average sensor height`),
      });
    }
    if (readout.eyeDepthBehindOrigin !== null && readout.eyeHeightAboveOrigin !== null) {
      rows.push({
        label: $localize`Relative to the pose origin`,
        value: readout.eyesOnOrigin
          ? $localize`the eye cameras sit exactly on the pose origin, only apart by the IPD`
          : depth(readout.eyeDepthBehindOrigin, $localize`the pose origin`) + ', ' + height(readout.eyeHeightAboveOrigin),
      });
    }
    if (readout.ipd !== null && readout.cant !== null) {
      rows.push({
        label: $localize`IPD and cant`,
        value: `${readout.ipd.toFixed(1)} mm, ` + (readout.cant > 0.05
          ? $localize`each eye turned ${readout.cant.toFixed(1)}:degrees:° outwards`
          : $localize`eyes looking straight ahead`),
      });
    }
    if (readout.originalOriginForward !== null && readout.originalOriginUp !== null && readout.originalOriginRight !== null) {
      const parts: string[] = [];
      if (!isZero(readout.originalOriginForward)) {
        parts.push(readout.originalOriginForward > 0
          ? $localize`${mm(readout.originalOriginForward)}:mm: mm further forward`
          : $localize`${mm(readout.originalOriginForward)}:mm: mm further back`);
      }
      if (!isZero(readout.originalOriginUp)) {
        parts.push(readout.originalOriginUp > 0
          ? $localize`${mm(readout.originalOriginUp)}:mm: mm higher`
          : $localize`${mm(readout.originalOriginUp)}:mm: mm lower`);
      }
      if (!isZero(readout.originalOriginRight)) {
        parts.push(readout.originalOriginRight > 0
          ? $localize`${mm(readout.originalOriginRight)}:mm: mm further right`
          : $localize`${mm(readout.originalOriginRight)}:mm: mm further left`);
      }
      rows.push({
        label: $localize`Device head origin`,
        value: parts.length
          ? $localize`before the override the pose origin was ${parts.join(', ')}:offsets:`
          : $localize`the override only turned the head frame`,
      });
    }
    let source = $localize`unknown`;
    if (eyeSource === 'driver') {
      source = $localize`as last handed to SteamVR by this driver`;
    } else if (eyeSource === 'settings') {
      source = $localize`estimated from the current settings, no driver session has recorded them yet`;
    }
    rows.push({ label: $localize`Eye positions`, value: source });
    // some headsets turned out to have an unusual number of sensors, so state it plainly
    rows.push({ label: $localize`Total sensors`, value: `${readout.sensorCount}` });
    return rows;
  }

  private buildReadout(geometry: HeadSpaceGeometry): EyeChartReadout {
    const sensors = geometry.sensors;
    const readout: EyeChartReadout = {
      eyeDepthBehindFrontSensors: null,
      eyeHeightAboveSensorCenter: null,
      eyeDepthBehindOrigin: null,
      eyeHeightAboveOrigin: null,
      eyesOnOrigin: false,
      ipd: null,
      cant: null,
      originalOriginRight: null,
      originalOriginUp: null,
      originalOriginForward: null,
      sensorCount: sensors.length,
    };
    if (geometry.eyes) {
      const eyeCenter = scale(add(geometry.eyes.left.position, geometry.eyes.right.position), 0.5);
      // -Z is forward, so a larger z is further back
      readout.eyeDepthBehindOrigin = eyeCenter[2] * 1000;
      readout.eyeHeightAboveOrigin = eyeCenter[1] * 1000;
      readout.eyesOnOrigin = Math.abs(readout.eyeDepthBehindOrigin) < 0.05 && Math.abs(readout.eyeHeightAboveOrigin) < 0.05;
      readout.ipd = length(sub(geometry.eyes.right.position, geometry.eyes.left.position)) * 1000;
      readout.cant = eyeCantDegrees(geometry.eyes);
      if (sensors.length) {
        const frontZ = Math.min(...sensors.map(s => s.position[2]));
        const meanY = sensors.reduce((sum, s) => sum + s.position[1], 0) / sensors.length;
        readout.eyeDepthBehindFrontSensors = (eyeCenter[2] - frontZ) * 1000;
        readout.eyeHeightAboveSensorCenter = (eyeCenter[1] - meanY) * 1000;
      }
    }
    if (geometry.originalHeadOrigin) {
      readout.originalOriginRight = geometry.originalHeadOrigin[0] * 1000;
      readout.originalOriginUp = geometry.originalHeadOrigin[1] * 1000;
      readout.originalOriginForward = -geometry.originalHeadOrigin[2] * 1000;
    }
    return readout;
  }

  /** project a head frame point in meters onto a view, in mm with the svg y axis pointing down */
  private project(point: Vec3, kind: ViewKind): ChartPoint {
    const x = point[0] * 1000;
    const y = point[1] * 1000;
    const z = point[2] * 1000;
    switch (kind) {
      // looking down on the head, forward is up on the page
      case 'top': return { x, y: z };
      // looking at the head from its left side, forward is left on the page
      case 'side': return { x: z, y: -y };
      // looking at the head from behind, so left and right are as worn
      case 'rear': return { x, y: -y };
    }
  }

  private buildViews(geometry: HeadSpaceGeometry, readout: EyeChartReadout): EyeChartView[] {
    const kinds: ViewKind[] = ['top', 'side', 'rear'];
    const raw = kinds.map(kind => this.buildView(geometry, readout, kind));
    // one common scale so the views can be compared by eye
    const maxHeight = Math.max(...raw.map(v => v.height));
    const pxPerMm = TARGET_HEIGHT_PX / maxHeight;
    return raw.map(v => ({ ...v.view, widthPx: Math.round(v.width * pxPerMm), heightPx: Math.round(v.height * pxPerMm) }));
  }

  private buildView(geometry: HeadSpaceGeometry, readout: EyeChartReadout, kind: ViewKind): { view: EyeChartView; width: number; height: number } {
    const points: ChartPoint[] = [];
    const include = (p: ChartPoint, pad = 0) => {
      points.push({ x: p.x - pad, y: p.y - pad });
      points.push({ x: p.x + pad, y: p.y + pad });
    };

    const sensors: SensorMark[] = geometry.sensors.map(sensor => {
      const p = this.project(sensor.position, kind);
      include(p, 2);
      let tickX = p.x;
      let tickY = p.y;
      let hasTick = false;
      if (sensor.normal) {
        const tip = this.project(add(sensor.position, scale(sensor.normal, SENSOR_TICK_LENGTH / 1000)), kind);
        tickX = tip.x;
        tickY = tip.y;
        hasTick = Math.hypot(tip.x - p.x, tip.y - p.y) > 0.5;
        include(tip);
      }
      return { x: p.x, y: p.y, tickX, tickY, hasTick };
    });

    const origin = this.project([0, 0, 0], kind);
    include(origin, 6);
    const originalOrigin = geometry.originalHeadOrigin ? this.project(geometry.originalHeadOrigin, kind) : null;
    if (originalOrigin) {
      include(originalOrigin, 6);
    }

    const eyes: EyeMark[] = [];
    if (geometry.eyes) {
      const pair: { cls: 'left' | 'right'; pose: EyePose }[] = [
        { cls: 'left', pose: geometry.eyes.left },
        { cls: 'right', pose: geometry.eyes.right },
      ];
      for (const { cls, pose } of pair) {
        const pupil = this.project(pose.position, kind);
        const ballCenter = sub(pose.position, scale(pose.forward, EYEBALL_CENTER_BEHIND_PUPIL / 1000));
        const ball = this.project(ballCenter, kind);
        const lookTip = this.project(add(pose.position, scale(pose.forward, LOOK_LENGTH / 1000)), kind);
        const look = Math.hypot(lookTip.x - pupil.x, lookTip.y - pupil.y) > 2 ? lookTip : null;
        include(ball, EYEBALL_RADIUS);
        if (look) {
          include(look);
        }
        eyes.push({ cls, pupil, ball, ballRadius: EYEBALL_RADIUS, look });
      }
    }

    // the plane of the front-most sensor and how far behind it the eye cameras sit
    let frontPlane: EyeChartView['frontPlane'] = null;
    let depthDimension: Dimension | null = null;
    if (geometry.sensors.length && kind !== 'rear') {
      const frontZ = Math.min(...geometry.sensors.map(s => s.position[2])) * 1000;
      const minX = Math.min(...points.map(p => p.x));
      const maxX = Math.max(...points.map(p => p.x));
      const minY = Math.min(...points.map(p => p.y));
      const maxY = Math.max(...points.map(p => p.y));
      if (kind === 'top') {
        frontPlane = { x1: minX - 4, y1: frontZ, x2: maxX + 4, y2: frontZ };
      } else {
        frontPlane = { x1: frontZ, y1: minY - 4, x2: frontZ, y2: maxY + 4 };
      }
      if (geometry.eyes && readout.eyeDepthBehindFrontSensors !== null) {
        const eyeZ = frontZ + readout.eyeDepthBehindFrontSensors;
        const text = `${readout.eyeDepthBehindFrontSensors.toFixed(1)} mm`;
        if (kind === 'top') {
          const x = maxX + 10;
          depthDimension = { x1: x, y1: frontZ, x2: x, y2: eyeZ, labelX: x + 3, labelY: (frontZ + eyeZ) / 2, text, vertical: true };
          include({ x: x + 3 + text.length * 2.4, y: eyeZ });
        } else {
          const y = maxY + 10;
          depthDimension = { x1: frontZ, y1: y, x2: eyeZ, y2: y, labelX: (frontZ + eyeZ) / 2, labelY: y + 6, text, vertical: false };
          include({ x: eyeZ, y: y + 8 });
        }
      }
      include({ x: frontPlane.x1, y: frontPlane.y1 });
      include({ x: frontPlane.x2, y: frontPlane.y2 });
    }

    // bounds snapped to the grid, plus a margin
    let minX = Math.min(...points.map(p => p.x)) - MARGIN;
    let maxX = Math.max(...points.map(p => p.x)) + MARGIN;
    let minY = Math.min(...points.map(p => p.y)) - MARGIN;
    let maxY = Math.max(...points.map(p => p.y)) + MARGIN;
    // room for the direction labels at the top and the scale label at the bottom
    minY -= 6;
    maxY += 5;
    minX = Math.floor(minX / GRID_STEP) * GRID_STEP;
    maxX = Math.ceil(maxX / GRID_STEP) * GRID_STEP;
    minY = Math.floor(minY / GRID_STEP) * GRID_STEP;
    maxY = Math.ceil(maxY / GRID_STEP) * GRID_STEP;

    let gridPath = '';
    for (let x = minX; x <= maxX + 0.001; x += GRID_STEP) {
      gridPath += `M${x} ${minY}V${maxY}`;
    }
    for (let y = minY; y <= maxY + 0.001; y += GRID_STEP) {
      gridPath += `M${minX} ${y}H${maxX}`;
    }
    // the axes of the head frame through the pose origin
    const axisPath = `M${origin.x} ${minY}V${maxY}M${minX} ${origin.y}H${maxX}`;

    // direction labels along the top edge, the scale reference in the lower right corner
    const labels: ViewLabel[] = [];
    switch (kind) {
      case 'top':
        labels.push({ x: minX + 2, y: minY + 5, text: 'left', anchor: 'start', cls: 'direction' });
        labels.push({ x: (minX + maxX) / 2, y: minY + 5, text: '▲ front', anchor: 'middle', cls: 'direction' });
        labels.push({ x: maxX - 2, y: minY + 5, text: 'right', anchor: 'end', cls: 'direction' });
        break;
      case 'side':
        labels.push({ x: minX + 2, y: minY + 5, text: '◀ front', anchor: 'start', cls: 'direction' });
        labels.push({ x: maxX - 2, y: minY + 5, text: 'back', anchor: 'end', cls: 'direction' });
        break;
      case 'rear':
        labels.push({ x: minX + 2, y: minY + 5, text: 'left', anchor: 'start', cls: 'direction' });
        labels.push({ x: maxX - 2, y: minY + 5, text: 'right', anchor: 'end', cls: 'direction' });
        break;
    }
    labels.push({ x: maxX - 2, y: maxY - 2, text: `grid ${GRID_STEP} mm`, anchor: 'end', cls: 'scale' });

    const width = maxX - minX;
    const height = maxY - minY;
    return {
      view: {
        kind,
        viewBox: `${minX} ${minY} ${width} ${height}`,
        widthPx: 0,
        heightPx: 0,
        gridPath,
        axisPath,
        sensors,
        origin,
        originalOrigin,
        eyes,
        frontPlane,
        depthDimension,
        labels,
      },
      width,
      height,
    };
  }
}
