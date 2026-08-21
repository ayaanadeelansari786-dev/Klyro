import { describe, expect, it } from 'vitest';

import { CHECKS, CHECK_ORDER } from '@/lib/checks';
import { CATEGORY_ORDER } from '@/lib/constants';

import {
  coverageCounts,
  explainLowCoverage,
  LOW_COVERAGE_THRESHOLD,
} from '@/lib/scoring';
import type { CategoryKey, CategoryResult } from '@/lib/types';

/**
 * Coverage transparency.
 *
 * emiratesnbd.ae scored 66/100 "Moderate Risk" at 36% coverage, and nothing on
 * the page said why. A reader takes "Moderate Risk" as a statement about the
 * organisation; at that coverage it is really a statement about how much of the
 * domain could be reached. These tests pin the branch that decides which
 * sentence a reader is shown, because the wrong sentence is worse than none —
 * telling somebody a WAF blocked the scan when the domain simply has no
 * website sends them to ask their vendor a question that makes no sense.
 */

function category(key: CategoryKey, status: 'assessed' | 'unavailable', facts?: Record<string, unknown>): CategoryResult {
  return {
    key,
    label: key,
    score: status === 'assessed' ? 70 : 0,
    status,
    findings: [],
    summary: '',
    details: [],
    durationMs: 1,
    ...(facts ? { facts } : {}),
  };
}

/** A scan where every module ran. */
function fullScan(): CategoryResult[] {
  return (
    ['dns', 'headers', 'ssl', 'emailSecurity', 'cookies', 'cors'] as CategoryKey[]
  ).map((k) => category(k, 'assessed'));
}

describe('coverage counts', () => {
  it('counts modules that produced a score, out of those run', () => {
    const categories = [
      category('dns', 'assessed'),
      category('headers', 'unavailable'),
      category('ssl', 'assessed'),
    ];

    expect(coverageCounts({ categories })).toEqual({ assessed: 2, total: 3 });
  });

  it('reports zero assessed rather than throwing when nothing ran', () => {
    expect(coverageCounts({ categories: [] })).toEqual({ assessed: 0, total: 0 });
  });
});

describe('the count a complete scan reports', () => {
  /*
   * Pinned because the number is user-facing and has been wrong before.
   *
   * The landing page once read "10 checks" after the eleventh module landed,
   * and a twelfth was briefly registered and then withdrawn. Nothing rendered
   * these counts from a literal, but nothing asserted the relationship either,
   * so both drifts were invisible until someone read the page. This ties the
   * banner to the module registry.
   */
  it('counts one check per registered module', () => {
    const complete = {
      categories: CATEGORY_ORDER.map((key) => ({ key, status: 'assessed' as const })),
    };
    const counts = coverageCounts(complete as never);
    expect(counts.total).toBe(CATEGORY_ORDER.length);
    expect(counts.assessed).toBe(counts.total);
    expect(`${counts.assessed} of ${counts.total} checks completed`).toBe(
      `${CATEGORY_ORDER.length} of ${CATEGORY_ORDER.length} checks completed`,
    );
  });

  it('runs the same set the orchestrator registers, with no extras', () => {
    expect(Object.keys(CHECKS).sort()).toEqual([...CATEGORY_ORDER].sort());
    expect(CHECK_ORDER).toEqual(CATEGORY_ORDER);
  });
});

describe('low coverage threshold', () => {
  it('sits at 60%, above the 36% and 54% cases that prompted it', () => {
    expect(LOW_COVERAGE_THRESHOLD).toBe(0.6);
    expect(0.36).toBeLessThan(LOW_COVERAGE_THRESHOLD);
    expect(0.54).toBeLessThan(LOW_COVERAGE_THRESHOLD);
    // etisalat.ae at 94% must not trip it.
    expect(0.94).toBeGreaterThan(LOW_COVERAGE_THRESHOLD);
  });
});

describe('explaining low coverage', () => {
  it('names the no-website case when DNS resolved but no web server answered', () => {
    // emiratesnbd.ae: a delegated zone, no apex address, so nothing to fetch.
    const categories = [
      category('dns', 'assessed', { ipv4: [], ipv6: [] }),
      category('headers', 'unavailable'),
      category('cookies', 'unavailable'),
    ];

    const text = explainLowCoverage({ categories });

    expect(text).toMatch(/no address at its apex/i);
    expect(text).toMatch(/security headers|live site/i);
    // Must not send the reader chasing a firewall that is not there.
    expect(text).not.toMatch(/firewall|WAF|bot-protection/i);
  });

  it('adjusts the wording when the apex does have an address but nothing served', () => {
    const categories = [
      category('dns', 'assessed', { ipv4: ['203.0.113.4'], ipv6: [] }),
      category('headers', 'unavailable'),
    ];

    const text = explainLowCoverage({ categories });

    expect(text).toMatch(/no web server answered/i);
    expect(text).not.toMatch(/no address at its apex/i);
  });

  it('falls back to the general no-server wording when facts were stripped', () => {
    // The report payload sanitiser drops `facts`. The branch must still be
    // chosen correctly and the sentence must still be specific.
    const categories = [category('dns', 'assessed'), category('headers', 'unavailable')];

    const text = explainLowCoverage({ categories });

    expect(text).toMatch(/no web server answered/i);
    expect(text).not.toMatch(/undefined|NaN/);
  });

  it('names the blocking case when a server did answer but checks still failed', () => {
    // carrefouruae.com: the site responds, the WAF refuses the rest.
    const categories = [
      category('dns', 'assessed', { ipv4: ['203.0.113.9'], ipv6: [] }),
      category('headers', 'assessed'),
      category('exposedPaths', 'unavailable'),
      category('cookies', 'unavailable'),
    ];

    const text = explainLowCoverage({ categories });

    expect(text).toMatch(/firewall, WAF or bot-protection/i);
    expect(text).not.toMatch(/no web server answered/i);
  });

  it('names the DNS case when the records themselves could not be read', () => {
    const categories = [category('dns', 'unavailable'), category('headers', 'unavailable')];

    const text = explainLowCoverage({ categories });

    expect(text).toMatch(/DNS records for this domain could not be read/i);
  });

  it('always says the score reflects only what could be measured', () => {
    // The load-bearing sentence: it is what stops the number being read as a
    // verdict on the organisation.
    const cases: CategoryResult[][] = [
      [category('dns', 'unavailable')],
      [category('dns', 'assessed'), category('headers', 'unavailable')],
      [category('dns', 'assessed'), category('headers', 'assessed')],
    ];

    for (const categories of cases) {
      expect(explainLowCoverage({ categories })).toMatch(/only what could be measured/i);
    }
  });

  it('never blames the domain for what Klyro could not see', () => {
    for (const categories of [
      [category('dns', 'assessed'), category('headers', 'unavailable')],
      [...fullScan(), category('exposedPaths', 'unavailable')],
    ]) {
      const text = explainLowCoverage({ categories });
      expect(text).not.toMatch(/insecure|vulnerable|at risk|poorly/i);
    }
  });
});
