'use client';

import Link from 'next/link';
import { Fragment, useEffect, useMemo, useState } from 'react';

import { PageFooter, Wordmark } from '@/components/Chrome';
import ThemeToggle from '@/components/ThemeToggle';
import { COLORS, INDUSTRIES } from '@/lib/constants';
import { riskColorFor } from '@/lib/scoring';
import type { IndustrySummaryRow, LeaderboardRow, RankingsPayload } from '@/lib/dataset/rankings';

const TONE = { good: COLORS.good, warn: COLORS.warn, bad: COLORS.bad } as const;

const LINKAGE_LABEL: Record<string, string> = {
  integrated: 'Runs on parent infrastructure',
  partially_integrated: 'Partly on parent infrastructure',
  independent: 'Independent infrastructure',
  unknown: 'Linkage not established',
};

const LINKAGE_TONE: Record<string, string> = {
  integrated: 'text-tx-2',
  partially_integrated: 'text-risk-warn',
  independent: 'text-tx-3',
  unknown: 'text-tx-3',
};

function Delta({ delta }: { delta: number | null }) {
  if (delta === null || delta === 0) {
    return (
      <span className="font-mono text-[11.5px] text-tx-3 tabular-nums">
        {delta === 0 ? '0' : '—'}
      </span>
    );
  }
  const up = delta > 0;
  return (
    <span
      className="font-mono text-[11.5px] tabular-nums"
      style={{ color: up ? COLORS.good : COLORS.bad }}
      title={`${up ? 'Improved' : 'Declined'} by ${Math.abs(delta)} points since the previous run`}
    >
      {up ? '+' : '−'}
      {Math.abs(delta)}
    </span>
  );
}

