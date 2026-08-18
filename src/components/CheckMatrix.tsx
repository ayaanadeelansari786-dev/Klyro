'use client';

import { useMemo, useState } from 'react';

import {
  CATEGORY_BLURBS,
  CATEGORY_ORDER,
  CATEGORY_WEIGHTS,
  COLORS,
  SEVERITY_COLORS,
} from '@/lib/constants';
import { ratingFor, riskColorFor } from '@/lib/scoring';
import type { CategoryResult, Severity } from '@/lib/types';

const TONE_COLORS = {
  good: COLORS.good,
  warn: COLORS.warn,
  bad: COLORS.bad,
} as const;

const DETAIL_TONE_CLASS: Record<string, string> = {
  good: 'text-risk-good',
  warn: 'text-risk-warn',
  bad: 'text-risk-bad',
  neutral: 'text-tx',
};

const SEVERITY_RANK: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

interface Row {
  category: CategoryResult;
  /** Points of the composite this check is costing, after renormalisation. */
  lost: number | null;
  effectiveWeight: number;
  worst: Severity | null;
  materialCount: number;
}

/**
 * All ten checks on one screen, ordered by how much damage each is actually
 * doing rather than by category name.
 *
 * "Threat" is measured as points lost from the composite: the check's
 * renormalised weight multiplied by its shortfall from 100. That ranks a
 * mediocre score on a heavy check above a terrible score on a light one, and
 * the column sums to exactly `100 - composite`, so the ordering is auditable
 * rather than editorial.
 */
