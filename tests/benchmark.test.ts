import { describe, expect, it } from 'vitest';

import { benchmarkSentence, latestPerDomain, ordinal, percentile } from '@/lib/benchmark';
import { MIN_BENCHMARK_SAMPLES } from '@/lib/constants';
import type { BenchmarkResult } from '@/lib/types';

describe('latestPerDomain', () => {
  it('keeps only the most recent scan of each domain', () => {
    const rows = [
      { domain: 'a.test', composite_score: 50, category_scores: null, scanned_at: '2024-01-01T00:00:00Z' },
      { domain: 'a.test', composite_score: 90, category_scores: null, scanned_at: '2024-06-01T00:00:00Z' },
      { domain: 'b.test', composite_score: 70, category_scores: null, scanned_at: '2024-03-01T00:00:00Z' },
    ];

    const pool = latestPerDomain(rows);

    // One domain, one vote. Re-scanning a domain three times must not give it
    // triple weight in the average.
    expect(pool).toHaveLength(2);
    expect(pool.find((r) => r.domain === 'a.test')?.composite_score).toBe(90);
  });

  it('is insensitive to the order rows arrive in', () => {
    const rows = [
      { domain: 'a.test', composite_score: 90, category_scores: null, scanned_at: '2024-06-01T00:00:00Z' },
      { domain: 'a.test', composite_score: 50, category_scores: null, scanned_at: '2024-01-01T00:00:00Z' },
    ];

    expect(latestPerDomain(rows)[0].composite_score).toBe(90);
  });

  it('excludes the domain being assessed, case-insensitively', () => {
    const rows = [
      { domain: 'Subject.TEST', composite_score: 99, category_scores: null, scanned_at: '2024-01-01T00:00:00Z' },
      { domain: 'other.test', composite_score: 40, category_scores: null, scanned_at: '2024-01-01T00:00:00Z' },
    ];

    const pool = latestPerDomain(rows, 'subject.test');

    expect(pool).toHaveLength(1);
    expect(pool[0].domain).toBe('other.test');
  });

  it('drops rows with no domain rather than grouping them together', () => {
    const rows = [
      { domain: '', composite_score: 10, category_scores: null, scanned_at: '2024-01-01T00:00:00Z' },
      { domain: 'a.test', composite_score: 20, category_scores: null, scanned_at: '2024-01-01T00:00:00Z' },
    ];

    expect(latestPerDomain(rows)).toHaveLength(1);
  });

  it('handles a missing timestamp without discarding the row', () => {
    const rows = [
      { domain: 'a.test', composite_score: 60, category_scores: null, scanned_at: null },
    ];

    expect(latestPerDomain(rows)).toHaveLength(1);
  });
});

describe('percentile', () => {
  it('gives the mid-rank position for a score in the middle', () => {
    // 40 beats 20 and 30, ties nothing, out of five.
    expect(percentile([10, 20, 30, 50, 60], 40)).toBe(60);
  });

  it('splits the credit for ties', () => {
    // Two of four are equal; below = 1, equal = 2 → (1 + 1) / 4 = 50.
    expect(percentile([10, 50, 50, 90], 50)).toBe(50);
  });

  it('returns 100 for a score above everything in the pool', () => {
    expect(percentile([10, 20, 30], 99)).toBe(100);
  });

  it('returns 0 for a score below everything in the pool', () => {
    expect(percentile([10, 20, 30], 1)).toBe(0);
  });

  it('returns 0 rather than dividing by zero on an empty pool', () => {
    expect(percentile([], 50)).toBe(0);
  });
});

describe('ordinal', () => {
  it.each([
    [1, '1st'],
    [2, '2nd'],
    [3, '3rd'],
    [4, '4th'],
    [11, '11th'],
    [12, '12th'],
    [13, '13th'],
    [21, '21st'],
    [22, '22nd'],
    [23, '23rd'],
    [100, '100th'],
    [111, '111th'],
  ])('renders %i as %s', (n, expected) => {
    expect(ordinal(n)).toBe(expected);
  });
});

