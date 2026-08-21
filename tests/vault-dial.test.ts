import { describe, expect, it } from 'vitest';

import { drumTurnDeg, faceDistance, faceOpacity, STEP } from '@/components/VaultDial';
import { CATEGORY_ORDER, CATEGORY_WEIGHTS } from '@/lib/constants';

/*
 * The drum's rotation is driven by an IntersectionObserver, which only
 * delivers callbacks on a page that is being composited — so the scroll
 * behaviour itself cannot be exercised here. What can be, and is, is the
 * arithmetic underneath it: that a full revolution is divided evenly among
 * however many checks exist, that turning to face N puts face N at the front,
 * and that the drum takes the short way round rather than unwinding through
 * every face between.
 */
describe('vault dial geometry', () => {
  it('divides one revolution evenly among the checks', () => {
    expect(STEP * CATEGORY_ORDER.length).toBeCloseTo(360, 10);
  });

  it('turns by the negative of the active face angle', () => {
    expect(drumTurnDeg(0)).toBe(0);
    expect(drumTurnDeg(1)).toBeCloseTo(-STEP, 10);
    // Face N's own rotateX is +N*STEP; the drum's -N*STEP cancels it, which is
    // what leaves that face square-on to the reader.
    for (let i = 0; i < CATEGORY_ORDER.length; i += 1) {
      expect(drumTurnDeg(i) + i * STEP).toBeCloseTo(0, 10);
    }
  });

  it('measures distance the short way round the drum', () => {
    const n = CATEGORY_ORDER.length;
    expect(faceDistance(0, 0)).toBe(0);
    expect(faceDistance(1, 0)).toBe(1);
    // The last face is one step *before* the first, not ten steps after it.
    expect(faceDistance(n - 1, 0)).toBe(1);
    expect(faceDistance(0, n - 1)).toBe(1);
  });

  it('is never further than half the drum from any face', () => {
    const n = CATEGORY_ORDER.length;
    for (let a = 0; a < n; a += 1)
      for (let i = 0; i < n; i += 1) expect(faceDistance(i, a)).toBeLessThanOrEqual(n / 2);
  });

  it('shows the front face solid and the shoulders faint', () => {
    expect(faceOpacity(0)).toBe(1);
    expect(faceOpacity(1)).toBeLessThan(1);
    expect(faceOpacity(2)).toBeLessThan(faceOpacity(1));
    expect(faceOpacity(5)).toBeGreaterThan(0);
  });

  it('has exactly one face per check, with no second list to drift', () => {
    /*
     * The invariant, not the number.
     *
     * This asserted `toBe(11)` and broke the moment a twelfth check was added
     * — which is precisely the second hardcoded count the test was named after
     * preventing. `CATEGORY_WEIGHTS` is the independent list: every key in the
     * order has a weight, every weight has a place in the order, and the dial
     * draws one face per entry.
     */
    expect(CATEGORY_ORDER.length).toBeGreaterThan(0);
    expect([...CATEGORY_ORDER].sort()).toEqual(Object.keys(CATEGORY_WEIGHTS).sort());
    expect(new Set(CATEGORY_ORDER).size).toBe(CATEGORY_ORDER.length);
  });

  it('keeps the weights a partition of the composite', () => {
    const total = CATEGORY_ORDER.reduce((sum, key) => sum + CATEGORY_WEIGHTS[key], 0);
    expect(total).toBeCloseTo(1, 10);
    for (const key of CATEGORY_ORDER) expect(CATEGORY_WEIGHTS[key]).toBeGreaterThan(0);
  });
});
