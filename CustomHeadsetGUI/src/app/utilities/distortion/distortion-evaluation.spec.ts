import { ResolutionInfo } from '../../services/JsonFileDefines';
import { FovVisualizationChannels, FovVisualizationData } from '../fov-panel-chart/fov-visualization.service';
import { evaluateDistortion } from './distortion-evaluation';
import { NoneDistortionProfile, RadialBezierDistortionProfile } from './radial-bezier-profile';
import liveFixture from './fixtures/crystal-super-50ppd-default.json';
import harnessFixture from './fixtures/driver-harness-cases.json';

/**
 * The fixtures are what the driver computed for the same inputs: crystal-super-50ppd-default.json was
 * recorded from a real session (info.json resolution and fovVisualization.json), driver-harness-cases.json
 * comes from tools/distortion-fixtures/harness.cpp, which runs the driver's own profile and sampling code
 * over cases covering the other code paths. Regenerate both when the C++ distortion code changes.
 *
 * Tolerances: the driver computes in single precision, this port in double. That is invisible in the
 * projections and grids (differences of 1e-7 and 1e-4, the recorded grid is quantized to 1e-4), except
 * where a value is extrapolated far past the profile's last knot, like the natural fov of a profile
 * whose panel edge lies beyond its calibration: one float ulp in a knot moves that fov by 1.5e-4
 * degrees, so it can be off by a few 1e-3. A real porting error shows up at 0.1 degrees or 1e-2 UV.
 */
const FOV_TOLERANCE_DEGREES = 0.01;
const PROJECTION_TOLERANCE = 1e-4;
const GRID_TOLERANCE = 1e-3;
const RENDER_SIZE_TOLERANCE_PIXELS = 1;
const RENDER_PERCENT_TOLERANCE = 0.05;

type SamplingExpectation = {
  gridSize: number;
  /** the harness keeps every stride-th grid point of the driver's grid, the live recording keeps all */
  sampleStride?: number;
  displayRotation: number;
  viewportWidth: number;
  viewportHeight: number;
  left: FovVisualizationChannels;
  right: FovVisualizationChannels;
};

function expectClose(actual: number, expected: number, tolerance: number, what: string): void {
  expect(Math.abs(actual - expected)).withContext(`${what}: got ${actual}, driver ${expected}`).toBeLessThanOrEqual(tolerance);
}

function expectResolution(actual: ResolutionInfo, expected: ResolutionInfo): void {
  for (const key of ['fovX', 'fovY', 'fovMaxX', 'fovMaxY', 'combinedFovX', 'combinedFovY'] as const) {
    expectClose(actual[key], expected[key], FOV_TOLERANCE_DEGREES, key);
  }
  expectClose(actual.eyeRotationOffset ?? 0, expected.eyeRotationOffset ?? 0, 1e-9, 'eyeRotationOffset');
  for (const key of ['projectionLeft', 'projectionRight'] as const) {
    const got = actual[key]!;
    const want = expected[key]!;
    expect(got.length).toBe(4);
    for (let i = 0; i < 4; i++) {
      expectClose(got[i], want[i], PROJECTION_TOLERANCE, `${key}[${i}]`);
    }
  }
  for (const key of ['renderResolution1To1X', 'renderResolution1To1Y', 'renderResolution100PercentX', 'renderResolution100PercentY'] as const) {
    expectClose(actual[key], expected[key], RENDER_SIZE_TOLERANCE_PIXELS, key);
  }
  expectClose(actual.renderResolution1To1Percent, expected.renderResolution1To1Percent, RENDER_PERCENT_TOLERANCE, 'renderResolution1To1Percent');
}

