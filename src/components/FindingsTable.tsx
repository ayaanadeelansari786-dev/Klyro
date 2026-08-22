'use client';

import { useMemo, useState } from 'react';

import FindingDetail from '@/components/FindingDetail';
import { SEVERITY_COLORS, SEVERITY_ORDER } from '@/lib/constants';
import type { Finding, Severity } from '@/lib/types';

const SEVERITY_LABEL: Record<Severity, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  info: 'Info',
};

/**
 * The register, read at three densities rather than one.
 *
 * The previous version was a single table with every row the same height —
 * severity was the only thing that varied, and it varied by a few pixels of
 * coloured text. A domain with one critical finding and fourteen low-severity
 * ones rendered as fifteen rows of near-identical weight, so the one that
 * mattered did not read as more important than the fourteen that did not.
 *
 * Severity now buys physical space. Critical and high get an elevated card
 * each — coloured edge, tinted ground, larger type, room to breathe. Medium
 * sits at the weight the whole table used to be. Low and info collapse into
 * one line by default, because on most scans they are the majority of the
 * register and the majority should not compete with the minority for
 * attention; expanding the group or picking a specific severity from the
 * filter opens them at the same density either way.
 *
 * The column-sort control from the previous version is gone. Severity is now
 * the layout, not a column a reader could sort away from — there is no
 * "sorted by title" view that would still make sense once the tiers exist.
 */
