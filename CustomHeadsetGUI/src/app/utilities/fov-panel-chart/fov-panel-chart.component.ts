import { Component, computed, inject, input, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HeadsetType } from '../../services/JsonFileDefines';
import { ChartCompareButtonComponent } from '../distortion/chart-compare-button.component';
import { ChartSourceBadgeComponent } from '../distortion/chart-source-badge.component';
import { FovChartSourceService } from '../distortion/fov-chart-source.service';
import { FovVisualizationChannels } from './fov-visualization.service';
import { projectionFromResolution } from '../fov-chart/fov-geometry';
import { EyeProjection, HamRadii, PanelGrid, parseGrid } from './panel-geometry';
import { drawPanelGrid, forwardLookDirection, PanelGridMeta, PanelLabel, panelDirectionSpot, panelHamPath, panelMapping, panelOpticalAxis, panelViewBox } from './panel-chart-model';
import { PanelChartLegendComponent } from './panel-chart-legend.component';

export type PanelChannelChoice = 'green' | 'red' | 'blue' | 'all';

type ContourPath = { path: string; cls: string };

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

@Component({
  selector: 'app-fov-panel-chart',
  imports: [CommonModule, ChartSourceBadgeComponent, ChartCompareButtonComponent, PanelChartLegendComponent],
  templateUrl: './fov-panel-chart.component.html',
  styleUrl: './fov-panel-chart.component.scss',
  // without a sampling there is nothing to show, take the flex slot of the row out as well
  host: { '[class.unavailable]': '!chart()' }
})
export class FovPanelChartComponent {
  /** the headset type of the settings page hosting this chart */
  headsetType = input.required<HeadsetType>();
  /**
   * a profile to show instead of the one selected on that headset's tab, evaluated with the tab's
   * settings; used by the Charts tab to put several profiles side by side
   */
  profile = input<string | null | undefined>(undefined);
  /** the button taking this chart to the Charts tab, off where the chart already is one of its tiles */
  showCompare = input(true);

  private source = inject(FovChartSourceService);

  channel = signal<PanelChannelChoice>('green');
  channelChoices: PanelChannelChoice[] = ['green', 'red', 'blue', 'all'];

  /** the sampling and projections to draw, live from the driver or evaluated from the tab's settings */
  data = computed(() => this.source.data(this.headsetType(), this.profile()));

  /** the distortion profile the shown sampling belongs to */
  profileName = computed(() => this.data()?.profileName ?? '');

  /** whether a hidden area cut is drawn, so the legend explains it */
  hasHiddenArea = computed(() => {
    const vm = this.chart();
    return !!(vm?.left?.hamPath || vm?.right?.hamPath);
  });

  chart = computed<PanelChartViewModel | undefined>(() => {
    const source = this.data();
    const data = source?.sampling;
    if (!source || !data || !data.gridSize) {
      return undefined;
    }
    const { resolution, config } = source;
    const hamConfig = config?.hiddenArea;
    const ham: HamRadii | null = (hamConfig?.enable && !hamConfig.testMode) ? hamConfig : null;
    const disableEye = config?.disableEye ?? 0;
    const channel = this.channel();
    // the outward rotation of the eyes, the same the FOV preview turns them by
    const yaw = (config?.eyeRotation ?? 0) + (resolution.eyeRotationOffset ?? 0);

    const left = this.buildEye(data.left, false, data, projectionFromResolution(resolution.projectionLeft, resolution.fovX, resolution.fovY), ham, (disableEye & 1) !== 0, channel, yaw);
    const right = this.buildEye(data.right, true, data, projectionFromResolution(resolution.projectionRight, resolution.fovX, resolution.fovY), ham, (disableEye & 2) !== 0, channel, yaw);
    if (!left && !right) {
      return undefined;
    }
    return { left, right };
  });

  private buildEye(channels: FovVisualizationChannels | undefined, isRight: boolean, data: PanelGridMeta,
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

    const mapping = panelMapping(data, isRight);
    const contours: ContourPath[] = [];
    const boundaries: ContourPath[] = [];
    const crosses: { x: number; y: number; cls: string }[] = [];
    const labels: PanelLabel[] = [];
    for (const { grid, cls } of selected) {
      // labels along the horizontal to the right of the center, only for the primary grid
      const drawing = drawPanelGrid(grid, projection, mapping, cls !== 'channel-red' && cls !== 'channel-blue', panelOpticalAxis(data, isRight));
      contours.push(...drawing.contours.map(path => ({ path, cls })));
      boundaries.push({ path: drawing.boundary, cls });
      crosses.push({ x: drawing.center.x, y: drawing.center.y, cls });
      labels.push(...drawing.labels);
    }
    const hamPath = ham ? panelHamPath(grids['green'], isRight, ham, mapping) : '';
    const forward = panelDirectionSpot(grids['green'], projection, mapping, forwardLookDirection(isRight, yaw));
    return {
      halfWidth: mapping.halfWidth,
      halfHeight: mapping.halfHeight,
      viewBox: panelViewBox(mapping),
      contours,
      boundaries,
      crosses,
      forward,
      labels,
      hamPath,
      disabled,
    };
  }

}
