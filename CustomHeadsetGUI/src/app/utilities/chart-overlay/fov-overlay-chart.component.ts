import { Component, computed, inject, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ChartSourceBadgeComponent } from '../distortion/chart-source-badge.component';
import { FovChartSourceKind, FovChartSourceService } from '../distortion/fov-chart-source.service';
import {
  computeMetrics, eyeShapesOf, maxExtentOf, outlineToSvgPath, polarBackdrop, PolarBackdrop, SPOKE_COUNT, unionOutline
} from '../fov-chart/fov-geometry';
import { OverlayEntry } from './overlay-entry';

type OverlayRow = {
  entry: OverlayEntry;
  /** where the entry's data comes from, undefined when it has none */
  source?: FovChartSourceKind;
  /** the outline of both eyes together, empty when the entry has no data */
  path: string;
  hfov: number;
  vfov: number;
  overlap: number;
  coverage: number;
};

type OverlayViewModel = {
  backdrop: PolarBackdrop;
  rows: OverlayRow[];
};

/** distance kept free outside the outermost ring, no combined fov numbers are drawn here */
const OUTER_MARGIN = 2;

/**
 * The FOV previews of several headset and profile combinations on one polar chart: the combined
 * outline of both eyes per entry in the entry's color, with the numbers side by side below.
 */
@Component({
  selector: 'app-fov-overlay-chart',
  imports: [CommonModule, ChartSourceBadgeComponent],
  templateUrl: './fov-overlay-chart.component.html',
  styleUrl: './fov-overlay-chart.component.scss'
})
export class FovOverlayChartComponent {
  entries = input.required<OverlayEntry[]>();

  private source = inject(FovChartSourceService);

  chart = computed<OverlayViewModel>(() => {
    const rows: OverlayRow[] = [];
    let maxExtent = 0;
    for (const entry of this.entries()) {
      const data = this.source.data(entry.headsetType, entry.profile);
      const shapes = data ? eyeShapesOf(data) : null;
      if (!shapes) {
        rows.push({ entry, path: '', hfov: NaN, vfov: NaN, overlap: NaN, coverage: NaN });
        continue;
      }
      const metrics = computeMetrics(shapes.left, shapes.right);
      maxExtent = Math.max(maxExtent, maxExtentOf([shapes.left, shapes.right]));
      rows.push({
        entry,
        source: data!.source,
        path: outlineToSvgPath(unionOutline(shapes.left, shapes.right)),
        hfov: metrics.outer[0],
        vfov: metrics.outer[SPOKE_COUNT / 4],
        overlap: metrics.stereoOverlapDegrees,
        coverage: metrics.sphereCoveragePercent,
      });
    }
    return { backdrop: polarBackdrop(maxExtent, OUTER_MARGIN), rows };
  });

  format(value: number, digits: number): string {
    return isFinite(value) ? value.toFixed(digits) : '–';
  }
}
