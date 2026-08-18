'use client';

import { benchmarkSentence, ordinal } from '@/lib/benchmark';
import { COLORS, MIN_BENCHMARK_SAMPLES } from '@/lib/constants';
import { riskColorFor } from '@/lib/scoring';
import type { BenchmarkResult } from '@/lib/types';

const TONE_COLORS = {
  good: COLORS.good,
  warn: COLORS.warn,
  bad: COLORS.bad,
} as const;

interface BenchmarkChartProps {
  score: number;
  benchmark: BenchmarkResult | null;
  /** Named in the summary sentence rather than addressed as "you". */
  domain: string;
}

/** The pool is never described as "the industry" — only as what it is. */
function poolLabel(benchmark: BenchmarkResult | null): string {
  if (!benchmark) return 'domains assessed by Klyro';
  switch (benchmark.scope) {
    case 'industry-region':
      return `${benchmark.industry} domains in ${benchmark.region} assessed by Klyro`;
    case 'industry':
      return `${benchmark.industry} domains assessed by Klyro, all regions`;
    default:
      return 'all domains assessed by Klyro, every industry';
  }
}

export default function BenchmarkChart({ score, benchmark, domain }: BenchmarkChartProps) {
  const hasData = Boolean(benchmark && benchmark.totalScans > 0);

  const bars = [
    { name: 'This domain', value: score, fill: TONE_COLORS[riskColorFor(score)], strong: true },
    { name: 'Pool average', value: benchmark?.industryAverage ?? 0, fill: '#9AA1AD', strong: false },
    { name: 'Pool best', value: benchmark?.industryBest ?? 0, fill: '#3A414D', strong: false },
  ];

  return (
    <section className="panel flex flex-col">
      <div className="flex flex-wrap items-start justify-between gap-4 px-5 py-5 sm:px-6">
        <div>
          <p className="micro">Benchmark</p>
          {/* The heading names the pool that was actually used, not the one
              the user selected — those diverge whenever the exact pool was too
              small and the comparison fell back to a broader one. */}
          <h2 className="mt-2 text-[17px] font-semibold tracking-tight text-tx">
            {!benchmark || benchmark.scope === 'none'
              ? 'Peer comparison'
              : benchmark.scope === 'industry-region'
                ? `${benchmark.industry} / ${benchmark.region}`
                : benchmark.scope === 'industry'
                  ? `${benchmark.industry} / all regions`
                  : 'All industries / all regions'}
          </h2>
          <p className="mt-1.5 text-[11.5px] leading-relaxed text-tx-3">
            Compared against {poolLabel(benchmark)}.
          </p>
        </div>

        {hasData && benchmark && benchmark.percentileRank !== null && (
          <div className="text-right">
            <div className="num text-[30px] font-semibold leading-none text-tx">
              {ordinal(benchmark.percentileRank)}
            </div>
            <div className="micro mt-2">percentile</div>
          </div>
        )}
      </div>

      {hasData ? (
        <>
          <div className="rule" />
          <div className="space-y-4 px-5 py-5 sm:px-6">
            {bars.map((bar) => (
              <div key={bar.name}>
                <div className="flex items-baseline justify-between">
                  <span
                    className={`text-[12px] ${bar.strong ? 'font-medium text-tx' : 'text-tx-2'}`}
                  >
                    {bar.name}
                  </span>
                  <span
                    className="font-mono text-[12px] tabular-nums"
                    style={{ color: bar.strong ? bar.fill : undefined }}
                  >
                    <span className={bar.strong ? '' : 'text-tx-2'}>{bar.value}</span>
                  </span>
                </div>
                <div className="mt-1.5 h-[6px] w-full bg-line">
                  <div
                    className="h-full origin-left animate-sweep"
                    style={{ width: `${Math.max(0, Math.min(100, bar.value))}%`, background: bar.fill }}
                  />
                </div>
              </div>
            ))}
          </div>

          <div className="rule" />
          <dl className="grid grid-cols-2 sm:grid-cols-4">
            {[
              { label: 'Pool size', value: benchmark?.totalScans ?? 0 },
              { label: 'Median', value: benchmark?.industryMedian ?? 0 },
              { label: 'Average', value: benchmark?.industryAverage ?? 0 },
              { label: 'Best', value: benchmark?.industryBest ?? 0 },
            ].map((stat, i) => (
              <div
                key={stat.label}
                className={`border-line px-5 py-4 sm:px-6 ${i > 0 ? 'border-l' : ''} ${
                  i === 2 ? 'border-l-0 border-t sm:border-l sm:border-t-0' : ''
                } ${i === 3 ? 'border-t sm:border-t-0' : ''}`}
              >
                <dt className="micro">{stat.label}</dt>
                <dd className="num mt-2 text-[22px] font-semibold leading-none text-tx">
                  {stat.value}
                </dd>
              </div>
            ))}
          </dl>
        </>
      ) : (
        <>
          <div className="rule" />
          <div className="px-5 py-6 sm:px-6">
            <p className="text-[13px] font-medium text-tx">Benchmark data is being collected.</p>
            <p className="mt-2 max-w-md text-[12px] leading-relaxed text-tx-2">
              This scan contributes to the dataset. Once {MIN_BENCHMARK_SAMPLES} domains in this
              industry and region have been assessed, a position against them appears here. The pool
              is a sample of domains submitted to Klyro, not a representative survey of any industry.
            </p>
          </div>
        </>
      )}

      <div className="mt-auto">
        <div className="rule" />
        <div className="px-5 py-4 sm:px-6">
          <p className="text-[12.5px] leading-relaxed text-tx-2">
            {benchmarkSentence(benchmark, score, domain)}
          </p>
          {benchmark?.insufficientData && hasData && (
            <p className="mt-2 text-[11.5px] leading-relaxed text-risk-warn">
              Sample size is below the threshold for a firm benchmark
              {benchmark.scope === 'global'
                ? ' — showing global averages across all industries.'
                : benchmark.scope === 'industry'
                  ? ' — showing this industry across all regions.'
                  : '.'}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
