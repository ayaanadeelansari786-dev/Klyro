import { describe, expect, it } from 'vitest';

import { makeFinding } from '@/lib/checks/util';
import { compareScans, comparisonHeadline } from '@/lib/compare';
import type { CategoryResult, Finding, ScanResult, Severity } from '@/lib/types';

function finding(title: string, severity: Severity = 'medium'): Finding {
  return makeFinding('dns', {
    title,
    severity,
    confidence: 'high',
    asset: 'example.test',
    observed: 'observed',
    interpretation: 'interpretation',
    risk: 'risk',
    recommendation: 'recommendation',
    evidence: { test: 't', observed: 'o', verification: 'v' },
  });
}

function category(
  key: CategoryResult['key'],
  score: number,
  status: CategoryResult['status'] = 'assessed',
  liveHosts?: string[],
): CategoryResult {
  return {
    key,
    label: key,
    score,
    status,
    findings: [],
    summary: '',
    details: [],
    durationMs: 1,
    ...(liveHosts ? { facts: { liveHosts } } : {}),
  };
}

function scan(overrides: Partial<ScanResult> = {}): ScanResult {
  return {
    domain: 'example.test',
    industry: 'Technology',
    region: 'Global',
    compositeScore: 70,
    riskLevel: 'Moderate Risk',
    categoryScores: { dns: 70 },
    categories: [category('dns', 70)],
    findings: [],
    coverage: 1,
    scannedAt: '2024-01-01T00:00:00Z',
    toolVersion: '1.0.0',
    persisted: false,
    ...overrides,
  };
}

describe('compareScans', () => {
  it('matches findings by id, so a severity change is not a resolve plus a new', () => {
    const baseline = scan({ findings: [finding('Same issue', 'high')] });
    const current = scan({ findings: [finding('Same issue', 'low')] });

    const diff = compareScans(baseline, current);

    expect(diff.newFindings).toHaveLength(0);
    expect(diff.resolvedFindings).toHaveLength(0);
    expect(diff.severityChanges).toEqual([
      expect.objectContaining({ from: 'high', to: 'low' }),
    ]);
  });

  it('reports a finding present only in the later scan as new', () => {
    const diff = compareScans(
      scan({ findings: [finding('Old')] }),
      scan({ findings: [finding('Old'), finding('New')] }),
    );

    expect(diff.newFindings.map((f) => f.title)).toEqual(['New']);
    expect(diff.unchangedCount).toBe(1);
  });

  it('reports a finding present only in the earlier scan as no longer observed', () => {
    const diff = compareScans(
      scan({ findings: [finding('Gone'), finding('Stays')] }),
      scan({ findings: [finding('Stays')] }),
    );

    expect(diff.resolvedFindings.map((f) => f.title)).toEqual(['Gone']);
    // The wording matters: absence in the second scan is not proof of a fix.
    expect(diff.limits.join(' ')).toMatch(/was not observed the second time/);
  });

  it('computes the score delta and per-category deltas', () => {
    const diff = compareScans(
      scan({ compositeScore: 60, categories: [category('dns', 50), category('ssl', 70)] }),
      scan({ compositeScore: 75, categories: [category('dns', 80), category('ssl', 70)] }),
    );

    expect(diff.scoreDelta).toBe(15);
    expect(diff.categoryDeltas[0]).toMatchObject({ key: 'dns', from: 50, to: 80, delta: 30 });
    expect(diff.categoryDeltas[1]).toMatchObject({ key: 'ssl', delta: 0 });
  });

  it('returns a null delta rather than a number when one side was unavailable', () => {
    const diff = compareScans(
      scan({ categories: [category('dns', 0, 'unavailable')] }),
      scan({ categories: [category('dns', 90)] }),
    );

    // Subtracting from a category that was never measured would manufacture a
    // 90-point improvement out of a module that simply failed last time.
    expect(diff.categoryDeltas[0]).toMatchObject({ from: null, to: 90, delta: null });
  });

  it('warns when coverage moved between the two runs', () => {
    const diff = compareScans(scan({ coverage: 1 }), scan({ coverage: 0.7 }));

    expect(diff.limits.join(' ')).toMatch(/Assessment coverage differs/);
    expect(diff.limits.join(' ')).toMatch(/100% then, 70% now/);
  });

  it('warns when a category was unavailable in either run', () => {
    const diff = compareScans(
      scan({ categories: [category('dns', 0, 'unavailable')] }),
      scan({ categories: [category('dns', 90)] }),
    );

    expect(diff.limits.join(' ')).toMatch(/could not be assessed in at least one of the two runs/);
  });

  it('diffs host names from the subdomain facts', () => {
    const diff = compareScans(
      scan({ categories: [category('subdomains', 80, 'assessed', ['a.example.test', 'b.example.test'])] }),
      scan({ categories: [category('subdomains', 80, 'assessed', ['b.example.test', 'c.example.test'])] }),
    );

    expect(diff.newAssets).toEqual(['c.example.test']);
    expect(diff.removedAssets).toEqual(['a.example.test']);
  });

  it('says host names were never recorded rather than implying the estate held still', () => {
    // A stored assessment keeps scores and findings, not the host list. The
    // host-name section then does not render, and a silent absence reads as
    // "nothing changed" — the one conclusion the data does not support.
    const diff = compareScans(scan(), scan());

    expect(diff.newAssets).toEqual([]);
    expect(diff.limits.join(' ')).toMatch(/Neither assessment retained the host names/);
    expect(diff.limits.join(' ')).not.toMatch(/lags issuance and revocation/);
  });

  it('reverts to the transparency-log caveat once host names are present', () => {
    const diff = compareScans(
      scan({ categories: [category('subdomains', 80, 'assessed', ['a.example.test'])] }),
      scan({ categories: [category('subdomains', 80, 'assessed', ['a.example.test'])] }),
    );

    expect(diff.limits.join(' ')).toMatch(/lags issuance and revocation/);
    expect(diff.limits.join(' ')).not.toMatch(/Neither assessment retained/);
  });

  it('says so when the two runs discovered very different numbers of host names', () => {
    const many = Array.from({ length: 40 }, (_, i) => `h${i}.example.test`);

    const diff = compareScans(
      scan({ categories: [category('subdomains', 81, 'assessed', many.slice(0, 4))] }),
      scan({ categories: [category('subdomains', 42, 'assessed', many)] }),
    );

    // A 39-point swing on this category is usually the certificate log, not
    // the estate, and the reader should not have to work that out.
    expect(diff.limits.join(' ')).toMatch(/different numbers of host names \(4 then, 40 now\)/);
  });

  it('stays quiet when discovery was steady', () => {
    const hosts = ['a.example.test', 'b.example.test', 'c.example.test', 'd.example.test'];

    const diff = compareScans(
      scan({ categories: [category('subdomains', 80, 'assessed', hosts)] }),
      scan({ categories: [category('subdomains', 80, 'assessed', [...hosts, 'e.example.test'])] }),
    );

    expect(diff.limits.join(' ')).not.toMatch(/different numbers of host names/);
  });

  it('always states that nothing is known about the interval between scans', () => {
    const diff = compareScans(scan(), scan());
    expect(diff.limits[0]).toMatch(/two point-in-time observations/);
  });
});

