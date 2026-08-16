import { Component, computed, inject, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HeadsetType } from '../../services/JsonFileDefines';
import { ChartSourceBadgeComponent } from '../distortion/chart-source-badge.component';
import { FovChartSourceService } from '../distortion/fov-chart-source.service';
import {
  computeEyeShape, computeMetrics, outlineToSvgPath,
  EyeProjection, EyeShape, HamRadii, SPOKE_COUNT
} from './fov-geometry';

type ChartLabel = { x: number; y: number; text: string };
type ChartSpoke = { x: number; y: number; side: 'axis' | 'left' | 'right' };
type OuterLabel = ChartLabel & { side: 'left' | 'right' };
type RingLabel = ChartLabel & { rotation: number };

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
  imports: [CommonModule, ChartSourceBadgeComponent],
  templateUrl: './fov-chart.component.html',
  styleUrl: './fov-chart.component.scss',
  // without FOV data there is nothing to show, take the flex slot of the row out as well
  host: { '[class.unavailable]': '!chart()' }
})
export class FovChartComponent {
  /** the headset type of the settings page hosting this chart */
  headsetType = input.required<HeadsetType>();

  private source = inject(FovChartSourceService);

  /** the projections and settings to draw, live from the driver or evaluated from the tab's settings */
  data = computed(() => this.source.data(this.headsetType()));

  chart = computed<ChartViewModel | undefined>(() => {
    const data = this.data();
    if (!data) {
      return undefined;
    }
    const { resolution, config } = data;
    const projections = {
      left: this.pickProjection(resolution.projectionLeft, resolution.fovX, resolution.fovY),
      right: this.pickProjection(resolution.projectionRight, resolution.fovX, resolution.fovY),
    };
    if (!projections.left && !projections.right) {
      return undefined;
    }
    const rotation = (config?.eyeRotation ?? 0) + (resolution.eyeRotationOffset ?? 0);
    const hamConfig = config?.hiddenArea;
    const ham: HamRadii | null = (hamConfig?.enable && !hamConfig.testMode) ? hamConfig : null;
    const disableEye = config?.disableEye ?? 0;

    const left = (disableEye & 1) || !projections.left ? null
      : computeEyeShape({ projection: projections.left, isRight: false, rotationDeg: rotation, ham });
    const right = (disableEye & 2) || !projections.right ? null
      : computeEyeShape({ projection: projections.right, isRight: true, rotationDeg: rotation, ham });
    if (!left && !right) {
      return undefined;
    }
    const metrics = computeMetrics(left, right);

    // trim the backdrop to the bands the shapes reach into, plus one fully empty band
    let maxExtent = 0;
    for (const shape of [left, right]) {
      if (shape) {
        for (const extent of shape.extents) {
          maxExtent = Math.max(maxExtent, extent);
        }
      }
    }
    const maxRing = Math.min(90, Math.max(15, Math.ceil(maxExtent / 5) * 5 + 5));
    const rings: number[] = [];
    for (let ring = 5; ring <= maxRing; ring += 5) {
      rings.push(ring);
    }
    // WimFOV colors the diagonal spokes by the eye that extends towards them
    const spokes: ChartSpoke[] = Array.from({ length: SPOKE_COUNT }, (_, i) => {
      const phi = (i / SPOKE_COUNT) * 2 * Math.PI;
      const angle = i * (360 / SPOKE_COUNT);
      const side = angle % 90 === 0 ? 'axis' : (angle > 90 && angle < 270 ? 'left' : 'right');
      return { x: maxRing * Math.cos(phi), y: -maxRing * Math.sin(phi), side };
    });
    // labels for the reference rings and the outermost ring, placed just inside their
    // circle and rotated along it, on diagonals between the spokes to stay readable
    const ringLabels: RingLabel[] = [];
    for (const ring of [...[30, 60].filter(r => r < maxRing), maxRing]) {
      for (const angleDeg of [56.25, 236.25]) {
        const phi = angleDeg * Math.PI / 180;
        const radius = ring - 1;
        let rotation = 90 - angleDeg;
        while (rotation <= -90) rotation += 180;
        while (rotation > 90) rotation -= 180;
        ringLabels.push({ x: radius * Math.cos(phi), y: -radius * Math.sin(phi), rotation, text: `${ring}°` });
      }
    }
    const viewSize = maxRing + OUTER_LABEL_MARGIN + 6;

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
      viewBox: `${-viewSize} ${-viewSize} ${viewSize * 2} ${viewSize * 2}`,
      stereoOverlap: metrics.stereoOverlapDegrees.toFixed(1),
      sphereCoverage: metrics.sphereCoveragePercent.toFixed(2),
      profileName: data.profileName,
    };
  });

  /** use the driver provided projection when valid, otherwise fall back to a symmetric one from the fov angles */
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

  private innerLabelRadius(extent: number, maxRing: number): number | undefined {
    if (!(extent >= 3)) {
      return undefined;
    }
    return Math.min(Math.max(extent - 8, 12), maxRing - 8);
  }
}
