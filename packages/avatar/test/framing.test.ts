import { describe, expect, it } from 'vitest';
import { boundsAround, isFiniteBounds, solveFrame, unionBounds } from '../src/framing.js';
import type { Bounds, FrameRequest, FrameSolution } from '../src/framing.js';

const DEG2RAD = Math.PI / 180;

/** A box of total height 1.7 m and half-width `halfWidth`, sitting on y = 0. */
const tall = (halfWidth: number): Bounds => ({
  minX: -halfWidth,
  minY: 0,
  minZ: -halfWidth,
  maxX: halfWidth,
  maxY: 1.7,
  maxZ: halfWidth,
});

/** The request shape the engine hands us for a 1.7 m subject. */
const base = (over: Partial<FrameRequest> = {}): FrameRequest => ({
  bounds: tall(0.2),
  fitFraction: 0.8,
  fovDeg: 27,
  aspect: 1.5,
  anchorY: 0.62,
  anchorX: 0.5,
  ...over,
});

/**
 * A verbatim transcription of what `AvatarEngine._computeFraming()` did before
 * this module existed. Used to prove the extracted maths has not drifted.
 */
function engineFraming(
  bounds: Bounds,
  fitFraction: number,
  fovDeg: number,
  aspect: number,
  anchorY: number,
  anchorX: number,
) {
  const height = Math.max(0.2, bounds.maxY - bounds.minY);
  const centerY = (bounds.minY + bounds.maxY) / 2;
  const visibleHeight = height / fitFraction;
  const distance = visibleHeight / 2 / Math.tan((fovDeg * DEG2RAD) / 2);
  const lookAtY = centerY + (anchorY - 0.5) * visibleHeight;
  const visibleWidth = visibleHeight * aspect;
  const homeX = (anchorX - 0.5) * visibleWidth;
  return { distance, lookAtY, visibleHeight, visibleWidth, homeX };
}

function expectFiniteSolution(solution: FrameSolution): void {
  for (const value of [
    solution.distance,
    solution.lookAtY,
    solution.visibleHeight,
    solution.visibleWidth,
    solution.homeX,
    solution.centerX,
  ]) {
    expect(Number.isFinite(value)).toBe(true);
  }
}

describe('solveFrame — engine parity', () => {
  it('reproduces the pre-refactor _computeFraming numbers for a tall box', () => {
    const solution = solveFrame(base());

    // Literal expectations computed from the old engine formula.
    expect(solution.distance).toBeCloseTo(4.425631005721068, 12);
    expect(solution.visibleHeight).toBeCloseTo(2.125, 12);
    expect(solution.visibleWidth).toBeCloseTo(3.1875, 12);
    expect(solution.lookAtY).toBeCloseTo(1.105, 12);
    expect(solution.homeX).toBeCloseTo(0, 12);
    expect(solution.centerX).toBeCloseTo(0, 12);
  });

  it('matches a verbatim copy of the old engine formula, field by field', () => {
    const cases: Array<[number, number, number, number, number]> = [
      // halfWidth, fitFraction, fovDeg, aspect, anchorX
      [0.2, 0.8, 27, 1.5, 0.5],
      [0.35, 0.82, 30, 1.6, 0.28],
      [0.15, 1, 45, 0.75, 0.72],
      [0.4, 0.5, 20, 2.4, 0.91],
    ];

    for (const [halfWidth, fitFraction, fovDeg, aspect, anchorX] of cases) {
      const bounds = tall(halfWidth);
      const anchorY = 0.62;
      const solution = solveFrame({
        bounds,
        fitFraction,
        fovDeg,
        aspect,
        anchorY,
        anchorX,
      });
      const expected = engineFraming(bounds, fitFraction, fovDeg, aspect, anchorY, anchorX);

      // Every case is narrow enough that the vertical constraint dominates, so
      // the whole solution must equal the engine's numbers exactly.
      expect(solution.distance).toBeCloseTo(expected.distance, 12);
      expect(solution.lookAtY).toBeCloseTo(expected.lookAtY, 12);
      expect(solution.visibleHeight).toBeCloseTo(expected.visibleHeight, 12);
      expect(solution.visibleWidth).toBeCloseTo(expected.visibleWidth, 12);
      expect(solution.homeX).toBeCloseTo(expected.homeX, 12);
    }
  });
});

