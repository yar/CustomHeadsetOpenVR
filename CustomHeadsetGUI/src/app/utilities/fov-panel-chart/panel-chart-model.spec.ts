import { DistortionHeadsetConfig, evaluateDistortion } from '../distortion/distortion-evaluation';
import { DistortionProfileDefinition } from '../distortion/radial-bezier-profile';
import harnessFixture from '../distortion/fixtures/driver-harness-cases.json';
import { projectionFromResolution } from '../fov-chart/fov-geometry';
import { findCenter, parseGrid, SeenSpaceMapping } from './panel-geometry';
import { drawPanelGrid, forwardLookDirection, panelDirectionSpot, panelHamPath, panelMapping, panelOpticalAxis } from './panel-chart-model';

function expectClose(actual: number, expected: number, tolerance: number, what: string): void {
  expect(Math.abs(actual - expected)).withContext(`${what}: got ${actual}, expected ${expected}`).toBeLessThanOrEqual(tolerance);
}

describe('findCenter', () => {
  const size = 65;
  const buildField = (value: (i: number, j: number) => number): Float64Array => {
    const field = new Float64Array(size * size);
    for (let j = 0; j < size; j++) {
      for (let i = 0; i < size; i++) {
        field[j * size + i] = value(i, j);
      }
    }
    return field;
  };

  it('places the minimum of a cone shaped field between the nodes', () => {
    // like a view angle field: the value grows linearly away from the minimum. The kink at the
    // minimum breaks a parabolic fit, whose result would sit up to a fifth of a node too close to
    // the node; phases near the node, near the cell middle, and in between
    for (const [x, y] of [[32.8, 31.06], [30.5, 33.25], [31.98, 32.6]]) {
      const found = findCenter(buildField((i, j) => Math.hypot(1.3 * (i - x), 0.9 * (j - y))), size);
      expectClose(found.x, x, 5e-3, `cone x for minimum at ${x}, ${y}`);
      expectClose(found.y, y, 5e-3, `cone y for minimum at ${x}, ${y}`);
    }
  });

  it('places the minimum of a smooth symmetric field between the nodes', () => {
    const found = findCenter(buildField((i, j) => (i - 32.8) ** 2 + (j - 31.25) ** 2), size);
    expectClose(found.x, 32.8, 5e-2, 'parabola x');
    expectClose(found.y, 31.25, 5e-2, 'parabola y');
  });

  it('stays on the node when the minimum sits on the grid edge', () => {
    expect(findCenter(buildField((i, j) => Math.hypot(i, j)), size)).toEqual({ x: 0, y: 0 });
  });
});

/**
 * The optical axis cross and the forward look spot must land where the evaluated profile puts them:
 * the axis cross on the distortion center the profile documents with offsetX/offsetY (percent of the
 * half height), the forward spot at the radius the green channel maps the forward direction to. The
 * "like Pimax" profiles of the Dream Air and the Crystal Super micro-OLED pin this at two different
 * sub cell phases, and both draw a 2 degree axis to forward separation with their tabs' default
 * settings, so the drawn separations must also match each other.
 */