export default function CheckMatrix({ categories }: { categories: CategoryResult[] }) {
  const rows = useMemo<Row[]>(() => {
    const availableWeight = categories
      .filter((c) => c.status === 'assessed')
      .reduce((sum, c) => sum + CATEGORY_WEIGHTS[c.key], 0);

    const built = categories.map((category) => {
      const assessed = category.status === 'assessed';
      const effectiveWeight =
        assessed && availableWeight > 0 ? CATEGORY_WEIGHTS[category.key] / availableWeight : 0;

      const material = category.findings.filter((f) => f.severity !== 'info');
      const worst = material.length
        ? material.reduce<Severity>(
            (acc, f) => (SEVERITY_RANK[f.severity] < SEVERITY_RANK[acc] ? f.severity : acc),
            'low',
          )
        : null;

      return {
        category,
        effectiveWeight,
        lost: assessed ? effectiveWeight * (100 - category.score) : null,
        worst,
        materialCount: material.length,
      };
    });

    return built.sort((a, b) => {
      if (a.lost === null) return 1;
      if (b.lost === null) return -1;
      if (b.lost !== a.lost) return b.lost - a.lost;
      return a.category.score - b.category.score;
    });
  }, [categories]);

  const [selected, setSelected] = useState<string | null>(null);
  const active = rows.find((r) => r.category.key === selected) ?? rows[0];

  const totalLost = rows.reduce((sum, r) => sum + (r.lost ?? 0), 0);

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1.12fr)_minmax(330px,0.88fr)] lg:items-start">
      {/* ---------------- Matrix ---------------- */}
      <section className="panel overflow-hidden">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 px-5 py-3.5 sm:px-6">
          <div>
            <p className="micro">Exposure matrix</p>
            <h2 className="mt-2 text-[17px] font-semibold tracking-tight text-tx">
              {CATEGORY_ORDER.length} checks, most damaging first
            </h2>
          </div>
          <p className="text-[11.5px] text-tx-3">
            Ranked by points lost from the composite
            <span className="ml-2 font-mono text-tx-2 tabular-nums">
              &minus;{totalLost.toFixed(1)} total
            </span>
          </p>
        </div>

        {/* Column headers, sized to match the rows below. */}
        <div className="grid grid-cols-[26px_minmax(0,1fr)_54px_88px_42px] items-center gap-3 border-t border-line bg-raised/60 px-5 py-2 sm:gap-4 sm:px-6">
          <span className="micro">#</span>
          <span className="micro">Check</span>
          <span className="micro text-right">Cost</span>
          <span className="micro">Score</span>
          <span className="sr-only">Value</span>
        </div>

        <ul>
          {rows.map((row, i) => {
            const { category } = row;
            const unavailable = category.status !== 'assessed';
            const accent = unavailable ? COLORS.inkMuted : TONE_COLORS[riskColorFor(category.score)];
            const isActive = active?.category.key === category.key;

            return (
              <li key={category.key}>
                <button
                  type="button"
                  onClick={() => setSelected(category.key)}
                  aria-current={isActive}
                  className={`grid w-full grid-cols-[26px_minmax(0,1fr)_54px_88px_42px] items-center gap-3
                    border-t border-line px-5 py-[11px] text-left transition-colors duration-150
                    hover:bg-raised sm:gap-4 sm:px-6 ${isActive ? 'bg-raised' : ''}`}
                >
                  <span className="font-mono text-[10.5px] text-tx-3 tabular-nums">
                    {String(i + 1).padStart(2, '0')}
                  </span>

                  {/* One line per check, so all ten stay on one screen. The
                      dot carries the worst severity present. */}
                  <span className="flex min-w-0 items-center gap-3">
                    <span className="truncate text-[13.5px] font-medium leading-tight text-tx">
                      {category.label}
                    </span>
                    <span className="ml-auto hidden shrink-0 items-center gap-1.5 text-[11px] text-tx-3 sm:flex">
                      {row.worst && (
                        <span
                          className="h-[5px] w-[5px] rounded-full"
                          style={{ background: SEVERITY_COLORS[row.worst] }}
                          title={`Worst severity: ${row.worst}`}
                        />
                      )}
                      {unavailable
                        ? 'unavailable'
                        : row.materialCount === 0
                          ? 'clean'
                          : `${row.materialCount} finding${row.materialCount === 1 ? '' : 's'}`}
                    </span>
                  </span>

                  <span className="text-right font-mono text-[11.5px] tabular-nums text-tx-2">
                    {row.lost === null ? (
                      <span className="text-tx-3">n/a</span>
                    ) : row.lost < 0.05 ? (
                      <span className="text-tx-3">&mdash;</span>
                    ) : (
                      <>&minus;{row.lost.toFixed(1)}</>
                    )}
                  </span>

                  {/* Bar reads as the score itself, coloured by band. */}
                  <span className="relative block h-[6px] w-full bg-line">
                    <span
                      className="absolute inset-y-0 left-0 transition-[width] duration-700 ease-out"
                      style={{
                        width: unavailable ? '0%' : `${category.score}%`,
                        background: accent,
                      }}
                    />
                  </span>

                  <span
                    className="text-right font-mono text-[13px] font-medium tabular-nums"
                    style={{ color: unavailable ? undefined : accent }}
                  >
                    {unavailable ? <span className="text-tx-3">n/a</span> : category.score}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      {/* ---------------- Detail ---------------- */}
      {active && <CheckDetail row={active} />}
    </div>
  );
}

function CheckDetail({ row }: { row: Row }) {
  const { category } = row;
  const unavailable = category.status !== 'assessed';
  const accent = unavailable ? COLORS.inkMuted : TONE_COLORS[riskColorFor(category.score)];
  const material = category.findings.filter((f) => f.severity !== 'info');
  const notes = category.findings.filter((f) => f.severity === 'info');

  return (
    <section className="panel lg:sticky lg:top-[116px] lg:max-h-[calc(100vh-140px)] lg:overflow-y-auto">
      <div className="px-5 py-5 sm:px-6">
        <p className="micro">Detail</p>

        <div className="mt-3 flex items-start justify-between gap-5">
          <div className="min-w-0">
            <h3 className="text-[19px] font-semibold leading-tight tracking-tight text-tx">
              {category.label}
            </h3>
            <p className="mt-2 text-[12px] leading-relaxed text-tx-3">
              {CATEGORY_BLURBS[category.key]}
            </p>
          </div>

          <div className="shrink-0 text-right">
            <div className="num text-[38px] font-semibold leading-none" style={{ color: accent }}>
              {unavailable ? 'n/a' : category.score}
            </div>
            <div className="micro mt-2">
              {unavailable ? 'not assessed' : ratingFor(category.score)}
            </div>
          </div>
        </div>

        <p className="mt-5 text-[13px] leading-relaxed text-tx">{category.summary}</p>

        <div className="mt-5 flex flex-wrap gap-1.5">
          <span className="chip">
            weight {Math.round(CATEGORY_WEIGHTS[category.key] * 100)}%
          </span>
          {row.lost !== null && (
            <span className="chip">costing {row.lost.toFixed(1)} pts</span>
          )}
          <span className="chip">{category.durationMs} ms</span>
        </div>
      </div>

      {category.details.length > 0 && (
        <>
          <div className="rule" />
          <dl className="px-5 py-4 sm:px-6">
            {category.details.map((detail, i) => (
              <div
                key={`${detail.label}-${i}`}
                className="flex gap-4 border-t border-line py-2 first:border-t-0 first:pt-0"
              >
                <dt className="w-[42%] shrink-0 text-[12px] leading-relaxed text-tx-3">
                  {detail.label}
                </dt>
                <dd
                  className={`min-w-0 flex-1 break-words text-[12px] leading-relaxed ${
                    detail.mono ? 'font-mono text-[11.5px]' : ''
                  } ${DETAIL_TONE_CLASS[detail.tone ?? 'neutral']}`}
                >
                  {detail.value}
                </dd>
              </div>
            ))}
          </dl>
        </>
      )}

      {/* How the number was reached. A score nobody can take apart is a score
          nobody has any reason to accept. */}
      {category.scoreBreakdown && category.scoreBreakdown.length > 0 && (
        <>
          <div className="rule" />
          <div className="px-5 py-4 sm:px-6">
            <p className="micro">How this score was reached</p>
            <ul className="mt-3 space-y-2.5">
              {category.scoreBreakdown.map((line, i) => (
                <li key={`${line.label}-${i}`}>
                  <div className="flex items-baseline justify-between gap-4">
                    <span
                      className={`text-[12px] leading-snug ${
                        line.assessed ? 'text-tx' : 'text-tx-3 line-through'
                      }`}
                    >
                      {line.label}
                    </span>
                    <span
                      className={`shrink-0 font-mono text-[11.5px] tabular-nums ${
                        !line.assessed
                          ? 'text-tx-3'
                          : line.value < 0
                            ? 'text-risk-bad'
                            : 'text-tx-2'
                      }`}
                    >
                      {!line.assessed
                        ? 'excluded'
                        : line.max > 0
                          ? `${line.value} / ${line.max}`
                          : `${line.value > 0 ? '+' : ''}${line.value}`}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[11px] leading-relaxed text-tx-3">{line.note}</p>
                </li>
              ))}
            </ul>
            {typeof category.moduleCoverage === 'number' && category.moduleCoverage < 0.999 && (
              <p className="mt-3 border-t border-line pt-2.5 text-[11px] leading-relaxed text-tx-3">
                Components that could not be measured were dropped and the remainder rescaled to
                0–100. {Math.round(category.moduleCoverage * 100)}% of this category&apos;s intended
                weight was assessable.
              </p>
            )}
          </div>
        </>
      )}

      {material.length > 0 && (
        <>
          <div className="rule" />
          <div className="px-5 py-4 sm:px-6">
            <p className="micro">Findings</p>
            <ul className="mt-3 space-y-3">
              {material.map((finding) => (
                <li key={finding.id}>
                  <div className="flex items-baseline gap-2.5">
                    <span
                      className="font-mono text-[9.5px] font-medium uppercase tracking-[0.12em]"
                      style={{ color: SEVERITY_COLORS[finding.severity] }}
                    >
                      {finding.severity}
                    </span>
                    <span className="font-mono text-[9.5px] uppercase tracking-[0.12em] text-tx-3">
                      {finding.confidence} conf.
                    </span>
                    <span className="min-w-0 text-[12.5px] font-medium leading-snug text-tx">
                      {finding.title}
                    </span>
                  </div>
                  <p className="mt-1 text-[12px] leading-relaxed text-tx-2">{finding.observed}</p>
                  <p className="mt-1 text-[12px] leading-relaxed text-tx-2">
                    <span className="micro mr-1.5 inline">Action</span>
                    {finding.recommendation}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}

      {notes.length > 0 && (
        <>
          <div className="rule" />
          <div className="px-5 py-4 sm:px-6">
            <p className="micro">Scope notes</p>
            <ul className="mt-3 space-y-2">
              {notes.map((finding) => (
                <li key={finding.id} className="flex gap-2.5 text-[11.5px] leading-relaxed text-tx-3">
                  <span
                    className="mt-[6px] h-[3px] w-[3px] shrink-0 rounded-full bg-tx-3"
                    aria-hidden="true"
                  />
                  <span>{finding.title}</span>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}

      {category.error && (
        <>
          <div className="rule" />
          <p className="px-5 py-4 text-[12px] leading-relaxed text-risk-warn sm:px-6">
            {category.error}
          </p>
        </>
      )}
    </section>
  );
}
