import { MIN_BENCHMARK_SAMPLES } from './constants';
import { createPublicClient } from './supabase/public';
import type { BenchmarkResult } from './types';

interface PoolRow {
  domain: string;
  composite_score: number;
  category_scores: Record<string, number> | null;
  scanned_at: string | null;
}

/**
 * Rows are the full scan history, deliberately — every run is kept so scores
 * can be tracked over time. A benchmark built from that history counts a
 * domain once per scan, so re-seeding the reference dataset three times gave
 * every vendor in it triple weight in the average, median and percentile.
 *
 * One domain, one vote: the most recent scan of each. The domain being
 * assessed is dropped as well, since ranking a score against a pool that
 * contains that same score pulls the comparison toward itself.
 */
export function latestPerDomain(rows: PoolRow[], exclude?: string): PoolRow[] {
  const newest = new Map<string, PoolRow>();

  for (const row of rows) {
    const domain = (row.domain ?? '').toLowerCase();
    if (!domain) continue;
    if (exclude && domain === exclude.toLowerCase()) continue;

    const current = newest.get(domain);
    if (!current) {
      newest.set(domain, row);
      continue;
    }

    const a = Date.parse(row.scanned_at ?? '') || 0;
    const b = Date.parse(current.scanned_at ?? '') || 0;
    if (a > b) newest.set(domain, row);
  }

  return [...newest.values()];
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
    : sorted[mid];
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
}

/**
 * Percentile rank: the share of the pool this score beats or matches.
 * Reported as a whole number so the report can say "you rank in the Nth
 * percentile".
 */
export function percentile(pool: number[], score: number): number {
  if (pool.length === 0) return 0;
  const below = pool.filter((s) => s < score).length;
  const equal = pool.filter((s) => s === score).length;
  return Math.round(((below + equal * 0.5) / pool.length) * 100);
}

function summarise(
  rows: PoolRow[],
  scope: BenchmarkResult['scope'],
  industry: string,
  region: string,
  score: number | null,
): BenchmarkResult {
  const scores = rows.map((r) => r.composite_score).filter((s) => Number.isFinite(s));

  const categoryTotals = new Map<string, { sum: number; count: number }>();
  for (const row of rows) {
    for (const [key, value] of Object.entries(row.category_scores ?? {})) {
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;
      const entry = categoryTotals.get(key) ?? { sum: 0, count: 0 };
      entry.sum += value;
      entry.count += 1;
      categoryTotals.set(key, entry);
    }
  }

  const categoryAverages: Record<string, number> = {};
  for (const [key, { sum, count }] of categoryTotals) {
    categoryAverages[key] = Math.round(sum / count);
  }

  const insufficientData = scores.length < MIN_BENCHMARK_SAMPLES;

  /*
   * A percentile is only published when the comparison is like-for-like and
   * the pool is large enough to mean something: the exact industry+region, at
   * or above the sample threshold. Broader fallback pools still provide an
   * average for context, but ranking a bank against a mixed global pool of
   * every industry would be a fabricated statistic.
   */
  const canRank =
    score !== null && scope === 'industry-region' && !insufficientData && scores.length > 0;

  return {
    industry,
    region,
    industryAverage: mean(scores),
    industryMedian: median(scores),
    industryBest: scores.length ? Math.max(...scores) : 0,
    percentileRank: canRank ? percentile(scores, score as number) : null,
    categoryAverages,
    totalScans: scores.length,
    insufficientData,
    scope,
  };
}

const EMPTY_BENCHMARK = (industry: string, region: string): BenchmarkResult => ({
  industry,
  region,
  industryAverage: 0,
  industryMedian: 0,
  industryBest: 0,
  percentileRank: null,
  categoryAverages: {},
  totalScans: 0,
  insufficientData: true,
  scope: 'none',
});

/**
 * Benchmarks against the tightest pool that has enough samples:
 * industry+region → industry → global. Every pool is reported with the scope
 * it came from so the UI and PDF can be honest about what is being compared.
 */
