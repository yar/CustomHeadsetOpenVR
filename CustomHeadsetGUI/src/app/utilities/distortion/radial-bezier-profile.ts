/**
 * Port of the driver's distortion profiles, RadialBezierDistortionProfile.cpp and NoneDistortionProfile.h,
 * so the GUI can compute the projection and the panel sampling of any profile on any headset without
 * the driver running. The math mirrors the C++ line by line, including its quirks (first matching
 * segment in the samplers, the 512 entry radial maps, the 1.41421 corner reach), so the results match
 * what the compositor gets. The driver computes in single precision, this port in double, which is
 * far below what the charts can show. Keep this file in sync with the C++ when the distortion changes.
 */
import { CurvePoint, knotsFromFlat, sampleCurve, smoothPoints } from '../fov-ca-chart/radial-bezier-curves';

export type Eye = 'left' | 'right';
export type ColorChannel = 'red' | 'green' | 'blue';

/** DistortionProfile::GetProjectionRaw, tangents of the half angles, bottom negative */
export type ProjectionRaw = { left: number; right: number; bottom: number; top: number };

/** the DistortionProfile base class fields the driver copies from the headset config in ReInitializeProfile */
export type DistortionProfileSettings = {
  resolutionX: number;
  resolutionY: number;
  maxFovX: number;
  maxFovY: number;
  fovZoom: number;
  flatFovZoom: number;
  chromaticAberrationScaleRed: number;
  chromaticAberrationScaleBlue: number;
  fovClamping: boolean;
};

/**
 * A profile as the driver knows it: a built-in profile from info.json or a parsed profile file.
 * Anything but type RadialBezier falls back to the none profile like DistortionProfileConstructor does.
 */
export type DistortionProfileDefinition = {
  type?: string;
  distortions?: number[];
  distortionsRed?: number[];
  distortionsBlue?: number[];
  legacySmoothing?: boolean;
  smoothAmount?: number;
  offsetX?: number;
  offsetY?: number;
  eyeRotationOffset?: number;
};

export interface DistortionProfile {
  /** additional eye rotation in degrees the profile asks for on top of the headset's eye rotation */
  readonly eyeRotationOffset: number;
  getProjectionRaw(eye: Eye): ProjectionRaw;
  /**
   * fU and fV are normalized to [-1, 1] within the smallest square that fits on the panel, so they can be
   * larger than 1 in the larger dimension. The result is in [-1, 1] rendered image UVs.
   */
  computeDistortion(eye: Eye, channel: ColorChannel, fU: number, fV: number): CurvePoint;
  /** the render resolution for 1:1 distortion, null when the profile has no opinion */
  getRecommendedRenderTargetSize(): { width: number; height: number } | null;
}

const DEG = Math.PI / 180;

/** NoneDistortionProfile, the fallback the driver runs when a profile can not be loaded */
export class NoneDistortionProfile implements DistortionProfile {
  readonly eyeRotationOffset = 0;
  /** BaseHeadset sets 95 for both, the class default is 100 */
  noneDistortionFovHorizontal = 95;
  noneDistortionFovVertical = 95;

  constructor(private settings: DistortionProfileSettings) { }

  getProjectionRaw(_eye: Eye): ProjectionRaw {
    const fovZoom = this.settings.fovZoom === 0 ? 1 : this.settings.fovZoom;
    const hFovHalf = this.noneDistortionFovHorizontal / fovZoom / 2 * DEG;
    const vFovHalf = this.noneDistortionFovVertical / fovZoom / 2 * DEG;
    return { left: Math.tan(-hFovHalf), right: Math.tan(hFovHalf), bottom: Math.tan(-vFovHalf), top: Math.tan(vFovHalf) };
  }

  computeDistortion(_eye: Eye, _channel: ColorChannel, fU: number, fV: number): CurvePoint {
    return { x: fU, y: fV };
  }

  getRecommendedRenderTargetSize(): null {
    return null;
  }
}

/** DistortionPoint: location in degrees in the input image and on the display from 0 to 100 */
type DistortionPoint = CurvePoint;

