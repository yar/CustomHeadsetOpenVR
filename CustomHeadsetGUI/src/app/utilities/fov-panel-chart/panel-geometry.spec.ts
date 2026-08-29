import { contourSegments, segmentsToSvgPath, SeenSpaceMapping } from './panel-geometry';

/** a field that only depends on the column, so its contours are vertical lines */
const columnField = (size: number, value: (i: number) => number): Float64Array =>
  Float64Array.from({ length: size * size }, (_, n) => value(n % size));

/**
 * The path must chain the per cell marching squares segments into polylines: the SVG dash pattern
 * restarts at every M, so a path of per cell subpaths dashes each grid cell separately, with dash
 * lengths that vary with how each cell happens to be crossed.
 */
describe('segmentsToSvgPath', () => {
  const mapping = (size: number) => new SeenSpaceMapping(size, 0, false, 100, 100);

  it('chains the per cell segments of a contour into one polyline', () => {
    const size = 3;
    const segments = contourSegments(columnField(size, i => i - 1.5), size, 0);
    expect(segments.length).withContext('one segment of 4 numbers per crossed cell').toBe(8);
    const path = segmentsToSvgPath(segments, mapping(size));
    expect(path.match(/M/g)!.length).toBe(1);
    expect(path.match(/L/g)!.length).toBe(2);
  });

  it('closes a loop into a single polyline ending on its first point', () => {
    const size = 5;
    // Chebyshev distance from the grid center, its contour at 1.5 rings the center as a closed loop
    const field = Float64Array.from({ length: size * size },
      (_, n) => Math.max(Math.abs(n % size - 2), Math.abs(Math.floor(n / size) - 2)));
    const path = segmentsToSvgPath(contourSegments(field, size, 1.5), mapping(size));
    expect(path.match(/M/g)!.length).toBe(1);
    expect(path.match(/L/g)!.length).toBe(12);
    const points = path.slice(1).split('L');
    expect(points[points.length - 1]).toBe(points[0]);
  });

  it('keeps disjoint contour lines as separate polylines', () => {
    const size = 5;
    const segments = contourSegments(columnField(size, i => (i - 0.75) * (3.25 - i)), size, 0);
    const path = segmentsToSvgPath(segments, mapping(size));
    expect(path.match(/M/g)!.length).toBe(2);
    expect(path.match(/L/g)!.length).toBe(8);
  });
});
