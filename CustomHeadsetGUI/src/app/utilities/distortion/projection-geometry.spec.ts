import { projectionFov, resolutionFov } from './projection-geometry';
import type { ProjectionRaw } from './radial-bezier-profile';
import type { ResolutionInfo } from '../../services/JsonFileDefines';

const projection = (left: number, right: number, bottom = -35, top = 45): ProjectionRaw => {
  const tan = (degrees: number) => Math.tan(degrees * Math.PI / 180);
  return { left: tan(left), right: tan(right), bottom: tan(bottom), top: tan(top) };
};

describe('projection FOV bounds', () => {
  it('uses both eyes when asymmetry puts the inner edges outside the opposite eye', () => {
    const result = projectionFov(projection(-40, 60), projection(-60, 40), 5);
    // Head-space intervals are [-45, 55] and [-55, 45].
    expect(result.combinedFovX).toBeCloseTo(110, 9);
    expect(result.overlap).toBeCloseTo(90, 9);
    expect(result.combinedFovY).toBeCloseTo(80, 9);
  });

  it('retains the usual result for symmetric canted eyes', () => {
    const result = projectionFov(projection(-50, 50), projection(-50, 50), 5);
    expect(result.combinedFovX).toBeCloseTo(110, 9);
    expect(result.overlap).toBeCloseTo(90, 9);
  });

  it('limits overlap to the smaller eye when one frustum contains the other', () => {
    const result = projectionFov(projection(-60, 60), projection(-30, 40), 0);
    expect(result.combinedFovX).toBeCloseTo(120, 9);
    expect(result.overlap).toBeCloseTo(70, 9);
  });

  it('reports no overlap for disjoint frustums', () => {
    expect(projectionFov(projection(-20, 20), projection(-20, 20), 30).overlap).toBe(0);
  });

  it('excludes disabled eyes, including when their render frustum was not reduced', () => {
    const left = projection(-40, 60);
    const right = projection(-60, 40, -40, 45);
    for (const disabled of [1, 2]) {
      const result = projectionFov(left, right, 5, disabled);
      expect(result.combinedFovX).toBeCloseTo(100, 9);
      expect(result.combinedFovY).toBeCloseTo(disabled === 1 ? 85 : 80, 9);
      expect(result.overlap).toBe(0);
    }
    expect(projectionFov(left, right, 5, 3)).toEqual({ combinedFovX: 0, combinedFovY: 0, overlap: 0 });
  });

  it('recomputes old driver totals from raw projections and includes the profile rotation offset', () => {
    const array = (p: ProjectionRaw) => [p.left, p.right, p.bottom, p.top];
    const res = {
      fovX: 100, combinedFovX: 90, combinedFovY: 80, eyeRotationOffset: 2,
      projectionLeft: array(projection(-40, 60)), projectionRight: array(projection(-60, 40)),
    } as ResolutionInfo;
    const result = resolutionFov(res, 3);
    expect(result.combinedFovX).toBeCloseTo(110, 9);
    expect(result.overlap).toBeCloseTo(90, 9);
  });
});