function DetailRow({ row, onClose }: { row: LeaderboardRow; onClose: () => void }) {
  const [history, setHistory] = useState<{ composite_score: number; scanned_at: string }[]>([]);

  useEffect(() => {
    fetch(`/api/rankings?history=${encodeURIComponent(row.domain)}`)
      .then((r) => r.json())
      .then((d) => setHistory(d.history ?? []))
      .catch(() => setHistory([]));
  }, [row.domain]);

  return (
    <tr className="border-b border-line bg-raised">
      <td colSpan={6} className="px-5 py-6 sm:px-6">
        <div className="flex flex-wrap items-start justify-between gap-6">
          <div className="min-w-0">
            <h3 className="text-[17px] font-semibold tracking-tight text-tx">
              {row.display_name ?? row.domain}
            </h3>
            <p className="mt-1 font-mono text-[12px] text-tx-2">{row.domain}</p>
            <div className="mt-3 flex flex-wrap gap-1.5">
              <span className="chip">{row.industry}</span>
              <span className="chip">{row.region}</span>
              <span className="chip">
                #{row.industry_rank} of {row.industry_size} in industry
              </span>
              <span className="chip">
                #{row.overall_rank} of {row.overall_size} overall
              </span>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="text-tx-3 transition-colors duration-150 hover:text-tx"
            aria-label="Close detail"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {history.length > 1 && (
          <div className="mt-6 border-t border-line pt-4">
            <p className="micro">Score history · {history.length} runs</p>
            <div className="mt-4 flex items-end gap-1.5">
              {history.map((h, i) => (
                <div key={i} className="flex flex-col items-center gap-1.5">
                  <div
                    className="w-8"
                    style={{
                      height: `${Math.max(3, h.composite_score * 0.5)}px`,
                      background: TONE[riskColorFor(h.composite_score)],
                      opacity: i === history.length - 1 ? 1 : 0.35,
                    }}
                    title={`${h.composite_score} on ${new Date(h.scanned_at).toLocaleString()}`}
                  />
                  <span className="font-mono text-[10px] text-tx-3 tabular-nums">
                    {h.composite_score}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {row.ownership_narrative && (
          <div className="mt-6 border-t border-line pt-4">
            <p className="micro">Ownership &amp; parent influence</p>
            <div className="mt-2.5 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-[12px]">
              <span className="text-tx">{row.parent_name}</span>
              {row.parent_score !== null && (
                <span className="text-tx-3">
                  parent scores{' '}
                  <span className="font-mono text-tx-2 tabular-nums">{row.parent_score}</span>
                </span>
              )}
              <span className="text-tx-3">ownership {row.ownership_confidence ?? 'unknown'}</span>
            </div>
            <p className="mt-2.5 max-w-4xl text-[12.5px] leading-relaxed text-tx-2">
              {row.ownership_narrative}
            </p>
          </div>
        )}

        <div className="mt-6 flex flex-wrap items-center gap-4 border-t border-line pt-4">
          <Link
            href={`/results?domain=${row.domain}&industry=${encodeURIComponent(row.industry)}&region=${encodeURIComponent(row.region)}`}
            className="btn-ghost"
          >
            Run a fresh assessment
          </Link>
          <span className="text-[11.5px] text-tx-3">
            Last assessed {new Date(row.scanned_at).toLocaleString()}
            {row.coverage !== null && ` · ${Math.round(row.coverage * 100)}% coverage`}
          </span>
        </div>
      </td>
    </tr>
  );
}

export default function RankingsView() {
  const [data, setData] = useState<RankingsPayload | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error' | 'empty'>('loading');
  const [industry, setIndustry] = useState<string>('all');
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/rankings')
      .then((r) => r.json())
      .then((d: RankingsPayload) => {
        if (!d.configured) return setState('error');
        setData(d);
        setState(d.rows.length ? 'ready' : 'empty');
      })
      .catch(() => setState('error'));
  }, []);

  const rows = useMemo(() => {
    if (!data) return [];
    const filtered =
      industry === 'all' ? data.rows : data.rows.filter((r) => r.industry === industry);
    return [...filtered].sort((a, b) =>
      industry === 'all' ? b.composite_score - a.composite_score : a.industry_rank - b.industry_rank,
    );
  }, [data, industry]);

  const summary: IndustrySummaryRow | undefined = data?.industries.find(
    (i) => i.industry === industry,
  );

  return (
    <>
      <header className="sticky top-0 z-40 border-b border-line bg-ground/85 backdrop-blur-md">
        <div className="mx-auto flex h-14 w-full max-w-[1180px] items-center justify-between px-5 sm:px-8">
          <div className="flex items-center gap-4">
            <Wordmark />
            <span className="hidden h-3 w-px bg-line-strong sm:block" aria-hidden="true" />
            <span className="micro hidden sm:block">Benchmark dataset</span>
          </div>
          <div className="flex items-center gap-4">
            <ThemeToggle />
            <Link href="/" className="btn-ghost px-3 py-2 text-[12.5px]">
              New assessment
            </Link>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1180px] px-5 pb-16 sm:px-8">
        <div className="grid gap-10 py-12 lg:grid-cols-[minmax(0,1fr)_360px] lg:items-end">
          <div>
            <p className="micro">Vendor benchmark</p>
            <h1 className="wide mt-5 max-w-[16ch] text-balance text-[40px] font-semibold leading-[0.96] tracking-[-0.03em] text-tx sm:text-[52px]">
              Ranked by what they leave exposed.
            </h1>
            <p className="mt-6 max-w-[54ch] text-[13.5px] leading-relaxed text-tx-2">
              Every vendor in the dataset, scored by the same checks and ranked within its
              industry. The change column is real movement since that vendor&apos;s previous run.
              Where a corporate parent exists it is named, and its influence is measured rather than
              assumed.
            </p>
          </div>

          {state === 'ready' && data && (
            <dl className="panel grid grid-cols-3">
              {[
                { label: 'Vendors', value: data.rows.length },
                { label: 'Industries', value: data.industries.length },
                {
                  label: 'With a parent',
                  value: data.rows.filter((r) => r.parent_name).length,
                },
              ].map((stat, i) => (
                <div key={stat.label} className={`px-5 py-4 ${i > 0 ? 'border-l border-line' : ''}`}>
                  <dt className="micro">{stat.label}</dt>
                  <dd className="num mt-2 text-[26px] font-semibold leading-none text-tx">
                    {stat.value}
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </div>

        {state === 'loading' && (
          <div className="flex items-center gap-3 py-10 text-[12.5px] text-tx-2">
            <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-line-strong border-t-tx-2" />
            Loading benchmark dataset
          </div>
        )}

        {state === 'error' && (
          <div className="panel p-8">
            <p className="text-[13.5px] text-tx">The benchmark dataset is not available.</p>
            <p className="mt-2 text-[12.5px] text-tx-2">
              Supabase is not configured, or the dataset has not been seeded yet.
            </p>
          </div>
        )}

        {state === 'empty' && (
          <div className="panel p-8">
            <p className="text-[13.5px] text-tx">No vendors have been assessed yet.</p>
            <p className="mt-2 text-[12.5px] text-tx-2">
              Run <span className="font-mono text-tx">node scripts/seed.mjs</span> to build the
              dataset.
            </p>
          </div>
        )}

        {state === 'ready' && data && (
          <>
            <div className="no-scrollbar -mx-1 flex gap-1.5 overflow-x-auto pb-1">
              {[{ name: 'All industries', key: 'all', count: data.rows.length }]
                .concat(
                  INDUSTRIES.filter((name) =>
                    data.industries.some((i) => i.industry === name),
                  ).map((name) => ({
                    name,
                    key: name,
                    count: data.industries.find((i) => i.industry === name)?.vendors ?? 0,
                  })),
                )
                .map((item) => {
                  const active = industry === item.key;
                  return (
                    <button
                      key={item.key}
                      type="button"
                      onClick={() => {
                        setIndustry(item.key);
                        setSelected(null);
                      }}
                      className={`inline-flex shrink-0 items-center gap-2 rounded border px-3 py-1.5
                        text-[12px] transition-colors duration-150 ${
                          active
                            ? 'border-tx-2 bg-raised text-tx'
                            : 'border-line text-tx-2 hover:border-line-strong hover:text-tx'
                        }`}
                    >
                      {item.name}
                      <span className="font-mono text-[10.5px] text-tx-3 tabular-nums">
                        {item.count}
                      </span>
                    </button>
                  );
                })}
            </div>

            {summary && (
              <dl className="panel mt-4 grid grid-cols-2 sm:grid-cols-5">
                {[
                  { label: 'Vendors', value: summary.vendors },
                  { label: 'Average', value: summary.average_score },
                  { label: 'Median', value: summary.median_score },
                  { label: 'Best', value: summary.max_score },
                  { label: 'Weakest', value: summary.min_score },
                ].map((stat, i) => (
                  <div
                    key={stat.label}
                    className={`border-line px-5 py-4 ${i > 0 ? 'border-l' : ''} ${
                      i >= 2 ? 'border-t sm:border-t-0' : ''
                    } ${i === 2 ? 'border-l-0 sm:border-l' : ''}`}
                  >
                    <dt className="micro">{stat.label}</dt>
                    <dd className="num mt-2 text-[22px] font-semibold leading-none text-tx">
                      {stat.value}
                    </dd>
                  </div>
                ))}
              </dl>
            )}

            <section className="panel mt-4 overflow-hidden">
              <div className="relative overflow-x-auto">
                <table className="w-full min-w-[760px] border-collapse text-left">
                  <thead>
                    <tr className="border-b border-line bg-panel">
                      {[
                        ['#', 'w-[52px] text-right'],
                        ['Vendor', ''],
                        ['Corporate parent', 'w-[240px]'],
                        ['Region', 'w-[120px]'],
                        ['Change', 'w-[80px] text-right'],
                        ['Score', 'w-[150px] text-right'],
                      ].map(([label, cls]) => (
                        <th key={label} className={`micro px-4 py-2.5 font-medium ${cls}`}>
                          {label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => {
                      const tone = TONE[riskColorFor(row.composite_score)];
                      const isOpen = selected === row.domain;
                      const rank = industry === 'all' ? row.overall_rank : row.industry_rank;

                      return (
                        <Fragment key={row.domain}>
                          <tr
                            onClick={() => setSelected(isOpen ? null : row.domain)}
                            className={`cursor-pointer border-b border-line transition-colors duration-150
                              hover:bg-raised ${isOpen ? 'bg-raised' : ''}`}
                          >
                            <td className="px-4 py-3 text-right align-middle">
                              <span className="font-mono text-[12px] text-tx-3 tabular-nums">
                                {rank}
                              </span>
                            </td>

                            <td className="px-4 py-3 align-middle">
                              <div className="text-[13px] font-medium leading-tight text-tx">
                                {row.display_name ?? row.domain}
                              </div>
                              <div className="mt-0.5 font-mono text-[11px] text-tx-3">
                                {row.domain}
                              </div>
                            </td>

                            <td className="px-4 py-3 align-middle">
                              {row.parent_name ? (
                                <>
                                  <div className="text-[12px] leading-tight text-tx-2">
                                    {row.parent_name}
                                  </div>
                                  {row.linkage_verdict && (
                                    <div
                                      className={`mt-0.5 text-[11px] ${
                                        LINKAGE_TONE[row.linkage_verdict] ?? 'text-tx-3'
                                      }`}
                                    >
                                      {LINKAGE_LABEL[row.linkage_verdict]}
                                    </div>
                                  )}
                                </>
                              ) : (
                                <span className="text-[12px] text-tx-3">Independent</span>
                              )}
                            </td>

                            <td className="px-4 py-3 align-middle text-[12px] text-tx-2">
                              {row.region}
                            </td>

                            <td className="px-4 py-3 text-right align-middle">
                              <Delta delta={row.score_delta} />
                            </td>

                            <td className="px-4 py-3 align-middle">
                              <div className="flex items-center justify-end gap-3">
                                <span className="relative block h-[6px] w-20 bg-line">
                                  <span
                                    className="absolute inset-y-0 left-0"
                                    style={{
                                      width: `${row.composite_score}%`,
                                      background: tone,
                                    }}
                                  />
                                </span>
                                <span
                                  className="w-6 text-right font-mono text-[13px] font-medium tabular-nums"
                                  style={{ color: tone }}
                                >
                                  {row.composite_score}
                                </span>
                              </div>
                            </td>
                          </tr>

                          {isOpen && <DetailRow row={row} onClose={() => setSelected(null)} />}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>

            <p className="mt-6 max-w-4xl text-[11.5px] leading-relaxed text-tx-3">
              This is a convenience sample of {data.rows.length} domains selected for the benchmark,
              not a representative survey of any industry. Ranks compare vendors against the others
              in this dataset only. A parent company&apos;s reputation is never transferred to a
              subsidiary&apos;s score — where a relationship exists, infrastructure overlap between
              the two is measured and reported instead.
            </p>
          </>
        )}

        <PageFooter>
          Scores are produced by passive reconnaissance against publicly available information. No
          vendor systems were accessed or tested.
        </PageFooter>
      </main>
    </>
  );
}