describe('solveFrame — horizontal fit', () => {
  it('pushes the camera back for a wide (arms-out) box vs the same-height narrow box', () => {
    const narrow = solveFrame(base({ bounds: tall(0.2) })); // 0.4 m wide
    const wide = solveFrame(base({ bounds: tall(1.8) })); // 3.6 m wide, same height

    expect(wide.distance).toBeGreaterThan(narrow.distance);
    // The wide box is limited by width; the narrow one by height.
    expect(wide.distance).toBeCloseTo(6.247949655135626, 12);
    expect(narrow.distance).toBeCloseTo(4.425631005721068, 12);
  });

  it('equals the max of the vertical and horizontal distances', () => {
    const request = base({ bounds: tall(1.8) });
    const solution = solveFrame(request);

    const tanHalfVertical = Math.tan((request.fovDeg * DEG2RAD) / 2);
    const tanHalfHorizontal = tanHalfVertical * request.aspect;
    const height = request.bounds.maxY - request.bounds.minY;
    const width = request.bounds.maxX - request.bounds.minX;

    const vertical = height / request.fitFraction / 2 / tanHalfVertical;
    const horizontal = width / request.fitFraction / 2 / tanHalfHorizontal;

    expect(solution.distance).toBeCloseTo(Math.max(vertical, horizontal), 12);
    expect(solution.visibleWidth).toBeCloseTo(solution.visibleHeight * request.aspect, 12);
  });
});

describe('unionBounds', () => {
  const a: Bounds = { minX: -1, minY: 0, minZ: -0.5, maxX: 0.5, maxY: 2, maxZ: 0.5 };
  const b: Bounds = { minX: -0.25, minY: 1, minZ: -2, maxX: 1.5, maxY: 1.4, maxZ: 0.25 };

  it('is commutative', () => {
    expect(unionBounds(a, b)).toEqual(unionBounds(b, a));
  });

  it('grows the box to contain both inputs', () => {
    const u = unionBounds(a, b);
    for (const box of [a, b]) {
      expect(u.minX).toBeLessThanOrEqual(box.minX);
      expect(u.minY).toBeLessThanOrEqual(box.minY);
      expect(u.minZ).toBeLessThanOrEqual(box.minZ);
      expect(u.maxX).toBeGreaterThanOrEqual(box.maxX);
      expect(u.maxY).toBeGreaterThanOrEqual(box.maxY);
      expect(u.maxZ).toBeGreaterThanOrEqual(box.maxZ);
    }
    expect(u).toEqual({ minX: -1, minY: 0, minZ: -2, maxX: 1.5, maxY: 2, maxZ: 0.5 });
  });
});

describe('boundsAround', () => {
  it('produces min <= max and a radius-sized box', () => {
    const box = boundsAround(2, 3, 4, 0.5);

    expect(isFiniteBounds(box)).toBe(true);
    expect(box).toEqual({ minX: 1.5, minY: 2.5, minZ: 3.5, maxX: 2.5, maxY: 3.5, maxZ: 4.5 });
    // Side length is exactly the diameter.
    expect(box.maxX - box.minX).toBeCloseTo(1, 12);
    expect(box.maxY - box.minY).toBeCloseTo(1, 12);
    expect(box.maxZ - box.minZ).toBeCloseTo(1, 12);
    // Centre is the requested point.
    expect((box.minX + box.maxX) / 2).toBeCloseTo(2, 12);
    expect((box.minY + box.maxY) / 2).toBeCloseTo(3, 12);
    expect((box.minZ + box.maxZ) / 2).toBeCloseTo(4, 12);
  });

  it('keeps min <= max for a negative or zero radius', () => {
    expect(isFiniteBounds(boundsAround(0, 0, 0, -1))).toBe(true);
    expect(boundsAround(0, 0, 0, -1)).toEqual({ minX: -1, minY: -1, minZ: -1, maxX: 1, maxY: 1, maxZ: 1 });
    expect(isFiniteBounds(boundsAround(1, 1, 1, 0))).toBe(true);
  });
});