/* ------------------------------------------------------------------ */

function benchmark(overrides: Partial<BenchmarkResult> = {}): BenchmarkResult {
  return {
    industry: 'Technology',
    region: 'Global',
    industryAverage: 60,
    industryMedian: 62,
    industryBest: 95,
    percentileRank: 75,
    categoryAverages: {},
    totalScans: 40,
    insufficientData: false,
    scope: 'industry-region',
    ...overrides,
  };
}

describe('benchmarkSentence', () => {
  it('says data is being collected when there is no pool', () => {
    expect(benchmarkSentence(null, 70)).toMatch(/being collected/);
    expect(benchmarkSentence(benchmark({ totalScans: 0 }), 70)).toMatch(/being collected/);
  });

  it('refuses to publish a percentile below the sample threshold', () => {
    const sentence = benchmarkSentence(
      benchmark({ totalScans: 5, insufficientData: true, percentileRank: null }),
      70,
    );

    expect(sentence).toContain(`${MIN_BENCHMARK_SAMPLES}-domain threshold`);
    expect(sentence).toMatch(/no percentile is given/);
    expect(sentence).not.toMatch(/percentile of that group/);
  });

  it('describes the pool as domains assessed by Klyro, never as an industry', () => {
    const sentence = benchmarkSentence(benchmark(), 70);

    expect(sentence).toContain('assessed by Klyro');
    // The pool is a convenience sample of whatever anyone chose to scan.
    // Describing it as "companies in your industry" would overstate it.
    expect(sentence).not.toMatch(/all companies|the industry average|industry-wide/i);
  });

  it('names the broader pool when the comparison fell back', () => {
    expect(
      benchmarkSentence(benchmark({ scope: 'global', insufficientData: true, percentileRank: null }), 70),
    ).toContain('across all industries');
  });

  it('gives the scope as the reason when the pool is large but mixed', () => {
    // 151 domains is well over the threshold. Telling the reader the pool was
    // "below the 30-domain threshold" in the same sentence that says 151 is a
    // claim they can see is false.
    const sentence = benchmarkSentence(
      benchmark({
        scope: 'global',
        totalScans: 151,
        insufficientData: true,
        percentileRank: null,
      }),
      70,
    );

    expect(sentence).toContain('151 domains assessed by Klyro across all industries');
    expect(sentence).toMatch(/compares against every industry at once/);
    expect(sentence).not.toMatch(/That pool is below the \d+-domain threshold/);
  });

  it('gives the region as the reason when the industry pool is worldwide', () => {
    const sentence = benchmarkSentence(
      benchmark({
        scope: 'industry',
        totalScans: 88,
        insufficientData: true,
        percentileRank: null,
      }),
      70,
    );

    expect(sentence).toMatch(/compares against the industry worldwide/);
    expect(sentence).not.toMatch(/That pool is below the \d+-domain threshold/);
  });

  it('still gives size as the reason when the pool really is too small', () => {
    const sentence = benchmarkSentence(
      benchmark({ scope: 'global', totalScans: 7, insufficientData: true, percentileRank: null }),
      70,
    );

    expect(sentence).toContain(`That pool is below the ${MIN_BENCHMARK_SAMPLES}-domain threshold`);
  });

  it('reads correctly at a delta of exactly one point', () => {
    expect(benchmarkSentence(benchmark({ industryAverage: 69 }), 70)).toContain('1 point above');
  });

  it('reads correctly at a delta of zero', () => {
    const sentence = benchmarkSentence(benchmark({ industryAverage: 70 }), 70);

    expect(sentence).toContain('level with the average');
    expect(sentence).not.toMatch(/\s{2,}/);
  });

  it('agrees in number for a pool of one', () => {
    const sentence = benchmarkSentence(
      benchmark({ totalScans: 1, insufficientData: true, percentileRank: null }),
      70,
    );

    expect(sentence).toContain('1 Technology domain assessed');
    expect(sentence).not.toContain('1 Technology domains');
  });
});