function bezierPoint(t: number, controlPoints: DistortionPoint[]): DistortionPoint {
  const tSquared = t * t;
  const tCubed = t * t * t;
  const oneMinusT = 1 - t;
  const oneMinusTSquared = oneMinusT * oneMinusT;
  const oneMinusTCubed = oneMinusT * oneMinusT * oneMinusT;
  return {
    x: oneMinusTCubed * controlPoints[0].x + 3 * oneMinusTSquared * t * controlPoints[1].x
      + 3 * oneMinusT * tSquared * controlPoints[2].x + tCubed * controlPoints[3].x,
    y: oneMinusTCubed * controlPoints[0].y + 3 * oneMinusTSquared * t * controlPoints[1].y
      + 3 * oneMinusT * tSquared * controlPoints[2].y + tCubed * controlPoints[3].y,
  };
}

/** the legacy SmoothPoints: bezier segments whose center control points are extrapolated from the neighbouring slopes */
function smoothPointsLegacy(points: DistortionPoint[], innerPointCounts: number, smoothAmount: number): DistortionPoint[] {
  if (points.length === 0) {
    return [];
  }
  const outPoints: DistortionPoint[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const prevPoint = points[i];
    const nextPoint = points[i + 1];
    const prevPrevPoint = i <= 0 ? points[i] : points[i - 1];
    const nextNextPoint = i >= points.length - 2 ? points[i + 1] : points[i + 2];
    const fallbackSlope = (nextPoint.y - prevPoint.y) / (nextPoint.x - prevPoint.x);
    const prevSlope = i <= 0 ? fallbackSlope : (nextPoint.y - prevPrevPoint.y) / (nextPoint.x - prevPrevPoint.x);
    const nextSlope = (i >= points.length - 2) ? fallbackSlope : (nextNextPoint.y - prevPoint.y) / (nextNextPoint.x - prevPoint.x);
    const centerDistance = (nextPoint.x - prevPoint.x) * smoothAmount;
    const centerFromPrev = centerDistance * prevSlope + prevPoint.y;
    const centerFromNext = -centerDistance * nextSlope + nextPoint.y;
    const controlPoints: DistortionPoint[] = [
      prevPoint,
      { x: prevPoint.x + centerDistance, y: centerFromPrev },
      { x: nextPoint.x - centerDistance, y: centerFromNext },
      nextPoint,
    ];
    outPoints.push(prevPoint);
    for (let j = 0; j < innerPointCounts; j++) {
      outPoints.push(bezierPoint((j + 1) / (innerPointCounts + 1), controlPoints));
    }
  }
  outPoints.push(points[points.length - 1]);
  return outPoints;
}

/** SampleFromPointsInverse: the degree for a position, first matching segment, extrapolated past the last */
function sampleFromPointsInverse(points: DistortionPoint[], position: number): number {
  for (let i = 0; i < points.length - 1; i++) {
    if (position >= points[i].y && position <= points[i + 1].y) {
      const t = (position - points[i].y) / (points[i + 1].y - points[i].y);
      return points[i].x + t * (points[i + 1].x - points[i].x);
    }
  }
  if (position < points[0].y) {
    return points[0].x;
  }
  const i = points.length - 2;
  const t = (position - points[i].y) / (points[i + 1].y - points[i].y);
  return points[i].x + t * (points[i + 1].x - points[i].x);
}

/** the number of smoothed points the driver inserts between knots, and its radial map size */
const IN_BETWEEN_POINTS = 20;
const RADIAL_MAP_SIZE = 512;

/** RadialBezierDistortionProfile */
export class RadialBezierDistortionProfile implements DistortionProfile {
  /** radial distortions from the input image in degrees to the output image in percent, the green channel */
  distortions: DistortionPoint[] = [{ x: 0, y: 0 }, { x: 47.5, y: 100 }];
  /** additional percent distortions for the red and blue channels */
  distortionsRed: DistortionPoint[] = [{ x: 0, y: 0.5 }, { x: 47.5, y: 0.5 }];
  distortionsBlue: DistortionPoint[] = [{ x: 0, y: -0.7 }, { x: 47.5, y: -0.7 }];
  /** offset of the image outwards and upwards on the display, same 0 to 100 scale */
  offsetX = 0;
  offsetY = 0;
  legacySmoothing = false;
  smoothAmount = 0.66;
  readonly eyeRotationOffset: number;

  // the base class settings, copied from the headset config
  readonly resolution: number;
  readonly resolutionX: number;
  readonly resolutionY: number;
  readonly maxFovX: number;
  readonly maxFovY: number;
  readonly fovZoom: number;
  readonly flatFovZoom: number;
  readonly chromaticAberrationScaleRed: number;
  readonly chromaticAberrationScaleBlue: number;
  readonly fovClamping: boolean;