describe('panel angle map markers', () => {
  // "Dream Air like Pimax" as DistortionProfileConstructor.cpp defines it, the offsets through
  // float32 like the driver serializes them; the harness fixture only pins the Dream Air Default
  const dreamAirLikePimax: DistortionProfileDefinition = {
    type: 'RadialBezier',
    offsetX: Math.fround(-2.71),
    offsetY: Math.fround(0.9),
    eyeRotationOffset: 0,
    distortions: [
      0.00, 0.000, 2.50, 6.420, 5.00, 12.869, 10.0, 25.641, 15.0, 38.185, 20.0, 50.377, 25.0, 62.062,
      30.0, 73.145, 35.0, 83.496, 40.0, 93.232, 45.0, 102.044, 47.5, 105.735, 50.0, 108.985,
      52.5, 111.722, 55.0, 114.836],
    distortionsRed: [
      0.00, 0.30, 5.00, 0.33, 10.0, 0.37, 15.0, 0.40, 20.0, 0.42, 25.0, 0.44, 30.0, 0.46, 35.0, 0.46,
      40.0, 0.48, 45.0, 0.48, 50.0, 0.48, 55.0, 0.60],
    distortionsBlue: [
      0.00, -0.20, 5.00, -0.24, 10.0, -0.28, 15.0, -0.32, 20.0, -0.36, 25.0, -0.39, 30.0, -0.48,
      35.0, -0.59, 40.0, -0.67, 45.0, -0.68, 50.0, -0.68, 55.0, -0.71],
  };

  const dreamAirCase = harnessFixture.cases.find(c => c.name === 'dream-air-default')!;
  const crystalCase = harnessFixture.cases.find(c => c.name === 'crystal-super-micro-oled-like-pimax')!;
  // the dream air case config is that tab's default settings already; the crystal case pins the
  // profile's recommended values, the tab defaults differ (Config.h: max fov 98x88, eye rotation 3)
  const entries: { name: string; definition: DistortionProfileDefinition; config: DistortionHeadsetConfig }[] = [
    { name: 'Dream Air like Pimax', definition: dreamAirLikePimax, config: dreamAirCase.config },
    {
      name: 'Crystal Super micro-OLED like Pimax', definition: crystalCase.profile,
      config: { ...crystalCase.config, maxFovX: 98, maxFovY: 88, eyeRotation: 3 },
    },
  ];

  /** the drawn markers must sit on the profile geometry within a hairline of the half height */
  const MARKER_TOLERANCE = 5e-4;

  /** draw the markers of one eye and derive where the profile's own math places them */
  function measureMarkers(definition: DistortionProfileDefinition, config: DistortionHeadsetConfig, isRight: boolean) {
    const evaluation = evaluateDistortion(definition, config);
    const sampling = evaluation.sampling!;
    const resolution = evaluation.resolution;
    const channels = isRight ? sampling.right! : sampling.left!;
    const projection = projectionFromResolution(isRight ? resolution.projectionRight : resolution.projectionLeft,
      resolution.fovX, resolution.fovY)!;
    const grid = parseGrid(channels.green, sampling.gridSize)!;
    const mapping = panelMapping(sampling, isRight);
    const yaw = (config.eyeRotation ?? 0) + (resolution.eyeRotationOffset ?? 0);
    const forwardDirection = forwardLookDirection(isRight, yaw);
    const drawing = drawPanelGrid(grid, projection, mapping, false, panelOpticalAxis(sampling, isRight));
    const forward = panelDirectionSpot(grid, projection, mapping, forwardDirection);
    expect(forward).withContext('the forward direction lies on the panel').not.toBeNull();

    // the axis cross belongs on the distortion center, the spot computeDistortion maps radius 0 to,
    // in seen space with y down like the drawing
    const axisU = (isRight ? 1 : -1) * (definition.offsetX ?? 0) / 100;
    const axisV = -(definition.offsetY ?? 0) / 100;
    const truthCenter = { x: axisU * config.distortionZoom, y: axisV * config.distortionZoom };
    // the forward spot belongs where the green channel shows the forward direction: bisect along the
    // horizontal through the axis for the spot whose tangent is the forward direction's
    const tangentXAt = (fU: number) => {
      const texture = evaluation.profile.computeDistortion(isRight ? 'right' : 'left', 'green', fU, axisV);
      return projection.left + (projection.right - projection.left) * (texture.x * 0.5 + 0.5);
    };
    let low = -0.3;
    let high = 0.3;
    for (let n = 0; n < 60; n++) {
      const mid = (low + high) / 2;
      if (tangentXAt(axisU + mid) < forwardDirection.x) {
        low = mid;
      } else {
        high = mid;
      }
    }
    const truthForwardX = (axisU + (low + high) / 2) * config.distortionZoom;
    return { center: drawing.center, forward: forward!, truthCenter, truthForwardX, yaw };
  }

  for (const entry of entries) {
    it(`puts the markers of ${entry.name} on the profile's documented geometry`, () => {
      for (const isRight of [false, true]) {
        const eye = isRight ? 'right' : 'left';
        const markers = measureMarkers(entry.definition, entry.config, isRight);
        expect(markers.yaw).withContext('both profiles are captured at a 2 degree cant').toBe(2);
        expectClose(markers.center.x, markers.truthCenter.x, MARKER_TOLERANCE, `${eye} axis cross x`);
        expectClose(markers.center.y, markers.truthCenter.y, MARKER_TOLERANCE, `${eye} axis cross y`);
        expectClose(markers.forward.x, markers.truthForwardX, MARKER_TOLERANCE, `${eye} forward x`);
        expectClose(markers.forward.y, markers.truthCenter.y, MARKER_TOLERANCE, `${eye} forward y`);
      }
    });
  }

  it('draws the same 2 degree axis to forward separation for both entries', () => {
    const separations = entries.map(entry => {
      const markers = measureMarkers(entry.definition, entry.config, false);
      return Math.abs(markers.forward.x - markers.center.x);
    });
    // r(2 degrees) of the nearly identical distortion tables, about 5.1 percent of the half height
    expect(separations[0]).toBeGreaterThan(0.045);
    expect(separations[0]).toBeLessThan(0.058);
    expect(Math.abs(separations[0] - separations[1]) / separations[0])
      .withContext(`separations ${separations.join(' vs ')}`).toBeLessThanOrEqual(0.01);
  });
});

describe('panelHamPath', () => {
  it('keeps the hidden area cut inside the rendered area', () => {
    const size = 33;
    // a synthetic square panel showing render texture coordinates -1.5 to 1.5, so the rendered
    // area covers the middle two thirds and the samples extrapolate beyond its boundary. The
    // corner cut field would continue out there, but nothing may be drawn past two thirds.
    const x = new Float64Array(size * size);
    const y = new Float64Array(size * size);
    for (let j = 0; j < size; j++) {
      for (let i = 0; i < size; i++) {
        x[j * size + i] = -1.5 + 3 * i / (size - 1);
        y[j * size + i] = -1.5 + 3 * j / (size - 1);
      }
    }
    const ham = { radiusTopOuter: 0.25, radiusTopInner: 0.25, radiusBottomInner: 0.25, radiusBottomOuter: 0.25 };
    const path = panelHamPath({ size, x, y }, false, ham, new SeenSpaceMapping(size, 0, false, 100, 100));
    const coordinates = path.match(/-?\d+\.\d+/g)!.map(Number);
    expect(coordinates.length).withContext('the corner arcs are drawn').toBeGreaterThan(0);
    for (const coordinate of coordinates) {
      expect(Math.abs(coordinate)).toBeLessThanOrEqual(2 / 3);
    }
  });
});
