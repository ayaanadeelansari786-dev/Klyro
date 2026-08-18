import { describe, expect, it } from 'vitest';

import { deriveBrand } from '@/lib/intel/news';

/**
 * The news module reports what third parties published. Its failure mode is
 * misattribution — filing somebody else's incident, or an interview about
 * incidents, under this vendor's history.
 */

describe('deriveBrand', () => {
  it('takes the registrable label from a simple domain', () => {
    expect(deriveBrand('monzo.com').brand).toBe('Monzo');
  });

  it('steps one level further left for a multi-part suffix', () => {
    expect(deriveBrand('tesco.co.uk').brand).toBe('Tesco');
    expect(deriveBrand('example.com.au').brand).toBe('Example');
  });

  it('expands hyphens into words', () => {
    expect(deriveBrand('bosch-security.com').brand).toBe('Bosch Security');
  });

  it('states how the name was derived, because it is a guess', () => {
    // Searching news for the wrong name is the main way this module could
    // attribute another company's incident to this vendor, so the derivation
    // is surfaced rather than hidden.
    expect(deriveBrand('monzo.com').derivedFrom).toContain('monzo.com');
  });

  it('does not throw on a single-label input', () => {
    expect(deriveBrand('localhost').brand).toBe('localhost');
  });
});
