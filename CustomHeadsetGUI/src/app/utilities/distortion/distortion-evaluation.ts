/**
 * The driver's distortion pipeline around a profile, so the GUI can produce for any headset configuration
 * and profile the same numbers the driver writes to info.json (resolution) and fovVisualization.json
 * (the panel sampling) while it runs that combination. Mirrors BaseHeadsetShim::UpdateSettings and
 * GetRecommendedRenderTargetSize, DistortionProfileConstructor::GetRecommendedRenderTargetSize and
 * FovVisualization::Write. Keep in sync with the C++ when those change.
 */
import type { ResolutionInfo } from '../../services/JsonFileDefines';
import type { FovVisualizationChannels, FovVisualizationData } from '../fov-panel-chart/fov-visualization.service';
import {
  ColorChannel, createDistortionProfile, DistortionProfile, DistortionProfileDefinition,
  DistortionProfileSettings, Eye, ProjectionRaw
} from './radial-bezier-profile';

/** the BaseHeadsetConfig fields that shape the distortion, satisfied by the settings and defaults objects */
export type DistortionHeadsetConfig = DistortionProfileSettings & {
  displayRotation: number;
  distortionZoom: number;
  eyeRotation?: number;
  disableEye?: number;
  disableEyeDecreaseFov?: boolean | number;
  fovBurnInPrevention?: boolean;
  renderResolutionMultiplierX?: number;
  renderResolutionMultiplierY?: number;
};

export type DistortionEvaluationOptions = {
  /** grid points per axis of the panel sampling, the driver samples 65; 0 skips the sampling */
  gridSize?: number;
  /**
   * the random per session shift in degrees, 0 to 3, that BaseHeadset adds to the max fov when
   * fovBurnInPrevention is on and the profile could show more than the max fov; 0 by default
   */
  fovBurnInOffset?: number;
  /** stamped into the sampling like the driver does, so charts can tell what it belongs to */
  headsetType?: number;
  distortionProfile?: string;
};

export type DistortionEvaluation = {
  /** what the driver writes to info.json resolution for this configuration */
  resolution: ResolutionInfo;
  /** what the driver writes to fovVisualization.json, undefined when the sampling was skipped */
  sampling?: FovVisualizationData;
  /** the profile the numbers were computed with */
  profile: DistortionProfile;
  /** the max fov the profile can show, info.json fovMaxX and fovMaxY */
  renderFovMaxX: number;
  renderFovMaxY: number;
};

/** the driver samples this many points per axis and eye for the panel angle map */
export const DRIVER_SAMPLING_GRID_SIZE = 65;

const DEG = Math.PI / 180;

/** SetDisplayProjectionRaw order: [left, right, bottom, top] tangents */
function toArray(p: ProjectionRaw): number[] {
  return [p.left, p.right, p.bottom, p.top];
}

function horizontalFov(p: ProjectionRaw): number {
  return (Math.atan(p.right) - Math.atan(p.left)) / DEG;
}

function verticalFov(p: ProjectionRaw): number {
  return (Math.atan(p.top) - Math.atan(p.bottom)) / DEG;
}

/** the C++ casts to uint32_t, which truncates */
function toUint32(value: number): number {
  return Math.trunc(value);
}

/**
 * FovVisualization::SampleChannel: one eye and channel over the viewport into a flat [x0, y0, x1, y1, ...]
 * array of render texture coordinates in [-1, 1]. This mirrors BaseHeadsetShim::PreDisplayComponentComputeDistortion
 * / transformUV without the subpixel offsets: the aspect scaling comes after the rotation, on the panel-native axes.
 */