  // computed by initialize, half fovs of the input image in degrees
  halfFovInnerX = 0;
  halfFovOuterX = 0;
  halfFovTopY = 0;
  halfFovBottomY = 0;
  maxHalfFovX = 0;
  maxHalfFovY = 0;
  recommendedRenderWidth = 0;
  recommendedRenderHeight = 0;
  // radial maps from the output radius to the input radius, ready to compute the uv distortions
  private radialUVMapR = new Float64Array(0);
  private radialUVMapG = new Float64Array(0);
  private radialUVMapB = new Float64Array(0);
  private radialMapConversion = 0;

  /**
   * DistortionProfileConstructor::LoadDistortionProfile followed by ReInitializeProfile: take the curves
   * from the definition when they hold at least one point, copy the settings, then Initialize.
   */
  constructor(definition: DistortionProfileDefinition, settings: DistortionProfileSettings) {
    const pointsOf = (flat: number[] | undefined) => flat && flat.length >= 2 ? knotsFromFlat(flat) : undefined;
    this.distortions = pointsOf(definition.distortions) ?? this.distortions;
    this.distortionsRed = pointsOf(definition.distortionsRed) ?? this.distortionsRed;
    this.distortionsBlue = pointsOf(definition.distortionsBlue) ?? this.distortionsBlue;
    this.legacySmoothing = definition.legacySmoothing ?? false;
    this.smoothAmount = definition.smoothAmount ?? 0.66;
    this.offsetX = definition.offsetX ?? 0;
    this.offsetY = definition.offsetY ?? 0;
    this.eyeRotationOffset = definition.eyeRotationOffset ?? 0;

    this.resolution = Math.min(settings.resolutionX, settings.resolutionY);
    this.resolutionX = settings.resolutionX;
    this.resolutionY = settings.resolutionY;
    this.maxFovX = settings.maxFovX;
    this.maxFovY = settings.maxFovY;
    // avoid division by zero like ReInitializeProfile
    this.fovZoom = settings.fovZoom === 0 ? 1 : settings.fovZoom;
    this.flatFovZoom = settings.flatFovZoom;
    this.chromaticAberrationScaleRed = settings.chromaticAberrationScaleRed;
    this.chromaticAberrationScaleBlue = settings.chromaticAberrationScaleBlue;
    this.fovClamping = settings.fovClamping;
    this.initialize();
  }

