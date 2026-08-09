import { Component, computed, inject, input, OnDestroy, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DriverInfoService } from '../../services/driver-info.service';
import { DriverSettingService } from '../../services/driver-setting.service';
import { BaseHeadsetConfig, HeadsetType } from '../../services/JsonFileDefines';
import { DeviceConfigComponentBase, DistortionProfileDisplayNames } from '../../pages/devices/DeviceConfigComponentBase';
import { settingsFieldByHeadsetType } from '../fov-chart/headset-fields';
import { FovVisualizationService, FovVisualizationChannels } from './fov-visualization.service';
import {
  computeAngleField, computeCoverageField, computeHamField, contourSegments,
  EyeProjection, findCenter, HamRadii, PanelGrid, parseGrid, Point, sampleField, segmentsToSvgPath, SeenSpaceMapping
} from './panel-geometry';
import { PanelChartLegendComponent } from './panel-chart-legend.component';

export type PanelChannelChoice = 'green' | 'red' | 'blue' | 'all';

type ContourPath = { path: string; cls: string };
type PanelLabel = { x: number; y: number; text: string };

type PanelEyeViewModel = {
  halfWidth: number;
  halfHeight: number;
  viewBox: string;
  contours: ContourPath[];
  boundaries: ContourPath[];
  crosses: { x: number; y: number; cls: string }[];
  /** where the head's straight ahead direction lands on the panel, null when it does not */
  forward: { x: number; y: number } | null;
  labels: PanelLabel[];
  hamPath: string;
  disabled: boolean;
};

type PanelChartViewModel = {
  left: PanelEyeViewModel | null;
  right: PanelEyeViewModel | null;
};

/** contour step in degrees, every second one gets a label */
const CONTOUR_STEP = 5;

@Component({
  selector: 'app-fov-panel-chart',
  imports: [CommonModule, PanelChartLegendComponent],
  templateUrl: './fov-panel-chart.component.html',
  styleUrl: './fov-panel-chart.component.scss',
  // without a sampling there is nothing to show, take the flex slot of the row out as well
  host: { '[class.unavailable]': '!chart()' }
})
export class FovPanelChartComponent implements OnDestroy {
  /** the headset type of the settings page hosting this chart */
  headsetType = input.required<HeadsetType>();

  private dis = inject(DriverInfoService);
  private dss = inject(DriverSettingService);
  private fvs = inject(FovVisualizationService);

  channel = signal<PanelChannelChoice>('green');
  channelChoices: PanelChannelChoice[] = ['green', 'red', 'blue', 'all'];

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

  /** the sampling belongs to the connected headset, only show it on that headset's page */
  applicable = computed(() => {
    const connected = this.dis.values()?.connectedHeadset ?? HeadsetType.None;
    if (connected === HeadsetType.None || connected !== this.headsetType()) {
      return false;
    }
    // when the sampling records its headset type, also require it to match
    const dataHeadsetType = this.fvs.values()?.headsetType;
    return dataHeadsetType === undefined || dataHeadsetType === this.headsetType();
  });

  /** the data is not being updated when the headset is not actively running */
  notLive = computed(() => {
    const state = this.steamVRRunning();
    return state.updated && !state.running;
  });

  /** the distortion profile the shown sampling was made with, when recorded */
  sampledFromProfile = computed(() => {
    const name = this.fvs.values()?.distortionProfile;
    return name ? (DistortionProfileDisplayNames.get(name) ?? name) : '';
  });

  /** whether a hidden area cut is drawn, so the legend explains it */
  hasHiddenArea = computed(() => {
    const vm = this.chart();
    return !!(vm?.left?.hamPath || vm?.right?.hamPath);
  });

  chart = computed<PanelChartViewModel | undefined>(() => {
    if (!this.applicable()) {
      return undefined;
    }
    const data = this.fvs.values();
    const info = this.dis.values();
    const settings = this.dss.values();
    if (!data || !data.gridSize || !info?.resolution) {
      return undefined;
    }
    const field = settingsFieldByHeadsetType[this.headsetType()];
    const config = field ? settings?.[field] as BaseHeadsetConfig : undefined;
    const hamConfig = config?.hiddenArea;
    const ham: HamRadii | null = (hamConfig?.enable && !hamConfig.testMode) ? hamConfig : null;
    const disableEye = config?.disableEye ?? 0;
    const channel = this.channel();
    // the outward rotation of the eyes, the same the FOV preview turns them by
    const yaw = (config?.eyeRotation ?? 0) + (info.resolution.eyeRotationOffset ?? 0);

    const left = this.buildEye(data.left, false, data, this.pickProjection(info.resolution.projectionLeft, info.resolution.fovX, info.resolution.fovY), ham, (disableEye & 1) !== 0, channel, yaw);
    const right = this.buildEye(data.right, true, data, this.pickProjection(info.resolution.projectionRight, info.resolution.fovX, info.resolution.fovY), ham, (disableEye & 2) !== 0, channel, yaw);
    if (!left && !right) {
      return undefined;
    }
    return { left, right };
  });

