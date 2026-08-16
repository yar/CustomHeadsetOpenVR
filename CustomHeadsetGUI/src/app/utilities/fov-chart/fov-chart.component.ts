import { Component, computed, inject, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HeadsetType } from '../../services/JsonFileDefines';
import { ChartCompareButtonComponent } from '../distortion/chart-compare-button.component';
import { ChartSourceBadgeComponent } from '../distortion/chart-source-badge.component';
import { FovChartSourceService } from '../distortion/fov-chart-source.service';
import {
  computeMetrics, eyeShapesOf, maxExtentOf, outlineToSvgPath, polarBackdrop,
  PolarRingLabel, PolarSpoke, SPOKE_COUNT
} from './fov-geometry';

type ChartLabel = { x: number; y: number; text: string };
type ChartSpoke = PolarSpoke;
type OuterLabel = ChartLabel & { side: 'left' | 'right' };
type RingLabel = PolarRingLabel;

type ChartViewModel = {
  leftPath: string;
  rightPath: string;
  innerLeft: ChartLabel[];
  innerRight: ChartLabel[];
  outer: OuterLabel[];
  /** backdrop ring radii, only up to the outermost band the shapes reach into */
  rings: number[];
  maxRing: number;
  spokes: ChartSpoke[];
  /** labels hugging the 30/60 degree rings and the outermost ring, rotated along the circle */
  ringLabels: RingLabel[];
  viewBox: string;
  stereoOverlap: string;
  sphereCoverage: string;
  profileName: string;
};

/** distance of the combined FOV numbers from the outermost ring */
const OUTER_LABEL_MARGIN = 7;

@Component({
  selector: 'app-fov-chart',
  imports: [CommonModule, ChartSourceBadgeComponent, ChartCompareButtonComponent],
  templateUrl: './fov-chart.component.html',
  styleUrl: './fov-chart.component.scss',
  // without FOV data there is nothing to show, take the flex slot of the row out as well
  host: { '[class.unavailable]': '!chart()' }
})
export class FovChartComponent {
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

  /** the projections and settings to draw, live from the driver or evaluated from the tab's settings */
  data = computed(() => this.source.data(this.headsetType(), this.profile()));

  chart = computed<ChartViewModel | undefined>(() => {
    const data = this.data();
    if (!data) {
      return undefined;
    }
    const shapes = eyeShapesOf(data);
    if (!shapes) {
      return undefined;
    }
    const { left, right } = shapes;
    const metrics = computeMetrics(left, right);
    const { rings, maxRing, spokes, ringLabels, viewBox } = polarBackdrop(maxExtentOf([left, right]), OUTER_LABEL_MARGIN);

    const innerLeft: ChartLabel[] = [];
    const innerRight: ChartLabel[] = [];
    const outer: OuterLabel[] = [];
    for (let spoke = 0; spoke < SPOKE_COUNT; spoke++) {
      const phi = (spoke / SPOKE_COUNT) * 2 * Math.PI;
      const cos = Math.cos(phi);
      const sin = Math.sin(phi);
      let labelRadiusLeft = this.innerLabelRadius(metrics.innerLeft[spoke], maxRing);
      let labelRadiusRight = this.innerLabelRadius(metrics.innerRight[spoke], maxRing);
      // keep the two eye labels of one spoke from overlapping each other
      if (labelRadiusLeft !== undefined && labelRadiusRight !== undefined && Math.abs(labelRadiusLeft - labelRadiusRight) < 8) {
        const middle = (labelRadiusLeft + labelRadiusRight) / 2;
        const leftIsInner = metrics.innerLeft[spoke] <= metrics.innerRight[spoke];
        labelRadiusLeft = middle + (leftIsInner ? -4 : 4);
        labelRadiusRight = middle + (leftIsInner ? 4 : -4);
      }
      if (labelRadiusLeft !== undefined) {
        innerLeft.push({ x: labelRadiusLeft * cos, y: -labelRadiusLeft * sin, text: `${Math.round(metrics.innerLeft[spoke])}°` });
      }
      if (labelRadiusRight !== undefined) {
        innerRight.push({ x: labelRadiusRight * cos, y: -labelRadiusRight * sin, text: `${Math.round(metrics.innerRight[spoke])}°` });
      }
      if (metrics.outer[spoke] >= 1) {
        const outerRadius = maxRing + OUTER_LABEL_MARGIN;
        // matching WimFOV, numbers in the left half plus straight up and down are red, the right half blue
        const angle = spoke * (360 / SPOKE_COUNT);
        const side = angle >= 90 && angle <= 270 ? 'left' : 'right';
        outer.push({ x: outerRadius * cos, y: -outerRadius * sin, text: `${Math.round(metrics.outer[spoke])}°`, side });
      }
    }

    return {
      leftPath: left ? outlineToSvgPath(left.outline) : '',
      rightPath: right ? outlineToSvgPath(right.outline) : '',
      innerLeft,
      innerRight,
      outer,
      rings,
      maxRing,
      spokes,
      ringLabels,
      viewBox,
      stereoOverlap: metrics.stereoOverlapDegrees.toFixed(1),
      sphereCoverage: metrics.sphereCoveragePercent.toFixed(2),
      profileName: data.profileName,
    };
  });

  private innerLabelRadius(extent: number, maxRing: number): number | undefined {
    if (!(extent >= 3)) {
      return undefined;
    }
    return Math.min(Math.max(extent - 8, 12), maxRing - 8);
  }
}