  /** RadialBezierDistortionProfile::Initialize */
  private initialize(): void {
    let distortionsSmoothGreen: DistortionPoint[];
    let distortionsRedPercent: DistortionPoint[];
    let distortionsBluePercent: DistortionPoint[];
    if (this.legacySmoothing) {
      distortionsSmoothGreen = smoothPointsLegacy(this.distortions, IN_BETWEEN_POINTS, this.smoothAmount / 2);
      distortionsRedPercent = smoothPointsLegacy(this.distortionsRed, IN_BETWEEN_POINTS, this.smoothAmount / 2);
      distortionsBluePercent = smoothPointsLegacy(this.distortionsBlue, IN_BETWEEN_POINTS, this.smoothAmount / 2);
    } else {
      distortionsSmoothGreen = smoothPoints(this.distortions);
      distortionsRedPercent = smoothPoints(this.distortionsRed);
      distortionsBluePercent = smoothPoints(this.distortionsBlue);
    }

    // scale the strength of the chromatic aberration correction per channel
    distortionsRedPercent = distortionsRedPercent.map(p => ({ x: p.x, y: p.y * this.chromaticAberrationScaleRed }));
    distortionsBluePercent = distortionsBluePercent.map(p => ({ x: p.x, y: p.y * this.chromaticAberrationScaleBlue }));

    // correct for chromatic aberration: the red and blue curves are the green curve with the percent offset applied
    const distortionsSmoothRed = distortionsSmoothGreen.map(p => ({ x: p.x, y: p.y * (sampleCurve(distortionsRedPercent, p.x) / 100 + 1) }));
    const distortionsSmoothBlue = distortionsSmoothGreen.map(p => ({ x: p.x, y: p.y * (sampleCurve(distortionsBluePercent, p.x) / 100 + 1) }));
    // the copies above must not share points with the green curve, the degrees are modified in place below
    distortionsSmoothGreen = distortionsSmoothGreen.map(p => ({ x: p.x, y: p.y }));
    const curves = [distortionsSmoothRed, distortionsSmoothGreen, distortionsSmoothBlue];

    // flat fov zoom using tangent-based scaling
    if (this.flatFovZoom !== 1) {
      for (const curve of curves) {
        for (const p of curve) {
          p.x = Math.atan(Math.tan(p.x * DEG) / this.flatFovZoom) / DEG;
        }
      }
    }
    // zoom fov
    for (const curve of curves) {
      for (const p of curve) {
        p.x /= this.fovZoom;
      }
    }

    // find maximum degrees that fit all color channels on the screen
    const fit = (radius: number) => Math.min(
      sampleFromPointsInverse(distortionsSmoothRed, radius),
      sampleFromPointsInverse(distortionsSmoothGreen, radius),
      sampleFromPointsInverse(distortionsSmoothBlue, radius));
    this.halfFovOuterX = fit(this.resolutionX / this.resolution * 100 - this.offsetX);
    this.halfFovInnerX = fit(this.resolutionX / this.resolution * 100 + this.offsetX);
    this.halfFovTopY = fit(this.resolutionY / this.resolution * 100 - this.offsetY);
    this.halfFovBottomY = fit(this.resolutionY / this.resolution * 100 + this.offsetY);

    // limit to max fov
    let fovX = this.halfFovOuterX + this.halfFovInnerX;
    let fovY = this.halfFovTopY + this.halfFovBottomY;
    if (this.fovClamping) {
      fovX = Math.min(fovX, this.maxFovX);
      fovY = Math.min(fovY, this.maxFovY);
    } else {
      fovX = this.maxFovX;
      fovY = this.maxFovY;
    }
    const multiplierX = fovX / (this.halfFovOuterX + this.halfFovInnerX);
    const multiplierY = fovY / (this.halfFovTopY + this.halfFovBottomY);
    this.halfFovOuterX *= multiplierX;
    this.halfFovInnerX *= multiplierX;
    this.halfFovTopY *= multiplierY;
    this.halfFovBottomY *= multiplierY;

    // convert to input coordinates: tangent of the degrees, so the curves map output percent to input screen space
    for (const curve of curves) {
      for (const p of curve) {
        p.x = Math.tan(p.x * DEG);
      }
    }

    // tangents for the edges of the input screen
    this.maxHalfFovX = Math.max(this.halfFovOuterX, this.halfFovInnerX);
    this.maxHalfFovY = Math.max(this.halfFovTopY, this.halfFovBottomY);
    const edgeTanX = Math.tan(this.maxHalfFovX * DEG);
    const edgeTanY = Math.tan(this.maxHalfFovY * DEG);
    // the maximum output percentage for the edge of the output
    const maxOutputPercentageX = sampleCurve(distortionsSmoothGreen, edgeTanX);
    const maxOutputPercentageY = sampleCurve(distortionsSmoothGreen, edgeTanY);
    // the maximum ratio between input and output image pixels
    let maxInputOutputRatioX = 0;
    let maxInputOutputRatioY = 0;
    for (let i = 0; i < distortionsSmoothGreen.length - 1; i++) {
      const prevPoint = distortionsSmoothGreen[i];
      const nextPoint = distortionsSmoothGreen[i + 1];
      const inputOutputRatioX = (nextPoint.y - prevPoint.y) / maxOutputPercentageX / ((nextPoint.x - prevPoint.x) / edgeTanX);
      maxInputOutputRatioX = Math.max(maxInputOutputRatioX, inputOutputRatioX);
      const inputOutputRatioY = (nextPoint.y - prevPoint.y) / maxOutputPercentageY / ((nextPoint.x - prevPoint.x) / edgeTanY);
      maxInputOutputRatioY = Math.max(maxInputOutputRatioY, inputOutputRatioY);
    }
    // the resolution of the output screen that is actually used for the given fov, and the input
    // resolution required to get 1:1 distortion in the most distorted spot
    const usedOutputScreenResolutionX = maxOutputPercentageX / 100 * this.resolution;
    const usedOutputScreenResolutionY = maxOutputPercentageY / 100 * this.resolution;
    this.recommendedRenderWidth = Math.trunc(maxInputOutputRatioX * usedOutputScreenResolutionX);
    this.recommendedRenderHeight = Math.trunc(maxInputOutputRatioY * usedOutputScreenResolutionY);

    // create radial maps, reaching the corners of the screen
    let distancePastOne = Math.max(this.resolutionX, this.resolutionY) / this.resolution;
    distancePastOne *= 1.41421;
    this.radialMapConversion = RADIAL_MAP_SIZE / distancePastOne;
    this.radialUVMapR = new Float64Array(RADIAL_MAP_SIZE);
    this.radialUVMapG = new Float64Array(RADIAL_MAP_SIZE);
    this.radialUVMapB = new Float64Array(RADIAL_MAP_SIZE);
    for (let i = 0; i < RADIAL_MAP_SIZE; i++) {
      const outputRadius = i / this.radialMapConversion * 100;
      this.radialUVMapR[i] = sampleFromPointsInverse(distortionsSmoothRed, outputRadius);
      this.radialUVMapG[i] = sampleFromPointsInverse(distortionsSmoothGreen, outputRadius);
      this.radialUVMapB[i] = sampleFromPointsInverse(distortionsSmoothBlue, outputRadius);
    }
  }