  private buildEye(channels: FovVisualizationChannels | undefined, isRight: boolean,
    data: {
      gridSize: number; displayRotation: number; viewportWidth: number; viewportHeight: number;
      opticalAxisLeft?: number[]; opticalAxisRight?: number[];
    },
    projection: EyeProjection | null, ham: HamRadii | null, disabled: boolean,
    channelChoice: PanelChannelChoice, yaw: number): PanelEyeViewModel | null {
    if (!channels || !projection) {
      return null;
    }
    const size = data.gridSize;
    const grids: { [key: string]: PanelGrid | null } = {
      green: parseGrid(channels.green, size),
      red: parseGrid(channels.red, size),
      blue: parseGrid(channels.blue, size),
    };
    if (!grids['green'] || !grids['red'] || !grids['blue']) {
      return null;
    }
    const selected: { grid: PanelGrid; cls: string }[] = [];
    if (channelChoice === 'all') {
      selected.push({ grid: grids['red'], cls: 'channel-red' });
      selected.push({ grid: grids['green'], cls: 'channel-green' });
      selected.push({ grid: grids['blue'], cls: 'channel-blue' });
    } else {
      selected.push({ grid: grids[channelChoice]!, cls: 'channel-single' });
    }

    const mapping = new SeenSpaceMapping(size, data.displayRotation, isRight, data.viewportWidth, data.viewportHeight);
    // the angles are measured from the optical axis, so maps of the same panel compare whatever frame their
    // projections are in
    const axis = this.opticalAxis(data, isRight);
    const contours: ContourPath[] = [];
    const boundaries: ContourPath[] = [];
    const crosses: { x: number; y: number; cls: string }[] = [];
    const labels: PanelLabel[] = [];
    for (const { grid, cls } of selected) {
      const angles = computeAngleField(grid, projection, axis);
      for (let iso = CONTOUR_STEP; iso <= angles.maxValidAngle; iso += CONTOUR_STEP) {
        const segments = contourSegments(angles.angle, size, iso, angles.valid);
        if (segments.length) {
          contours.push({ path: segmentsToSvgPath(segments, mapping), cls });
        }
      }
      // the edge of the rendered area
      const coverage = computeCoverageField(grid);
      boundaries.push({ path: segmentsToSvgPath(contourSegments(coverage, size, 1.0), mapping), cls });
      // the optical axis of the lens, where the view angle is zero
      const center = findCenter(angles.angle, size);
      const centerSeen = mapping.gridToSeen(center.x, center.y);
      crosses.push({ x: centerSeen.x, y: -centerSeen.y, cls });
      // labels along the horizontal to the right of the center, only for the primary grid
      if (cls !== 'channel-red' && cls !== 'channel-blue') {
        labels.push(...this.contourLabels(angles.angle, angles.valid, size, mapping, centerSeen));
      }
    }
    // hidden area mesh cut, based on the green channel like the compositor's clamping reference
    let hamPath = '';
    if (ham) {
      const hamSegments = contourSegments(computeHamField(grids['green'], isRight, ham), size, 0);
      hamPath = segmentsToSvgPath(hamSegments, mapping);
    }
    const forward = this.panelDirectionSpot(grids['green'], projection, mapping, this.forwardLookDirection(isRight, yaw));
    const margin = 0.1;
    const width = (mapping.halfWidth + margin) * 2;
    const height = (mapping.halfHeight + margin) * 2;
    return {
      halfWidth: mapping.halfWidth,
      halfHeight: mapping.halfHeight,
      viewBox: `${-(mapping.halfWidth + margin)} ${-(mapping.halfHeight + margin)} ${width} ${height}`,
      contours,
      boundaries,
      crosses,
      forward,
      labels,
      hamPath,
      disabled,
    };
  }

  /** where the lens of one eye is centered, as tangents in the frame of the projection; the frame's forward when not recorded */
  private opticalAxis(data: { opticalAxisLeft?: number[]; opticalAxisRight?: number[] }, isRight: boolean): Point {
    const axis = isRight ? data.opticalAxisRight : data.opticalAxisLeft;
    return axis && axis.length === 2 ? { x: axis[0], y: axis[1] } : { x: 0, y: 0 };
  }

  /**
   * the direction the head looks straight ahead in, as tangents in the projection frame of an eye that is
   * rotated outwards by yawDegrees (the eye rotation setting plus the profile's offset, the rotation the FOV
   * preview turns the eyes by): the eye frame is turned outwards, so straight ahead lies inwards in it
   */
  private forwardLookDirection(isRight: boolean, yawDegrees: number): Point {
    const inwards = Math.tan(yawDegrees * Math.PI / 180);
    return { x: isRight ? -inwards : inwards, y: 0 };
  }

  /**
   * the spot of the panel that shows a direction of the projection frame, in seen space with y down like SVG,
   * null when the direction is not on the panel. The nearest sample has to be close: the grid is a degree
   * or two apart, anything further means the direction lies outside the sampled area.
   */
  private panelDirectionSpot(grid: PanelGrid, projection: EyeProjection, mapping: SeenSpaceMapping, direction: Point): Point | null {
    const angles = computeAngleField(grid, projection, direction);
    const nearest = findCenter(angles.angle, grid.size);
    const index = Math.round(nearest.y) * grid.size + Math.round(nearest.x);
    if (!angles.valid[index] || angles.angle[index] > 3) {
      return null;
    }
    const seen = mapping.gridToSeen(nearest.x, nearest.y);
    return { x: seen.x, y: -seen.y };
  }

  /** place a degree label where each 10 degree contour crosses the horizontal ray from the center */
  private contourLabels(angle: Float64Array, valid: Uint8Array, size: number,
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

  /** use the driver provided projection when valid, otherwise fall back to a symmetric one */
  private pickProjection(raw: number[] | undefined, fovX: number, fovY: number): EyeProjection | null {
    if (raw && raw.length === 4 && raw[1] > raw[0] && raw[3] > raw[2]) {
      return { left: raw[0], right: raw[1], bottom: raw[2], top: raw[3] };
    }
    if (fovX > 0 && fovY > 0) {
      const tanX = Math.tan(fovX / 2 * Math.PI / 180);
      const tanY = Math.tan(fovY / 2 * Math.PI / 180);
      return { left: -tanX, right: tanX, bottom: -tanY, top: tanY };
    }
    return null;
  }
}
