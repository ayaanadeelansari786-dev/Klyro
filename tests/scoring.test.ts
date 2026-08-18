import { describe, expect, it } from 'vitest';

import { makeFinding, makeUnknown, penaltyBreakdown, scoreFromComponents } from '@/lib/checks/util';
import { CATEGORY_WEIGHTS } from '@/lib/constants';
import { buildScanResult, computeComposite, prioritise } from '@/lib/scoring';
import type { CategoryResult, Finding, Severity } from '@/lib/types';

function category(
  key: CategoryResult['key'],
  score: number,
  status: CategoryResult['status'] = 'assessed',
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
  };
}

describe('scoreFromComponents', () => {
  it('drops an unknown component and rescales the remainder', () => {
    const { score, coverage } = scoreFromComponents([
      { label: 'a', value: 30, max: 30, note: '' },
      { label: 'b', value: 20, max: 20, note: '' },
      { label: 'c', value: 0, max: 50, known: false, note: '' },
    ]);

    // Full marks on everything that could be measured. The dropped component
    // must not pull the score toward zero.
    expect(score).toBe(100);
    expect(coverage).toBe(0.5);
  });

  it('never lets an unknown improve a score either', () => {
    const withUnknown = scoreFromComponents([
      { label: 'a', value: 0, max: 50, note: '' },
      { label: 'b', value: 0, max: 50, known: false, note: '' },
    ]);
    expect(withUnknown.score).toBe(0);
  });

  it('clamps a component that reports more than its maximum', () => {
    const { score } = scoreFromComponents([{ label: 'a', value: 200, max: 50, note: '' }]);
    expect(score).toBe(100);
  });

  it('returns zero coverage when nothing could be assessed', () => {
    const { score, coverage } = scoreFromComponents([
      { label: 'a', value: 10, max: 50, known: false, note: '' },
    ]);
    expect(score).toBe(0);
    expect(coverage).toBe(0);
  });

  it('publishes a breakdown line for every component, assessed or not', () => {
    const { breakdown } = scoreFromComponents([
      { label: 'measured', value: 10, max: 20, note: 'why' },
      { label: 'dropped', value: 15, max: 30, known: false, note: 'because' },
    ]);

    expect(breakdown).toHaveLength(2);
    expect(breakdown[0]).toMatchObject({ label: 'measured', value: 10, max: 20, assessed: true });
    // A dropped component reports zero rather than its notional value, so the
    // rendered arithmetic cannot appear to add up to something it did not.
    expect(breakdown[1]).toMatchObject({ label: 'dropped', value: 0, assessed: false });
  });
});

describe('penaltyBreakdown', () => {
  it('renders a starting score followed by negative lines', () => {
    const lines = penaltyBreakdown(100, [{ label: 'thing', points: 15, note: 'because' }]);

    expect(lines[0]).toMatchObject({ label: 'Starting score', value: 100, max: 100 });
    expect(lines[1]).toMatchObject({ label: 'thing', value: -15, max: 0, assessed: true });
  });
});

describe('computeComposite', () => {
  it('renormalises around an unavailable category', () => {
    const { compositeScore, coverage } = computeComposite([
      category('dns', 100),
      category('ssl', 100),
      category('headers', 0, 'unavailable'),
    ]);

    const expectedCoverage = CATEGORY_WEIGHTS.dns + CATEGORY_WEIGHTS.ssl;
    expect(compositeScore).toBe(100);
    expect(coverage).toBeCloseTo(expectedCoverage, 4);
  });

  it('reports zero coverage when every category failed', () => {
    const { compositeScore, coverage } = computeComposite([
      category('dns', 0, 'unavailable'),
      category('ssl', 0, 'unavailable'),
    ]);

    expect(compositeScore).toBe(0);
    expect(coverage).toBe(0);
  });

  it('weights categories by their declared weight', () => {
    // emailSecurity is 0.15, robotsSecurity is 0.04 — a perfect score on the
    // heavier category must move the composite further.
    const emailStrong = computeComposite([
      category('emailSecurity', 100),
      category('robotsSecurity', 0),
    ]);
    const robotsStrong = computeComposite([
      category('emailSecurity', 0),
      category('robotsSecurity', 100),
    ]);

    expect(emailStrong.compositeScore).toBeGreaterThan(robotsStrong.compositeScore);
  });
});

/* ------------------------------------------------------------------ */