export default function FindingsTable({ findings }: { findings: Finding[] }) {
  const [filter, setFilter] = useState<Severity | 'all'>('all');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [quietOpen, setQuietOpen] = useState(false);

  const counts = useMemo(() => {
    const base: Record<string, number> = { all: findings.length };
    for (const finding of findings) {
      base[finding.severity] = (base[finding.severity] ?? 0) + 1;
    }
    return base;
  }, [findings]);

  const sorted = useMemo(() => {
    const filtered = filter === 'all' ? findings : findings.filter((f) => f.severity === filter);
    return [...filtered].sort((a, b) => {
      const bySeverity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
      return bySeverity !== 0 ? bySeverity : a.title.localeCompare(b.title);
    });
  }, [findings, filter]);

  const loud = sorted.filter((f) => f.severity === 'critical' || f.severity === 'high');
  const normal = sorted.filter((f) => f.severity === 'medium');
  const quiet = sorted.filter((f) => f.severity === 'low' || f.severity === 'info');

  // A reader who filtered to exactly "Low" or "Info" asked to see them — the
  // collapse is a default for the unfiltered register, not a rule about the
  // severities themselves.
  const quietForcedOpen = filter === 'low' || filter === 'info';

  const availableFilters: (Severity | 'all')[] = ['all', 'critical', 'high', 'medium', 'low', 'info'];

  function toggle(id: string) {
    setExpanded((current) => (current === id ? null : id));
  }

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

      {sorted.length === 0 ? (
        <>
          <div className="rule" />
          <p className="px-6 py-10 text-center text-[13px] text-tx-2">
            No findings match this filter.
          </p>
        </>
      ) : (
        <div className="border-t border-line">
          {loud.length > 0 && (
            <ul className="space-y-3 px-5 py-5 sm:px-6">
              {loud.map((finding) => (
                <LoudItem
                  key={finding.id}
                  finding={finding}
                  isOpen={expanded === finding.id}
                  onToggle={() => toggle(finding.id)}
                />
              ))}
            </ul>
          )}

          {normal.length > 0 && (
            <ul className={loud.length > 0 ? 'border-t border-line' : ''}>
              {normal.map((finding) => (
                <NormalRow
                  key={finding.id}
                  finding={finding}
                  isOpen={expanded === finding.id}
                  onToggle={() => toggle(finding.id)}
                />
              ))}
            </ul>
          )}

          {quiet.length > 0 && (
            <div className={loud.length > 0 || normal.length > 0 ? 'border-t border-line' : ''}>
              {quietForcedOpen ? (
                <ul>
                  {quiet.map((finding) => (
                    <QuietRow
                      key={finding.id}
                      finding={finding}
                      isOpen={expanded === finding.id}
                      onToggle={() => toggle(finding.id)}
                    />
                  ))}
                </ul>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => setQuietOpen((v) => !v)}
                    aria-expanded={quietOpen}
                    className="flex w-full items-center justify-between gap-4 px-5 py-3.5 text-left
                      transition-colors duration-150 hover:bg-raised sm:px-6"
                  >
                    <span className="text-[12.5px] text-tx-2">
                      {quiet.length} low-severity observation{quiet.length === 1 ? '' : 's'}
                    </span>
                    <span
                      aria-hidden="true"
                      className={`flex text-tx-3 transition-transform duration-200 ${
                        quietOpen ? 'rotate-180' : ''
                      }`}
                    >
                      <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                        <path
                          d="M2.5 4.5 6 8l3.5-3.5"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </span>
                  </button>
                  {quietOpen && (
                    <ul className="border-t border-line">
                      {quiet.map((finding) => (
                        <QuietRow
                          key={finding.id}
                          finding={finding}
                          isOpen={expanded === finding.id}
                          onToggle={() => toggle(finding.id)}
                        />
                      ))}
                    </ul>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * Loud — critical and high. An elevated card each: coloured edge, a tint of
 * the same hue behind it, and the largest type in the register.
 * ------------------------------------------------------------------ */

function LoudItem({
  finding,
  isOpen,
  onToggle,
}: {
  finding: Finding;
  isOpen: boolean;
  onToggle: () => void;
}) {
  const colour = SEVERITY_COLORS[finding.severity];
  const tint = finding.severity === 'critical' ? 'bg-risk-bad/[0.05]' : 'bg-risk-high/[0.05]';

  return (
    <li>
      <div
        className={`relative overflow-hidden rounded border border-line-strong ${tint} transition-colors duration-150`}
      >
        <span
          className="absolute inset-y-0 left-0 w-[3px]"
          style={{ background: colour }}
          aria-hidden="true"
        />
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={isOpen}
          className="flex w-full flex-col gap-2 py-4 pl-6 pr-5 text-left sm:pr-6"
        >
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <span
              className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.13em]"
              style={{ color: colour }}
            >
              {SEVERITY_LABEL[finding.severity]}
            </span>
            <span className="font-mono text-[9.5px] uppercase tracking-[0.1em] text-tx-3">
              {finding.confidence} conf.
            </span>
            <span className="text-[11.5px] text-tx-3">{finding.categoryLabel}</span>
            <span
              aria-hidden="true"
              className={`ml-auto flex shrink-0 text-tx-3 transition-transform duration-200 ${
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
          </div>
          <span className="text-[15.5px] font-semibold leading-snug text-tx">{finding.title}</span>
          <span className="text-[12.5px] leading-relaxed text-tx-2">{finding.observed}</span>
        </button>

        {isOpen && (
          <div className="border-t border-line-strong bg-panel px-6 py-5">
            <FindingDetail finding={finding} />
          </div>
        )}
      </div>
    </li>
  );
}

/* ------------------------------------------------------------------ *
 * Normal — medium. The weight the whole register used to render at.
 * ------------------------------------------------------------------ */

function NormalRow({
  finding,
  isOpen,
  onToggle,
}: {
  finding: Finding;
  isOpen: boolean;
  onToggle: () => void;
}) {
  const colour = SEVERITY_COLORS[finding.severity];

  return (
    <li>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isOpen}
        className={`relative flex w-full items-start gap-4 border-t border-line px-5 py-3.5 text-left
          transition-colors duration-150 first:border-t-0 hover:bg-raised sm:px-6 ${
            isOpen ? 'bg-raised' : ''
          }`}
      >
        <span
          className="mt-[3px] shrink-0 font-mono text-[10px] font-medium uppercase tracking-[0.11em]"
          style={{ color: colour }}
        >
          {SEVERITY_LABEL[finding.severity]}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-medium leading-snug text-tx">{finding.title}</span>
          <span className="mt-0.5 block text-[11.5px] text-tx-3">{finding.categoryLabel}</span>
        </span>
        <span
          aria-hidden="true"
          className={`mt-[3px] flex shrink-0 text-tx-3 transition-transform duration-200 ${
            isOpen ? 'rotate-180' : ''
          }`}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path
              d="M2.5 4.5 6 8l3.5-3.5"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      </button>
      {isOpen && (
        <div className="border-t border-line bg-raised px-5 py-5 sm:px-6">
          <FindingDetail finding={finding} />
        </div>
      )}
    </li>
  );
}

/* ------------------------------------------------------------------ *
 * Quiet — low and info. Dense: one line, small type, minimal padding.
 * ------------------------------------------------------------------ */

function QuietRow({
  finding,
  isOpen,
  onToggle,
}: {
  finding: Finding;
  isOpen: boolean;
  onToggle: () => void;
}) {
  const colour = SEVERITY_COLORS[finding.severity];

  return (
    <li>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isOpen}
        className={`flex w-full items-center gap-3 border-t border-line px-5 py-2 text-left
          transition-colors duration-150 first:border-t-0 hover:bg-raised sm:px-6 ${
            isOpen ? 'bg-raised' : ''
          }`}
      >
        <span
          className="w-[34px] shrink-0 font-mono text-[9px] font-medium uppercase tracking-[0.1em]"
          style={{ color: colour }}
        >
          {SEVERITY_LABEL[finding.severity]}
        </span>
        <span className="min-w-0 flex-1 truncate text-[12px] text-tx-2">{finding.title}</span>
        <span className="hidden shrink-0 text-[11px] text-tx-3 sm:block">{finding.categoryLabel}</span>
      </button>
      {isOpen && (
        <div className="border-t border-line bg-raised px-5 py-5 sm:px-6">
          <FindingDetail finding={finding} />
        </div>
      )}
    </li>
  );
}