export async function getBenchmark(
  industry: string,
  region: string,
  score: number | null,
  /** The domain being assessed, excluded so it is not ranked against itself. */
  excludeDomain?: string,
): Promise<BenchmarkResult> {
  const supabase = createPublicClient();
  if (!supabase) return EMPTY_BENCHMARK(industry, region);

  const select = 'domain, composite_score, category_scores, scanned_at';

  // Read history, then reduce to one row per domain. The cap is on rows read,
  // not domains compared, so it is set well above the distinct-domain count the
  // dataset is expected to reach.
  const ROW_CAP = 5_000;

  try {
    const exact = await supabase
      .from('benchmark_samples')
      .select(select)
      .eq('industry', industry)
      .eq('region', region)
      .order('scanned_at', { ascending: false })
      .limit(ROW_CAP);

    const exactPool = exact.error ? [] : latestPerDomain((exact.data ?? []) as PoolRow[], excludeDomain);

    if (exactPool.length >= MIN_BENCHMARK_SAMPLES) {
      return summarise(exactPool, 'industry-region', industry, region, score);
    }

    const byIndustry = await supabase
      .from('benchmark_samples')
      .select(select)
      .eq('industry', industry)
      .order('scanned_at', { ascending: false })
      .limit(ROW_CAP);

    const industryPool = byIndustry.error
      ? []
      : latestPerDomain((byIndustry.data ?? []) as PoolRow[], excludeDomain);

    if (industryPool.length >= MIN_BENCHMARK_SAMPLES) {
      const result = summarise(industryPool, 'industry', industry, region, score);
      return { ...result, insufficientData: true };
    }

    const global = await supabase
      .from('benchmark_samples')
      .select(select)
      .order('scanned_at', { ascending: false })
      .limit(ROW_CAP);

    const globalPool = global.error
      ? []
      : latestPerDomain((global.data ?? []) as PoolRow[], excludeDomain);

    if (globalPool.length > 0) {
      const result = summarise(globalPool, 'global', industry, region, score);
      return { ...result, insufficientData: true };
    }

    // Nothing stored yet, but keep any partial pool we did read.
    const fallbackRows = exactPool.length ? exactPool : industryPool;
    const result = summarise(fallbackRows, 'industry-region', industry, region, score);
    return { ...result, insufficientData: true };
  } catch {
    return EMPTY_BENCHMARK(industry, region);
  }
}

/**
 * Human sentence describing the comparison, reused by the dashboard and PDF.
 *
 * Names the domain rather than saying "your score": the subject of a Klyro
 * assessment is usually a supplier being evaluated, not the reader's own
 * estate, and second person makes the report read as though it were about
 * whoever is holding it.
 */
export function benchmarkSentence(
  benchmark: BenchmarkResult | null,
  score: number,
  domain?: string,
): string {
  const subject = domain ?? 'This domain';

  if (!benchmark || benchmark.totalScans === 0) {
    return `Benchmark data is being collected. This assessment contributes to that dataset, and a position will appear once enough comparable domains have been scanned.`;
  }

  /*
   * The pool is described as "domains assessed by Klyro", never as "companies
   * in your industry". It is a convenience sample of whatever anyone chose to
   * scan, and describing it as an industry sample would overstate it.
   */
  const plural = benchmark.totalScans === 1 ? 'domain' : 'domains';
  const poolLabel =
    benchmark.scope === 'industry-region'
      ? `${benchmark.industry} ${plural} assessed by Klyro in ${benchmark.region}`
      : benchmark.scope === 'industry'
        ? `${benchmark.industry} ${plural} assessed by Klyro worldwide`
        : `${plural} assessed by Klyro across all industries`;

  // One row per domain, so this is a count of organisations rather than runs.
  const pool = `${benchmark.totalScans} ${poolLabel}`;

  /*
   * A percentile is withheld for two different reasons, and saying the wrong
   * one is worse than saying neither.
   *
   * Too few domains is one. The other is scope: a pool can be hundreds of
   * domains deep and still not support a ranking, because it fell back to
   * every industry worldwide and a bank ranked against that pool is being
   * ranked against nothing in particular. The old sentence gave the size
   * reason in both cases, so a 151-domain global pool was described as being
   * "below the 30-domain threshold" — a statement the reader could see was
   * false from the same sentence.
   */
  if (benchmark.insufficientData || benchmark.percentileRank === null) {
    const reason =
      benchmark.totalScans < MIN_BENCHMARK_SAMPLES
        ? `That pool is below the ${MIN_BENCHMARK_SAMPLES}-domain threshold for a ranking, so no percentile is given`
        : benchmark.scope === 'industry'
          ? `No ${benchmark.region} pool of ${benchmark.industry} domains has reached the ${MIN_BENCHMARK_SAMPLES}-domain threshold, so this compares against the industry worldwide and no percentile is given`
          : `No pool of ${benchmark.industry} domains has reached the ${MIN_BENCHMARK_SAMPLES}-domain threshold, so this compares against every industry at once and no percentile is given`;

    return `${subject} scores ${score} against an average of ${benchmark.industryAverage} across ${pool}. ${reason} — treat this as context, not a benchmark.`;
  }

  const delta = score - benchmark.industryAverage;

  if (delta === 0) {
    return `${subject} scores ${score}, level with the average across ${pool}, placing it in the ${ordinal(benchmark.percentileRank)} percentile of that group.`;
  }

  const direction = delta > 0 ? 'above' : 'below';

  return `${subject} scores ${score}, ${Math.abs(delta)} ${Math.abs(delta) === 1 ? 'point' : 'points'} ${direction} the average of ${benchmark.industryAverage} across ${pool}, placing it in the ${ordinal(benchmark.percentileRank)} percentile of that group.`;
}

export function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}