function finding(
  overrides: Partial<Finding> & { severity: Severity; confidence: Finding['confidence'] },
): Finding {
  return makeFinding(overrides.category ?? 'dns', {
    title: overrides.title ?? 'title',
    severity: overrides.severity,
    confidence: overrides.confidence,
    asset: 'example.test',
    observed: 'observed',
    interpretation: 'interpretation',
    risk: 'risk',
    recommendation: 'recommendation',
    evidence: { test: 't', observed: 'o', verification: 'v' },
  });
}

describe('prioritise', () => {
  it('ranks a corroborated observation above an inference of the same severity', () => {
    const observed = finding({ severity: 'high', confidence: 'high', title: 'observed' });
    const inferred = finding({ severity: 'high', confidence: 'low', title: 'inferred' });

    const ranked = prioritise([inferred, observed]);

    expect(ranked[0].finding.title).toBe('observed');
    expect(ranked[0].priority).toBeGreaterThan(ranked[1].priority);
  });

  it('weights a directly actionable category above a peripheral one', () => {
    const email = finding({ severity: 'medium', confidence: 'high', category: 'emailSecurity', title: 'email' });
    const robots = finding({ severity: 'medium', confidence: 'high', category: 'robotsSecurity', title: 'robots' });

    const ranked = prioritise([robots, email]);
    expect(ranked[0].finding.title).toBe('email');
  });

  it('excludes info findings entirely', () => {
    const ranked = prioritise([
      finding({ severity: 'info', confidence: 'high', title: 'scope note' }),
      finding({ severity: 'low', confidence: 'low', title: 'real' }),
    ]);

    expect(ranked).toHaveLength(1);
    expect(ranked[0].finding.title).toBe('real');
  });

  it('states the arithmetic that produced each position', () => {
    const ranked = prioritise([finding({ severity: 'critical', confidence: 'medium', title: 'x' })]);

    expect(ranked[0].rationale).toContain('critical severity (100)');
    expect(ranked[0].rationale).toContain('medium confidence (×0.75)');
    expect(ranked[0].priority).toBe(Math.round(100 * 0.75 * 0.8));
  });

  it('is deterministic across calls with the same input', () => {
    const findings = [
      finding({ severity: 'high', confidence: 'high', title: 'a' }),
      finding({ severity: 'high', confidence: 'high', title: 'b', category: 'ssl' }),
      finding({ severity: 'medium', confidence: 'high', title: 'c' }),
    ];

    expect(prioritise(findings).map((p) => p.finding.title)).toEqual(
      prioritise([...findings].reverse()).map((p) => p.finding.title),
    );
  });
});

describe('makeUnknown', () => {
  it('always produces an info finding that claims no risk', () => {
    const unknown = makeUnknown('dns', {
      title: 'Could not check',
      asset: 'example.test',
      observed: 'the lookup failed',
      wouldHaveShown: 'it would have shown something',
      recommendation: 're-run',
      evidence: { test: 't', observed: 'o', verification: 'v' },
    });

    expect(unknown.severity).toBe('info');
    expect(unknown.confidence).toBe('high');
    expect(unknown.interpretation).toMatch(/No conclusion is drawn/);
    expect(unknown.risk).toMatch(/None is claimed/);
    // It must also be invisible to the priority list.
    expect(prioritise([unknown])).toHaveLength(0);
  });
});

describe('finding ids', () => {
  it('derives the id from the title, so two scans can be diffed', () => {
    const a = finding({ severity: 'high', confidence: 'high', title: 'Same title' });
    const b = finding({ severity: 'low', confidence: 'low', title: 'Same title' });

    // Severity and confidence changed; the identity did not. That is what lets
    // the comparison report a severity change rather than a resolve plus a new.
    expect(a.id).toBe(b.id);
  });

  it('gives different titles different ids', () => {
    const a = finding({ severity: 'high', confidence: 'high', title: 'One' });
    const b = finding({ severity: 'high', confidence: 'high', title: 'Two' });

    expect(a.id).not.toBe(b.id);
  });
});

describe('buildScanResult', () => {
  it('omits the inventory key entirely when there is no inventory', () => {
    const result = buildScanResult(
      { domain: 'example.test', industry: 'Technology', region: 'Global' },
      [category('dns', 80)],
      null,
    );

    expect(result.inventory).toBeUndefined();
    expect(result.categoryScores).toEqual({ dns: 80 });
  });

  it('excludes unavailable categories from categoryScores', () => {
    const result = buildScanResult(
      { domain: 'example.test', industry: 'Technology', region: 'Global' },
      [category('dns', 80), category('ssl', 0, 'unavailable')],
    );

    expect(Object.keys(result.categoryScores)).toEqual(['dns']);
  });
});