describe('comparisonHeadline', () => {
  it('describes an improvement', () => {
    const diff = compareScans(
      scan({ compositeScore: 60, findings: [finding('Gone')] }),
      scan({ compositeScore: 80 }),
    );

    expect(comparisonHeadline(diff)).toBe('Score up 20 points: 1 finding no longer observed.');
  });

  it('describes a regression', () => {
    const diff = compareScans(
      scan({ compositeScore: 80 }),
      scan({ compositeScore: 60, findings: [finding('New one'), finding('And another')] }),
    );

    expect(comparisonHeadline(diff)).toBe('Score down 20 points: 2 new findings.');
  });

  it('describes no change at all', () => {
    expect(comparisonHeadline(compareScans(scan(), scan()))).toBe(
      'Score unchanged, with no change to the set of findings.',
    );
  });
});

describe('version boundaries', () => {
  it('warns when the two runs came from different tool versions', () => {
    const diff = compareScans(
      scan({ toolVersion: '1.0.0', findings: [finding('Old wording')] }),
      scan({ toolVersion: '1.1.0', findings: [finding('New wording')] }),
    );

    // Rewording a finding changes its id, so a version bump makes every
    // finding read as resolved-and-replaced. Without this warning the reader
    // has no way to tell that apart from real movement.
    expect(diff.limits.join(' ')).toMatch(/different versions of Klyro \(1\.0\.0 and 1\.1\.0\)/);
  });

  it('stays quiet when both runs came from the same version', () => {
    const diff = compareScans(
      scan({ toolVersion: '1.0.0', findings: [finding('A')] }),
      scan({ toolVersion: '1.0.0', findings: [finding('A'), finding('B')] }),
    );

    expect(diff.limits.join(' ')).not.toMatch(/different versions/);
    expect(diff.newFindings).toHaveLength(1);
  });

  it('flags total churn when a version is missing from either run', () => {
    const diff = compareScans(
      scan({ toolVersion: '', findings: [finding('Old')] }),
      scan({ toolVersion: '1.1.0', findings: [finding('New')] }),
    );

    expect(diff.limits.join(' ')).toMatch(/no version was recorded/);
  });

  it('does not cry version when findings genuinely overlap', () => {
    const diff = compareScans(
      scan({ toolVersion: '', findings: [finding('Shared')] }),
      scan({ toolVersion: '', findings: [finding('Shared'), finding('Added')] }),
    );

    expect(diff.limits.join(' ')).not.toMatch(/no version was recorded/);
  });
});
