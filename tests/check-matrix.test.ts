import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * `CheckMatrix` expands a row — larger type, the worst finding surfaced
 * inline — either when a category scores below `EXPAND_BELOW`, or when it is
 * `internetdb` and carries any real finding regardless of score. The second
 * clause exists because a single open remote-access port only costs 15
 * points, which keeps the category "healthy" by the composite's arithmetic
 * while still being a named, third-party-observed open door — a different
 * kind of thing than a header misconfiguration costing the same 15 points.
 *
 * It is scoped to `internetdb` specifically and does not touch severity: see
 * `tests/internetdb.test.ts` for the module's own "one step below a direct
 * observation" severity reasoning, which this must not be used to route
 * around by inflating a finding's severity just to win a louder row.
 */
const MATRIX = readFileSync(join(process.cwd(), 'src', 'components', 'CheckMatrix.tsx'), 'utf8');

describe('the check matrix expansion rule', () => {
  it('expands internetdb on any material finding, not only a low score', () => {
    expect(MATRIX).toContain("category.key === 'internetdb'");
    expect(MATRIX).toContain("row.worst !== null && row.worst !== 'info'");
  });

  it('is scoped to internetdb alone, not every category', () => {
    // Every other CategoryKey should have no matching carve-out of its own —
    // this is a one-category exception, not a template for adding more.
    const otherKeys = [
      'dns',
      'subdomains',
      'ssl',
      'headers',
      'emailSecurity',
      'whois',
      'exposedPaths',
      'cookies',
      'cors',
      'robotsSecurity',
      'technologies',
    ];
    for (const key of otherKeys) {
      expect(MATRIX).not.toContain(`category.key === '${key}'`);
    }
  });

  it('does not touch finding severity to force the expansion', () => {
    // The carve-out reads `row.worst`, computed from findings exactly as
    // reported — it must never assign or override a severity value itself.
    const clause = MATRIX.slice(MATRIX.indexOf("category.key === 'internetdb'") - 200);
    const nearby = clause.slice(0, 600);
    expect(nearby).not.toMatch(/severity:\s*['"](critical|high)['"]/);
  });
});