  /** SampleFromMap: linear interpolation in the radial map, clamped to its ends */
  private sampleFromMap(map: Float64Array, radius: number): number {
    const indexFloat = radius * this.radialMapConversion;
    let index = Math.trunc(indexFloat);
    if (index < 0) {
      index = 0;
    } else if (index >= RADIAL_MAP_SIZE - 1) {
      index = RADIAL_MAP_SIZE - 2;
    }
    return map[index] + (indexFloat - index) * (map[index + 1] - map[index]);
  }

  getProjectionRaw(eye: Eye): ProjectionRaw {
    const hFovHalfOuter = this.halfFovOuterX * DEG;
    const hFovHalfInner = this.halfFovInnerX * DEG;
    const vFovHalfTop = this.halfFovTopY * DEG;
    const vFovHalfBottom = this.halfFovBottomY * DEG;
    return {
      left: eye === 'left' ? Math.tan(-hFovHalfOuter) : Math.tan(-hFovHalfInner),
      right: eye === 'left' ? Math.tan(hFovHalfInner) : Math.tan(hFovHalfOuter),
      bottom: Math.tan(-vFovHalfBottom),
      top: Math.tan(vFovHalfTop),
    };
  }

  computeDistortion(eye: Eye, channel: ColorChannel, fU: number, fV: number): CurvePoint {
    // offset distortions
    if (eye === 'left') {
      fU += this.offsetX / 100;
    } else {
      fU -= this.offsetX / 100;
    }
    fV += this.offsetY / 100;

    // convert to radius and unit vector
    let radius = Math.sqrt(fU * fU + fV * fV);
    let unitU = fU / radius;
    let unitV = fV / radius;
    if (!isFinite(unitU)) {
      unitU = 0;
    }
    if (!isFinite(unitV)) {
      unitV = 0;
    }

    // sample distortion map for the given radius and color channel
    switch (channel) {
      case 'red':
        radius = this.sampleFromMap(this.radialUVMapR, radius);
        break;
      case 'green':
        radius = this.sampleFromMap(this.radialUVMapG, radius);
        break;
      case 'blue':
        radius = this.sampleFromMap(this.radialUVMapB, radius);
        break;
    }

    // convert back to points, then to the eye's asymmetric frustum
    const distortion = { x: unitU * radius, y: unitV * radius };
    const outerTan = Math.tan(this.halfFovOuterX * DEG);
    const innerTan = Math.tan(this.halfFovInnerX * DEG);
    const topTan = Math.tan(this.halfFovTopY * DEG);
    const bottomTan = Math.tan(this.halfFovBottomY * DEG);
    distortion.x /= (outerTan + innerTan) / 2;
    distortion.y /= (topTan + bottomTan) / 2;
    if (eye === 'left') {
      distortion.x += (outerTan - innerTan) / (outerTan + innerTan);
    } else {
      distortion.x -= (outerTan - innerTan) / (outerTan + innerTan);
    }
    distortion.y += (topTan - bottomTan) / (topTan + bottomTan);
    return distortion;
  }

  getRecommendedRenderTargetSize(): { width: number; height: number } {
    return { width: this.recommendedRenderWidth, height: this.recommendedRenderHeight };
  }
}

/** DistortionProfileConstructor::LoadDistortionProfile: RadialBezier profiles, everything else runs as none */
export function createDistortionProfile(definition: DistortionProfileDefinition | null | undefined, settings: DistortionProfileSettings): DistortionProfile {
  if (definition && definition.type === 'RadialBezier') {
    return new RadialBezierDistortionProfile(definition, settings);
  }
  return new NoneDistortionProfile(settings);
}