/** compare the sampling at the grid points the expectation kept, and report the worst difference */
function expectSampling(actual: FovVisualizationData | undefined, expected: SamplingExpectation): void {
  expect(actual).withContext('sampling').toBeDefined();
  if (!actual) {
    return;
  }
  expect(actual.gridSize).toBe(expected.gridSize);
  expect(actual.displayRotation).toBe(expected.displayRotation);
  expect(actual.viewportWidth).toBe(expected.viewportWidth);
  expect(actual.viewportHeight).toBe(expected.viewportHeight);
  const stride = expected.sampleStride ?? 1;
  const size = expected.gridSize;
  let worst = 0;
  let worstWhere = '';
  for (const eye of ['left', 'right'] as const) {
    for (const channel of ['red', 'green', 'blue'] as const) {
      const got = actual[eye][channel];
      const want = expected[eye][channel];
      expect(got.length).withContext(`${eye}.${channel} length`).toBe(size * size * 2);
      let k = 0;
      for (let j = 0; j < size; j += stride) {
        for (let i = 0; i < size; i += stride) {
          const index = (j * size + i) * 2;
          for (const axis of [0, 1]) {
            const difference = Math.abs(got[index + axis] - want[k + axis]);
            if (!(difference <= worst)) {
              worst = difference;
              worstWhere = `${eye}.${channel} at grid (${i}, ${j}) axis ${axis}: got ${got[index + axis]}, driver ${want[k + axis]}`;
            }
          }
          k += 2;
        }
      }
      expect(want.length).withContext(`${eye}.${channel} expectation length`).toBe(k);
    }
  }
  expect(worst).withContext(`worst sampling difference ${worstWhere}`).toBeLessThanOrEqual(GRID_TOLERANCE);
}

describe('evaluateDistortion', () => {
  it('reproduces the info.json and fovVisualization.json of a live Crystal Super 50PPD session', () => {
    const result = evaluateDistortion(liveFixture.profile, liveFixture.config, {
      headsetType: liveFixture.headsetType,
      distortionProfile: liveFixture.profileName,
    });
    expect(result.profile).toBeInstanceOf(RadialBezierDistortionProfile);
    expectResolution(result.resolution, liveFixture.expected.resolution);
    expectSampling(result.sampling, liveFixture.expected.sampling);
    expect(result.sampling?.headsetType).toBe(liveFixture.headsetType);
    expect(result.sampling?.distortionProfile).toBe(liveFixture.profileName);
  });

  for (const testCase of harnessFixture.cases) {
    it(`matches the driver code for ${testCase.name}`, () => {
      const result = evaluateDistortion(testCase.profile, testCase.config);
      expectResolution(result.resolution, testCase.expected.resolution);
      expectSampling(result.sampling, testCase.expected.sampling);
    });
  }

  it('runs the none profile for unknown profile types and missing profiles, like the driver', () => {
    const config = { ...harnessFixture.cases[0].config, fovZoom: 1 };
    for (const definition of [null, undefined, { type: 'Pimax' }, {}]) {
      const result = evaluateDistortion(definition, config, { gridSize: 0 });
      expect(result.profile).toBeInstanceOf(NoneDistortionProfile);
      // 95 degrees symmetric, no distortion, no 1:1 opinion
      expectClose(result.resolution.fovX, 95, 1e-9, 'none fovX');
      expectClose(result.resolution.combinedFovY, 95, 1e-9, 'none fovY');
      expect(result.resolution.projectionLeft).toEqual(result.resolution.projectionRight);
      expect(result.resolution.renderResolution1To1X).toBe(0);
      expect(result.resolution.renderResolution100PercentX).toBe(config.resolutionX);
      expect(result.sampling).toBeUndefined();
    }
  });

  it('applies the burn-in prevention shift only up to what the profile can show', () => {
    const testCase = harnessFixture.cases.find(c => c.name === 'crystal-super-50ppd-zooms')!;
    // this case is clamped by its max fov of 100 degrees while the profile could show more
    const config = { ...testCase.config, fovBurnInPrevention: true };
    const base = evaluateDistortion(testCase.profile, config, { gridSize: 0 }).resolution;
    expect(base.fovMaxX).toBeGreaterThan(config.maxFovX + 3);
    const shifted = evaluateDistortion(testCase.profile, config, { gridSize: 0, fovBurnInOffset: 2 }).resolution;
    expectClose(shifted.fovX, base.fovX + 2, FOV_TOLERANCE_DEGREES, 'burn-in shifted fovX');
    // without the setting the offset is ignored
    const ignored = evaluateDistortion(testCase.profile, { ...config, fovBurnInPrevention: false }, { gridSize: 0, fovBurnInOffset: 2 }).resolution;
    expectClose(ignored.fovX, base.fovX, 1e-9, 'burn-in ignored fovX');
  });
});
