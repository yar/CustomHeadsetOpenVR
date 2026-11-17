import { RadialBezierDistortionProfile } from './radial-bezier-profile';

describe('asymmetric 1:1 render resolution', () => {
  const settings = { resolutionX: 2800, resolutionY: 2800, maxFovX: 170, maxFovY: 170, fovZoom: 1, flatFovZoom: 1, fovClamping: true, chromaticAberrationScaleRed: 1, chromaticAberrationScaleBlue: 1 };
  const definition = { type: 'RadialBezier', distortions: [0, 0, 45, 100], distortionsRed: [0, 0, 45, 0], distortionsBlue: [0, 0, 45, 0] };

  for (const offsets of [{ offsetX: 20, offsetY: 0 }, { offsetX: 0, offsetY: -15 }, { offsetX: -20, offsetY: 15 }]) {
    it(`preserves sampling density with offsets ${offsets.offsetX}, ${offsets.offsetY}`, () => {
      const symmetric = new RadialBezierDistortionProfile(definition, settings);
      const asymmetric = new RadialBezierDistortionProfile({ ...definition, ...offsets }, settings);
      const p0 = symmetric.getProjectionRaw('left');
      const size0 = symmetric.getRecommendedRenderTargetSize();
      const p = asymmetric.getProjectionRaw('left');
      const size = asymmetric.getRecommendedRenderTargetSize();
      // Moving the optical center changes the frustum, not the curve's required pixel density.
      const density = size0.width / (p0.right - p0.left);
      expect(Math.abs(size.width - density * (p.right - p.left))).toBeLessThan(2);
      expect(Math.abs(size.height - density * (p.top - p.bottom))).toBeLessThan(2);
      const mirrored = new RadialBezierDistortionProfile({ ...definition, offsetX: -offsets.offsetX, offsetY: -offsets.offsetY }, settings);
      expect(mirrored.getRecommendedRenderTargetSize()).toEqual(size);
    });
  }

  it('keeps the symmetric square profile square', () => {
    const profile = new RadialBezierDistortionProfile(definition, settings);
    const size = profile.getRecommendedRenderTargetSize();
    expect(size.width).toBe(size.height);
    expect(size.width).toBeGreaterThan(settings.resolutionX);
  });
});
