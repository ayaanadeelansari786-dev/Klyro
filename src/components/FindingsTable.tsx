'use client';

import { Fragment, useMemo, useState } from 'react';

import FindingDetail from '@/components/FindingDetail';
import { SEVERITY_COLORS, SEVERITY_ORDER } from '@/lib/constants';
import type { Finding, Severity } from '@/lib/types';

type SortKey = 'severity' | 'category' | 'title';

const SEVERITY_LABEL: Record<Severity, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  info: 'Info',
};

export default function FindingsTable({ findings }: { findings: Finding[] }) {
  const [sortKey, setSortKey] = useState<SortKey>('severity');
  const [ascending, setAscending] = useState(true);
  const [filter, setFilter] = useState<Severity | 'all'>('all');
  const [expanded, setExpanded] = useState<string | null>(null);

  const counts = useMemo(() => {
    const base: Record<string, number> = { all: findings.length };
    for (const finding of findings) {
      base[finding.severity] = (base[finding.severity] ?? 0) + 1;
    }
    return base;
  }, [findings]);

  const rows = useMemo(() => {
    const filtered = filter === 'all' ? findings : findings.filter((f) => f.severity === filter);

    return [...filtered].sort((a, b) => {
      let result = 0;
      if (sortKey === 'severity') {
        result = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
        if (result === 0) result = a.title.localeCompare(b.title);
      } else if (sortKey === 'category') {
        result = a.categoryLabel.localeCompare(b.categoryLabel);
      } else {
        result = a.title.localeCompare(b.title);
      }
      return ascending ? result : -result;
    });
  }, [findings, filter, sortKey, ascending]);

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setAscending((v) => !v);
    } else {
      setSortKey(key);
      setAscending(true);
    }
  }

  const availableFilters: (Severity | 'all')[] = ['all', 'critical', 'high', 'medium', 'low', 'info'];

  return (
    <section className="panel overflow-hidden">
      <div className="flex flex-wrap items-end justify-between gap-4 px-5 py-5 sm:px-6">
        <div>
          <p className="micro">Risk register</p>
          <h2 className="mt-2 text-[17px] font-semibold tracking-tight text-tx">
            Every finding
            <span className="ml-2 font-mono text-[13px] font-normal text-tx-3 tabular-nums">
              {findings.length}
            </span>
          </h2>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {availableFilters
            .filter((key) => key === 'all' || (counts[key] ?? 0) > 0)
            .map((key) => {
              const active = filter === key;
              const colour = key === 'all' ? undefined : SEVERITY_COLORS[key];
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setFilter(key)}
                  className={`inline-flex items-center gap-2 rounded border px-2.5 py-1.5 text-[11.5px]
                    transition-colors duration-150 ${
                      active
                        ? 'border-tx-2 bg-raised text-tx'
                        : 'border-line bg-transparent text-tx-2 hover:border-line-strong hover:text-tx'
                    }`}
                >
                  {colour && (
                    <span
                      className="h-[5px] w-[5px] rounded-full"
                      style={{ background: colour }}
                      aria-hidden="true"
                    />
                  )}
                  {key === 'all' ? 'All' : SEVERITY_LABEL[key]}
                  <span className="font-mono text-[10.5px] text-tx-3 tabular-nums">
                    {counts[key] ?? 0}
                  </span>
                </button>
              );
            })}
        </div>
      </div>

      {rows.length === 0 ? (
        <>
          <div className="rule" />
          <p className="px-6 py-10 text-center text-[13px] text-tx-2">
            No findings match this filter.
          </p>
        </>
      ) : (
        // `relative` matters: the sr-only cell below is absolutely positioned,
        // and without a containing block here it escapes this scroller and
        // widens the whole document on narrow screens.
        <div className="relative overflow-x-auto">
          <table className="w-full min-w-[680px] border-collapse text-left">
            <thead>
              <tr className="border-y border-line bg-raised/60">
                {(
                  [
                    ['severity', 'Severity', 'w-[124px]'],
                    ['title', 'Finding', ''],
                    ['category', 'Check', 'w-[190px]'],
                  ] as [SortKey, string, string][]
                ).map(([key, label, width]) => (
                  <th key={key} scope="col" className={`px-5 py-2.5 sm:px-6 ${width}`}>
                    <button
                      type="button"
                      onClick={() => toggleSort(key)}
                      className="micro inline-flex items-center gap-1.5 transition-colors duration-150 hover:text-tx-2"
                    >
                      {label}
                      <svg
                        width="8"
                        height="8"
                        viewBox="0 0 12 12"
                        fill="none"
                        aria-hidden="true"
                        className={`transition ${sortKey === key ? 'text-tx' : 'text-tx-3/40'} ${
                          sortKey === key && !ascending ? 'rotate-180' : ''
                        }`}
                      >
                        <path
                          d="M6 2.5v7M3 6l3-3.5L9 6"
                          stroke="currentColor"
                          strokeWidth="1.6"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </button>
                  </th>
                ))}
                <th scope="col" className="w-[48px] px-5 py-2.5 sm:px-6">
                  <span className="sr-only">Expand</span>
                </th>
              </tr>
            </thead>

            <tbody>
              {rows.map((finding) => {
                const isOpen = expanded === finding.id;
                const colour = SEVERITY_COLORS[finding.severity];
                return (
                  <Fragment key={finding.id}>
                    <tr
                      className={`cursor-pointer border-b border-line transition-colors duration-150 hover:bg-raised ${
                        isOpen ? 'bg-raised' : ''
                      }`}
                      onClick={() => setExpanded(isOpen ? null : finding.id)}
                    >
                      {/* Severity is encoded twice — stripe and word — so the
                          register scans by colour and still reads in mono. */}
                      <td className="relative py-3.5 pl-5 pr-4 align-top sm:pl-6">
                        <span
                          className="absolute inset-y-0 left-0 w-[2px]"
                          style={{ background: colour }}
                          aria-hidden="true"
                        />
                        <span
                          className="font-mono text-[10.5px] font-medium uppercase tracking-[0.12em]"
                          style={{ color: colour }}
                        >
                          {SEVERITY_LABEL[finding.severity]}
                        </span>
                        {/* Confidence is shown next to severity, never folded
                            into it: how bad a thing would be and how sure we
                            are that it is true are separate questions. */}
                        <span className="mt-1 block font-mono text-[9.5px] uppercase tracking-[0.1em] text-tx-3">
                          {finding.confidence} conf.
                        </span>
                      </td>
                      <td className="py-3.5 pr-4 align-top text-[13px] font-medium leading-snug text-tx">
                        {finding.title}
                      </td>
                      <td className="py-3.5 pr-4 align-top text-[12px] text-tx-2">
                        {finding.categoryLabel}
                      </td>
                      <td className="py-3.5 pr-5 align-top sm:pr-6">
                        <span
                          aria-hidden="true"
                          className={`flex justify-end text-tx-3 transition-transform duration-200 ${
                            isOpen ? 'rotate-180' : ''
                          }`}
                        >
                          <svg width="13" height="13" viewBox="0 0 12 12" fill="none">
                            <path
                              d="M2.5 4.5 6 8l3.5-3.5"
                              stroke="currentColor"
                              strokeWidth="1.5"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                        </span>
                      </td>
                    </tr>

                    {isOpen && (
                      <tr className="border-b border-line bg-raised">
                        <td colSpan={4} className="px-5 py-5 sm:px-6">
                          <FindingDetail finding={finding} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