function sampleChannel(profile: DistortionProfile, config: DistortionHeadsetConfig, eye: Eye, channel: ColorChannel, gridSize: number): number[] {
  const samples: number[] = [];
  const minResolution = Math.min(config.resolutionX, config.resolutionY);
  const distortionZoom = config.distortionZoom;
  const displayRotation = config.displayRotation;
  for (let j = 0; j < gridSize; j++) {
    for (let i = 0; i < gridSize; i++) {
      let u = (i / (gridSize - 1) - 0.5) * 2;
      let v = (j / (gridSize - 1) - 0.5) * 2;
      if (displayRotation === 1 || displayRotation === 3) {
        if (eye === 'left') {
          const tmp = u;
          u = -v;
          v = tmp;
        } else {
          const tmp = u;
          u = v;
          v = -tmp;
        }
      }
      if (displayRotation === 2 || displayRotation === 3) {
        u *= -1;
        v *= -1;
      }
      u *= config.resolutionX / minResolution;
      v *= config.resolutionY / minResolution;
      u /= distortionZoom;
      v /= distortionZoom;
      const distortion = profile.computeDistortion(eye, channel, u, v);
      samples.push(distortion.x, distortion.y);
    }
  }
  return samples;
}

function sampleEye(profile: DistortionProfile, config: DistortionHeadsetConfig, eye: Eye, gridSize: number): FovVisualizationChannels {
  return {
    red: sampleChannel(profile, config, eye, 'red', gridSize),
    green: sampleChannel(profile, config, eye, 'green', gridSize),
    blue: sampleChannel(profile, config, eye, 'blue', gridSize),
  };
}

/**
 * Run the driver's distortion setup for a profile on a headset configuration. The definition is a
 * built-in profile from info.json or a parsed profile file; null or a non RadialBezier type runs the
 * none profile like the driver does when a profile can not be loaded.
 */
