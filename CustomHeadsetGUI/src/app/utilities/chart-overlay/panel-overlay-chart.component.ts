import { Component, computed, inject, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ChartSourceBadgeComponent } from '../distortion/chart-source-badge.component';
import { FovChartSourceKind, FovChartSourceService } from '../distortion/fov-chart-source.service';
import { projectionFromResolution } from '../fov-chart/fov-geometry';
import { HamRadii, parseGrid } from '../fov-panel-chart/panel-geometry';
import { drawPanelGrid, forwardLookDirection, PanelLabel, panelDirectionSpot, panelHamPath, panelMapping, panelOpticalAxis } from '../fov-panel-chart/panel-chart-model';
import { PanelChartLegendComponent } from '../fov-panel-chart/panel-chart-legend.component';
import { OverlayEntry } from './overlay-entry';

type EntryDrawing = {
  entry: OverlayEntry;
  source: FovChartSourceKind;
  contours: string[];
  boundary: string;
  center: { x: number; y: number };
  /** where the head's straight ahead direction lands on the entry's panel, null when it does not */
  forward: { x: number; y: number } | null;
  /** the entry's panel in seen space, all panels share the center */
  halfWidth: number;
  halfHeight: number;
  /** the hidden area cut of the entry's headset tab, empty when disabled */
  hamPath: string;
};

type PanelOverlayEye = {
  /** the union of the entries' panels */
  halfWidth: number;
  halfHeight: number;
  viewBox: string;
  drawings: EntryDrawing[];
  /** degree labels of the first entry, the others share the horizontal ray anyway */
  labels: PanelLabel[];
};

type PanelOverlayViewModel = {
  left: PanelOverlayEye | null;
  right: PanelOverlayEye | null;
  /** entries without a sampling, listed under the chart */
  missing: OverlayEntry[];
  /** whether every drawn entry has the same panel size and rotation, then one panel outline is enough */
  samePanels: boolean;
  /** whether every drawn entry is on the same headset, then one hidden area cut is enough */
  sameHeadset: boolean;
};

/**
 * The panel angle maps of several headset and profile combinations on one pair of panels: the green
 * channel contours of each entry in the entry's color, so the geometry of profiles can be compared
 * where it matters, on the panel. Entries may be on different headsets; when their panels differ, each
 * panel outline is drawn in its entry's color around the shared center.
 */
@Component({
  selector: 'app-panel-overlay-chart',
  imports: [CommonModule, ChartSourceBadgeComponent, PanelChartLegendComponent],
  templateUrl: './panel-overlay-chart.component.html',
  styleUrl: './panel-overlay-chart.component.scss'
})
export class PanelOverlayChartComponent {
  entries = input.required<OverlayEntry[]>();

  private source = inject(FovChartSourceService);

  chart = computed<PanelOverlayViewModel | undefined>(() => {
    const entries = this.entries();
    if (!entries.length) {
      return undefined;
    }
    const missing: OverlayEntry[] = [];
    const eyes: { left: PanelOverlayEye | null; right: PanelOverlayEye | null } = { left: null, right: null };
    const panelKeys = new Set<string>();
    const headsets = new Set<number>();
    for (const entry of entries) {
      const data = this.source.data(entry.headsetType, entry.profile);
      const sampling = data?.sampling;
      if (!data || !sampling || !sampling.gridSize) {
        missing.push(entry);
        continue;
      }
      const hamConfig = data.config?.hiddenArea;
      const ham: HamRadii | null = (hamConfig?.enable && !hamConfig.testMode) ? hamConfig : null;
      const disableEye = data.config?.disableEye ?? 0;
      // the outward rotation of the entry's eyes, the same the FOV preview turns them by
      const yaw = (data.config?.eyeRotation ?? 0) + (data.resolution.eyeRotationOffset ?? 0);
      const first = eyes.left === null && eyes.right === null;
      let drawn = false;
      for (const isRight of [false, true]) {
        if ((disableEye & (isRight ? 2 : 1)) !== 0) {
          continue;
        }
        const channels = isRight ? sampling.right : sampling.left;
        const projection = projectionFromResolution(isRight ? data.resolution.projectionRight : data.resolution.projectionLeft, data.resolution.fovX, data.resolution.fovY);
        const grid = channels ? parseGrid(channels.green, sampling.gridSize) : null;
        if (!grid || !projection) {
          continue;
        }
        const mapping = panelMapping(sampling, isRight);
        const drawing = drawPanelGrid(grid, projection, mapping, first, panelOpticalAxis(sampling, isRight));
        const side = isRight ? 'right' : 'left';
        let eye = eyes[side];
        if (!eye) {
          eye = { halfWidth: 0, halfHeight: 0, viewBox: '', drawings: [], labels: drawing.labels };
          eyes[side] = eye;
        }
        eye.halfWidth = Math.max(eye.halfWidth, mapping.halfWidth);
        eye.halfHeight = Math.max(eye.halfHeight, mapping.halfHeight);
        eye.drawings.push({
          entry,
          source: data.source,
          contours: drawing.contours,
          boundary: drawing.boundary,
          center: drawing.center,
          forward: panelDirectionSpot(grid, projection, mapping, forwardLookDirection(isRight, yaw)),
          halfWidth: mapping.halfWidth,
          halfHeight: mapping.halfHeight,
          hamPath: ham ? panelHamPath(grid, isRight, ham, mapping) : '',
        });
        drawn = true;
      }
      if (drawn) {
        panelKeys.add(`${sampling.viewportWidth}x${sampling.viewportHeight}r${sampling.displayRotation}`);
        headsets.add(entry.headsetType);
      }
    }
    if (!eyes.left && !eyes.right) {
      return undefined;
    }
    for (const eye of [eyes.left, eyes.right]) {
      if (eye) {
        const margin = 0.1;
        eye.viewBox = `${-(eye.halfWidth + margin)} ${-(eye.halfHeight + margin)} ${(eye.halfWidth + margin) * 2} ${(eye.halfHeight + margin) * 2}`;
      }
    }
    return { left: eyes.left, right: eyes.right, missing, samePanels: panelKeys.size <= 1, sameHeadset: headsets.size <= 1 };
  });

  /** the hidden area cut drawn once when all entries share the headset: the first entry's */
  sharedHam(eye: PanelOverlayEye): string {
    return eye.drawings.find(d => d.hamPath)?.hamPath ?? '';
  }

  /** whether any hidden area cut is drawn, so the legend explains it */
  hasHiddenArea = computed(() => {
    const vm = this.chart();
    return !!vm && [vm.left, vm.right].some(eye => eye?.drawings.some(d => d.hamPath));
  });
}
