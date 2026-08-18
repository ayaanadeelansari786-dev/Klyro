import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { benchmarkSentence } from '@/lib/benchmark';
import { CATEGORY_BLURBS } from '@/lib/constants';
import type { BenchmarkResult } from '@/lib/types';

/**
 * Klyro is used far more often to assess a supplier than to assess the
 * reader's own estate. Copy that says "your email can be spoofed" is therefore
 * addressing the wrong party, and in a procurement setting it reads as though
 * the report were about whoever is holding it.
 *
 * Second person is correct in exactly one place — the buyer-context feature,
 * where the reader supplied their own domain and "you" genuinely means them.
 * These tests hold that line, because copy drifts back.
 */

const SECOND_PERSON =
  /\b(your|yours|you're)\b(?!\s+(own domain|organisation's own))/i;

describe('category blurbs', () => {
  it.each(Object.entries(CATEGORY_BLURBS))('describes %s in the third person', (_key, blurb) => {
    expect(blurb).not.toMatch(SECOND_PERSON);
  });
});

describe('benchmark sentence', () => {
  const benchmark: BenchmarkResult = {
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
  };

  it('names the domain rather than addressing the reader', () => {
    const sentence = benchmarkSentence(benchmark, 70, 'vendor.example');

    expect(sentence).toContain('vendor.example');
    expect(sentence).not.toMatch(SECOND_PERSON);
  });

  it('falls back to a neutral subject when no domain is supplied', () => {
    expect(benchmarkSentence(benchmark, 70)).not.toMatch(SECOND_PERSON);
  });

  it('stays third person when the pool is too small to rank', () => {
    expect(
      benchmarkSentence({ ...benchmark, insufficientData: true, percentileRank: null }, 70, 'v.example'),
    ).not.toMatch(SECOND_PERSON);
  });

  it('stays third person with no pool at all', () => {
    expect(benchmarkSentence(null, 70, 'v.example')).not.toMatch(SECOND_PERSON);
  });
});

/* ------------------------------------------------------------------ */

/**
 * The check modules are the largest body of report copy and the easiest place
 * for second person to creep back in. Scanning the source is cruder than
 * running every branch, but it covers branches a test would have to construct
 * a live target to reach.
 */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

describe('check module copy', () => {
  const files = sourceFiles(join(process.cwd(), 'src', 'lib', 'checks'));

  it.each(files)('%s addresses the domain, not the reader', (file) => {
    const source = readFileSync(file, 'utf8');

    const offenders = source
      .split('\n')
      .map((line, i) => ({ line: line.trim(), number: i + 1 }))
      // Comments explain intent to maintainers and may use second person.
      .filter(({ line }) => !line.startsWith('*') && !line.startsWith('//') && !line.startsWith('/*'))
      .filter(({ line }) => /\byour\b/i.test(line));

    expect(
      offenders.map((o) => `${o.number}: ${o.line.slice(0, 100)}`),
      'report copy should name the domain rather than addressing the reader',
    ).toEqual([]);
  });
});
