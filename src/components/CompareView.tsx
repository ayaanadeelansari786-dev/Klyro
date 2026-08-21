'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { PageFooter, Wordmark } from '@/components/Chrome';
import ThemeToggle from '@/components/ThemeToggle';
import { comparisonHeadline } from '@/lib/compare';
import { SEVERITY_COLORS } from '@/lib/constants';
import { isLegacyFinding } from '@/lib/dataset/history';
import { parseDomain } from '@/lib/domain';
import type { Finding, ScanComparison } from '@/lib/types';

interface AvailableRun {
  scannedAt: string;
  compositeScore: number;
  coverage: number;
}

interface CompareResponse {
  domain: string;
  available: AvailableRun[];
  comparison: ScanComparison | null;
  error?: string;
}

function formatRun(run: AvailableRun): string {
  const when = new Date(run.scannedAt);
  const date = Number.isNaN(when.getTime())
    ? run.scannedAt
    : when.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
  return `${date} — scored ${run.compositeScore}, ${Math.round(run.coverage * 100)}% assessed`;
}

export default function CompareView() {
  const searchParams = useSearchParams();
  const domainParam = searchParams.get('domain') ?? '';

  const [domain, setDomain] = useState(domainParam);
  const [data, setData] = useState<CompareResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [baseline, setBaseline] = useState<string>('');
  const [current, setCurrent] = useState<string>('');

  const load = useCallback(
    async (target: string, from?: string, to?: string) => {
      const parsed = parseDomain(target);
      if (!parsed.ok) {
        setData({ domain: target, available: [], comparison: null, error: parsed.error });
        return;
      }

      setLoading(true);
      try {
        const query = new URLSearchParams({ domain: parsed.domain });
        if (from) query.set('baseline', from);
        if (to) query.set('current', to);

        const res = await fetch(`/api/compare?${query.toString()}`);
        const payload = (await res.json()) as CompareResponse;
        setData(payload);

        // Adopt whichever two runs the server actually used, so the selects
        // reflect what is on screen rather than what was asked for.
        if (payload.comparison) {
          setBaseline(payload.comparison.baseline.scannedAt);
          setCurrent(payload.comparison.current.scannedAt);
        }
      } catch {
        setData({
          domain: parsed.domain,
          available: [],
          comparison: null,
          error: 'The comparison could not be loaded.',
        });
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (domainParam) void load(domainParam);
  }, [domainParam, load]);

  const comparison = data?.comparison ?? null;

  const scoreTone = useMemo(() => {
    if (!comparison) return 'text-tx';
    if (comparison.scoreDelta > 0) return 'text-risk-good';
    if (comparison.scoreDelta < 0) return 'text-risk-bad';
    return 'text-tx-2';
  }, [comparison]);

  return (
    <div className="mx-auto w-full max-w-[1180px] px-5 pb-24 pt-8 sm:px-8">
      <header className="flex flex-wrap items-center justify-between gap-4 pb-8">
        <Wordmark />
        <div className="flex items-center gap-5">
          <Link
            href="/"
            className="font-mono text-[11px] uppercase tracking-[0.1em] text-tx-3 underline-offset-4 hover:text-tx hover:underline"
          >
            New assessment
          </Link>
          <ThemeToggle />
        </div>
      </header>

      <section className="panel">
        <div className="px-5 py-5 sm:px-6">
          <p className="micro">Comparison</p>
          <h1 className="mt-2 text-[22px] font-semibold tracking-tight text-tx">
            What changed between two assessments
          </h1>
          <p className="mt-2 max-w-2xl text-[12.5px] leading-relaxed text-tx-3">
            Two point-in-time observations, diffed on request. Nothing here reassesses on a
            schedule and nothing is known about the interval between the two runs — a finding
            absent from the later scan is reported as no longer observed, never as fixed.
          </p>

          <form
            className="mt-5 flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void load(domain);
            }}
          >
            <label className="flex-1 min-w-[240px]">
              <span className="micro">Domain</span>
              <input
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
                placeholder="acme.com"
                className="mt-2 w-full border border-line bg-ground px-3 py-2 font-mono text-[13px] text-tx outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-seal-ink  focus:border-line-strong"
              />
            </label>
            <button
              type="submit"
              disabled={loading}
              className="border border-line-strong px-4 py-2 font-mono text-[11px] uppercase tracking-[0.1em] text-tx transition-colors hover:bg-raised disabled:opacity-50"
            >
              {loading ? 'Loading…' : 'Compare'}
            </button>
          </form>
        </div>

        {data && data.available.length >= 2 && (
          <>
            <div className="rule" />
            <div className="grid gap-4 px-5 py-5 sm:grid-cols-2 sm:px-6">
              {(
                [
                  ['Earlier assessment', baseline, setBaseline],
                  ['Later assessment', current, setCurrent],
                ] as const
              ).map(([label, value, setter]) => (
                <label key={label}>
                  <span className="micro">{label}</span>
                  <select
                    value={value}
                    onChange={(e) => {
                      setter(e.target.value);
                      void load(
                        data.domain,
                        label === 'Earlier assessment' ? e.target.value : baseline,
                        label === 'Later assessment' ? e.target.value : current,
                      );
                    }}
                    className="mt-2 w-full border border-line bg-ground px-3 py-2 text-[12.5px] text-tx focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-seal-ink outline-none focus:border-line-strong"
                  >
                    {data.available.map((run) => (
                      <option key={run.scannedAt} value={run.scannedAt}>
                        {formatRun(run)}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
          </>
        )}
      </section>

      {data?.error && (
        <section className="panel mt-4 px-5 py-5 sm:px-6">
          <p className="text-[13px] leading-relaxed text-tx-2">{data.error}</p>
          {data.available.length === 1 && (
            <Link
              href={`/results?domain=${encodeURIComponent(data.domain)}&industry=Technology&region=Global`}
              className="mt-3 inline-block font-mono text-[11px] uppercase tracking-[0.1em] text-tx-3 underline-offset-4 hover:text-tx hover:underline"
            >
              Run a second assessment
            </Link>
          )}
        </section>
      )}

      {comparison && (
        <>
          {/* ---------- Headline ---------- */}
          <section className="panel mt-4">
            <div className="grid gap-6 px-5 py-6 sm:grid-cols-[auto_minmax(0,1fr)] sm:px-6">
              <div>
                <p className="micro">Score change</p>
                <div className={`num mt-2 text-[42px] font-semibold leading-none ${scoreTone}`}>
                  {comparison.scoreDelta > 0 ? '+' : ''}
                  {comparison.scoreDelta}
                </div>
                <p className="mt-2 font-mono text-[11px] text-tx-3">
                  {comparison.baseline.compositeScore} → {comparison.current.compositeScore}
                </p>
              </div>

              <div>
                <p className="text-[15px] font-medium leading-snug text-tx">
                  {comparisonHeadline(comparison)}
                </p>
                <dl className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
                  {[
                    { label: 'New', value: comparison.newFindings.length },
                    { label: 'No longer seen', value: comparison.resolvedFindings.length },
                    { label: 'Severity changed', value: comparison.severityChanges.length },
                    { label: 'Unchanged', value: comparison.unchangedCount },
                  ].map((stat) => (
                    <div key={stat.label}>
                      <dt className="micro">{stat.label}</dt>
                      <dd className="num mt-1.5 text-[22px] font-semibold leading-none text-tx">
                        {stat.value}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            </div>
          </section>

          {/* ---------- Category movement ---------- */}
          <section className="panel mt-4">
            <div className="px-5 py-5 sm:px-6">
              <p className="micro">Category movement</p>
              <ul className="mt-4 space-y-2.5">
                {comparison.categoryDeltas.map((delta) => (
                  <li key={delta.key} className="flex items-baseline justify-between gap-4">
                    <span className="text-[12.5px] text-tx">{delta.label}</span>
                    <span className="shrink-0 font-mono text-[11.5px] tabular-nums text-tx-3">
                      {delta.delta === null ? (
                        <span title="One of the two runs did not assess this category">
                          {delta.from ?? 'n/a'} → {delta.to ?? 'n/a'} · not comparable
                        </span>
                      ) : (
                        <>
                          {delta.from} → {delta.to}{' '}
                          <span
                            className={
                              delta.delta > 0
                                ? 'text-risk-good'
                                : delta.delta < 0
                                  ? 'text-risk-bad'
                                  : 'text-tx-3'
                            }
                          >
                            {delta.delta > 0 ? '+' : ''}
                            {delta.delta}
                          </span>
                        </>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </section>

          {/* ---------- Finding movement ---------- */}
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <FindingList
              title="New findings"
              blurb="Present in the later assessment and not the earlier one."
              findings={comparison.newFindings}
              empty="No findings appeared that were not there before."
            />
            <FindingList
              title="No longer observed"
              blurb="Present in the earlier assessment and not the later one. Confirm before reporting any of these as remediated."
              findings={comparison.resolvedFindings}
              empty="Everything seen in the earlier assessment was seen again."
            />
          </div>

          {comparison.severityChanges.length > 0 && (
            <section className="panel mt-4">
              <div className="px-5 py-5 sm:px-6">
                <p className="micro">Severity changed</p>
                <ul className="mt-4 space-y-3">
                  {comparison.severityChanges.map(({ finding, from, to }) => (
                    <li key={finding.id}>
                      <div className="flex flex-wrap items-baseline gap-x-3">
                        <span
                          className="font-mono text-[9.5px] uppercase tracking-[0.12em]"
                          style={{ color: SEVERITY_COLORS[from] }}
                        >
                          {from}
                        </span>
                        <span className="font-mono text-[10px] text-tx-3">→</span>
                        <span
                          className="font-mono text-[9.5px] uppercase tracking-[0.12em]"
                          style={{ color: SEVERITY_COLORS[to] }}
                        >
                          {to}
                        </span>
                        <span className="text-[12.5px] font-medium text-tx">{finding.title}</span>
                      </div>
                      <p className="mt-0.5 font-mono text-[10.5px] text-tx-3">
                        {finding.categoryLabel}
                      </p>
                    </li>
                  ))}
                </ul>
              </div>
            </section>
          )}

          {/* ---------- Assets ---------- */}
          {(comparison.newAssets.length > 0 || comparison.removedAssets.length > 0) && (
            <section className="panel mt-4">
              <div className="grid gap-6 px-5 py-5 sm:grid-cols-2 sm:px-6">
                <AssetList title="Host names added" hosts={comparison.newAssets} />
                <AssetList title="Host names no longer seen" hosts={comparison.removedAssets} />
              </div>
            </section>
          )}

          {/* ---------- Limits. Not collapsible, by design. ---------- */}
          <section className="panel mt-4">
            <div className="px-5 py-5 sm:px-6">
              <p className="micro">What a comparison of two scans cannot tell you</p>
              <ul className="mt-3 space-y-2">
                {comparison.limits.map((limit) => (
                  <li key={limit} className="flex gap-2.5 text-[11.5px] leading-relaxed text-tx-3">
                    <span
                      className="mt-[6px] h-[3px] w-[3px] shrink-0 rounded-full bg-tx-3"
                      aria-hidden="true"
                    />
                    <span>{limit}</span>
                  </li>
                ))}
              </ul>
            </div>
          </section>
        </>
      )}

      <PageFooter />
    </div>
  );
}

function FindingList({
  title,
  blurb,
  findings,
  empty,
}: {
  title: string;
  blurb: string;
  findings: Finding[];
  empty: string;
}) {
  const legacy = findings.filter(isLegacyFinding).length;

  return (
    <section className="panel">
      <div className="px-5 py-5 sm:px-6">
        <div className="flex items-baseline justify-between gap-4">
          <p className="micro">{title}</p>
          <span className="num text-[16px] font-semibold text-tx">{findings.length}</span>
        </div>
        <p className="mt-2 text-[11.5px] leading-relaxed text-tx-3">{blurb}</p>

        {findings.length === 0 ? (
          <p className="mt-4 text-[12.5px] leading-relaxed text-tx-2">{empty}</p>
        ) : (
          <ul className="mt-4 space-y-3">
            {findings.map((finding) => (
              <li key={finding.id}>
                <div className="flex flex-wrap items-baseline gap-x-3">
                  <span
                    className="font-mono text-[9.5px] uppercase tracking-[0.12em]"
                    style={{ color: SEVERITY_COLORS[finding.severity] }}
                  >
                    {finding.severity}
                  </span>
                  <span className="text-[12.5px] font-medium leading-snug text-tx">
                    {finding.title}
                  </span>
                </div>
                <p className="mt-0.5 font-mono text-[10.5px] text-tx-3">{finding.categoryLabel}</p>
              </li>
            ))}
          </ul>
        )}

        {legacy > 0 && (
          <p className="mt-4 border-t border-line pt-3 text-[11px] leading-relaxed text-tx-3">
            {legacy} of these {legacy === 1 ? 'was' : 'were'} recorded before Klyro separated
            observation from interpretation, so only the title, severity and category are
            available for {legacy === 1 ? 'it' : 'them'}. The comparison itself is unaffected —
            it matches on identity, which both formats carry.
          </p>
        )}
      </div>
    </section>
  );
}

function AssetList({ title, hosts }: { title: string; hosts: string[] }) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-4">
        <p className="micro">{title}</p>
        <span className="num text-[16px] font-semibold text-tx">{hosts.length}</span>
      </div>
      {hosts.length === 0 ? (
        <p className="mt-3 text-[12px] text-tx-3">None</p>
      ) : (
        <ul className="mt-3 space-y-1">
          {hosts.slice(0, 25).map((host) => (
            <li key={host} className="break-all font-mono text-[11.5px] text-tx-2">
              {host}
            </li>
          ))}
          {hosts.length > 25 && (
            <li className="font-mono text-[10.5px] text-tx-3">+{hosts.length - 25} more</li>
          )}
        </ul>
      )}
    </div>
  );
}