describe('solveFrame — defensive', () => {
  it('survives NaN bounds with a safe, finite fallback', () => {
    const solution = solveFrame(
      base({
        bounds: {
          minX: NaN,
          minY: NaN,
          minZ: NaN,
          maxX: NaN,
          maxY: NaN,
          maxZ: NaN,
        },
      }),
    );

    expectFiniteSolution(solution);
    expect(solution.distance).toBeGreaterThanOrEqual(0.5);
  });

  it('handles a zero-height box', () => {
    const solution = solveFrame(
      base({ bounds: { minX: -0.3, minY: 2, minZ: -0.3, maxX: 0.3, maxY: 2, maxZ: 0.3 } }),
    );
    expectFiniteSolution(solution);
    expect(solution.visibleHeight).toBeGreaterThan(0);
  });

  it('clamps aspect 0, fitFraction 0 and fov 0 instead of dividing the view away', () => {
    expectFiniteSolution(solveFrame(base({ aspect: 0 })));
    expectFiniteSolution(solveFrame(base({ fitFraction: 0 })));
    expectFiniteSolution(solveFrame(base({ fovDeg: 0 })));
  });

  it('applies the documented clamps', () => {
    const clampedLow = solveFrame(base({ bounds: tall(3), fitFraction: 0, fovDeg: 0, aspect: 0 }));
    const clampedHigh = solveFrame(
      base({ bounds: tall(3), fitFraction: 5, fovDeg: 999, aspect: 999 }),
    );

    // fitFraction 0 clamps to 0.05, fov 0 clamps to 1, aspect 0 clamps to 0.1.
    expect(clampedLow.distance).toBeCloseTo(
      solveFrame(base({ bounds: tall(3), fitFraction: 0.05, fovDeg: 1, aspect: 0.1 })).distance,
      12,
    );
    expect(clampedHigh.distance).toBeCloseTo(
      solveFrame(base({ bounds: tall(3), fitFraction: 1, fovDeg: 170, aspect: 10 })).distance,
      12,
    );
  });

  it('never throws or leaks NaN/Infinity for a fully empty request', () => {
    const solution = solveFrame({} as FrameRequest);
    expectFiniteSolution(solution);
    expect(solution.distance).toBeGreaterThanOrEqual(0.5);
  });

  it('respects minDistance', () => {
    const near = solveFrame(base({ minDistance: 0.1 }));
    const floored = solveFrame(base({ minDistance: 100 }));

    // A floor below the computed distance changes nothing.
    expect(floored.distance).toBeGreaterThan(near.distance);
    expect(floored.distance).toBe(100);
    expectFiniteSolution(floored);
  });
});

describe('isFiniteBounds', () => {
  it('accepts a well-formed box', () => {
    expect(isFiniteBounds(tall(0.5))).toBe(true);
  });

  it('rejects NaN and Infinity in any field', () => {
    expect(isFiniteBounds({ ...tall(0.5), minY: NaN })).toBe(false);
    expect(isFiniteBounds({ ...tall(0.5), maxX: Infinity })).toBe(false);
    expect(isFiniteBounds({ ...tall(0.5), minZ: -Infinity })).toBe(false);
  });

  it('rejects an inverted box', () => {
    expect(isFiniteBounds({ minX: 1, minY: 0, minZ: 0, maxX: -1, maxY: 1, maxZ: 1 })).toBe(false);
    expect(isFiniteBounds({ minX: 0, minY: 2, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 })).toBe(false);
  });
});