export function evaluateDistortion(definition: DistortionProfileDefinition | null | undefined,
  config: DistortionHeadsetConfig, options: DistortionEvaluationOptions = {}): DistortionEvaluation {
  const gridSize = options.gridSize ?? DRIVER_SAMPLING_GRID_SIZE;
  const settings: DistortionProfileSettings = {
    resolutionX: config.resolutionX,
    resolutionY: config.resolutionY,
    maxFovX: config.maxFovX,
    maxFovY: config.maxFovY,
    fovZoom: config.fovZoom,
    flatFovZoom: config.flatFovZoom,
    chromaticAberrationScaleRed: config.chromaticAberrationScaleRed,
    chromaticAberrationScaleBlue: config.chromaticAberrationScaleBlue,
    fovClamping: config.fovClamping,
  };

  // "get max fov from the new profile": a second instance clamped to 170 degrees. When FOV clamping is
  // disabled on the main profile the driver keeps it enabled here and multiplies by 1.1 to approximate
  // the unclamped profile.
  const maxFovProfile = createDistortionProfile(definition, { ...settings, maxFovX: 170, maxFovY: 170, fovClamping: true });
  const maxFovProjection = maxFovProfile.getProjectionRaw('left');
  let renderFovMaxX = horizontalFov(maxFovProjection);
  let renderFovMaxY = verticalFov(maxFovProjection);
  if (!config.fovClamping) {
    renderFovMaxX *= 1.1;
    renderFovMaxY *= 1.1;
  }

  // fov burn-in prevention shifts the max fov by a per session random amount, only as far as the profile allows
  const fovBurnInOffset = options.fovBurnInOffset ?? 0;
  if (config.fovBurnInPrevention && fovBurnInOffset > 0) {
    settings.maxFovX += Math.max(Math.min(renderFovMaxX - config.maxFovX, fovBurnInOffset), 0);
    settings.maxFovY += Math.max(Math.min(renderFovMaxY - config.maxFovY, fovBurnInOffset), 0);
  }

  const profile = createDistortionProfile(definition, settings);
  const rawLeft = profile.getProjectionRaw('left');
  let left: ProjectionRaw = { ...rawLeft };
  let right: ProjectionRaw = profile.getProjectionRaw('right');
  // a disabled eye with disableEyeDecreaseFov gets a degenerate frustum
  const disableEye = config.disableEye ?? 0;
  if ((disableEye & 1) && config.disableEyeDecreaseFov) {
    left = { left: -0.000001, right: 0.000001, bottom: -0.000001, top: 0.000001 };
  }
  if ((disableEye & 2) && config.disableEyeDecreaseFov) {
    right = { left: 0.000001, right: -0.000001, bottom: -0.000001, top: 0.000001 };
  }

  // combined fov from the full span of both eyes' clip planes, including eye rotation
  const eyeRotation = config.eyeRotation ?? 0;
  const combinedFovX = (Math.atan(right.right) - Math.atan(left.left)) / DEG + eyeRotation * 2 + profile.eyeRotationOffset * 2;
  const combinedFovY = verticalFov(left);

  // DistortionProfileConstructor::GetRecommendedRenderTargetSize keeps the number of pixels of the panel
  // but takes the aspect ratio of the profile's 1:1 size, then BaseHeadset applies the multipliers
  const originalWidth = toUint32(config.resolutionX);
  const originalHeight = toUint32(config.resolutionY);
  const oneToOne = profile.getRecommendedRenderTargetSize();
  let renderWidth = oneToOne ? oneToOne.width : originalWidth;
  let renderHeight = oneToOne ? oneToOne.height : originalHeight;
  const targetPixels = originalWidth * originalHeight;
  const renderPixels = renderWidth * renderHeight;
  renderWidth = toUint32(renderWidth * Math.sqrt(targetPixels / renderPixels));
  renderHeight = toUint32(renderHeight * Math.sqrt(targetPixels / renderPixels));
  renderWidth = Math.min(renderWidth, 16384);
  renderHeight = Math.min(renderHeight, 16384);
  renderWidth = toUint32(renderWidth * (config.renderResolutionMultiplierX ?? 1));
  renderHeight = toUint32(renderHeight * (config.renderResolutionMultiplierY ?? 1));
  // the none profile leaves the 1:1 size untouched, a fresh driver reports 0 there
  const oneToOneWidth = oneToOne ? oneToOne.width : 0;
  const oneToOneHeight = oneToOne ? oneToOne.height : 0;
  const requiredPercentX = (oneToOneWidth * oneToOneWidth) / (renderWidth * renderWidth);
  const requiredPercentY = (oneToOneHeight * oneToOneHeight) / (renderHeight * renderHeight);

  const resolution: ResolutionInfo = {
    // the render fov is taken from the profile's left eye before the disabled eye handling
    fovX: horizontalFov(rawLeft),
    fovY: verticalFov(rawLeft),
    fovMaxX: renderFovMaxX,
    fovMaxY: renderFovMaxY,
    combinedFovX,
    combinedFovY,
    projectionLeft: toArray(left),
    projectionRight: toArray(right),
    eyeRotationOffset: profile.eyeRotationOffset,
    renderResolution1To1X: oneToOneWidth,
    renderResolution1To1Y: oneToOneHeight,
    renderResolution1To1Percent: Math.max(requiredPercentX, requiredPercentY) * 100,
    renderResolution100PercentX: renderWidth,
    renderResolution100PercentY: renderHeight,
  };

  let sampling: FovVisualizationData | undefined;
  if (gridSize > 1) {
    let viewportWidth = config.resolutionX;
    let viewportHeight = config.resolutionY;
    if (config.displayRotation === 1 || config.displayRotation === 3) {
      [viewportWidth, viewportHeight] = [viewportHeight, viewportWidth];
    }
    sampling = {
      headsetType: options.headsetType,
      distortionProfile: options.distortionProfile,
      gridSize,
      displayRotation: config.displayRotation,
      viewportWidth,
      viewportHeight,
      // the profiles the GUI evaluates keep their frame on the optical axis
      opticalAxisLeft: [0, 0],
      opticalAxisRight: [0, 0],
      left: sampleEye(profile, config, 'left', gridSize),
      right: sampleEye(profile, config, 'right', gridSize),
    };
  }

  return { resolution, sampling, profile, renderFovMaxX, renderFovMaxY };
}
