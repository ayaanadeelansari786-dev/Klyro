'use client';

import { COLORS } from '@/lib/constants';
import { riskColorFor } from '@/lib/scoring';
import type { ConcernLevel, RelationshipAssessment } from '@/lib/types';

const TONE = { good: COLORS.good, warn: COLORS.warn, bad: COLORS.bad } as const;

const LEVEL_STYLE: Record<ConcernLevel, { color: string; label: string }> = {
  high: { color: COLORS.bad, label: 'act on this' },
  medium: { color: COLORS.warn, label: 'raise it' },
  low: { color: 'rgb(var(--risk-low))', label: 'note it' },
  note: { color: COLORS.inkMuted, label: 'your side' },
};

/** What the results page knows about the optional second domain at any moment. */
export interface ContextState {
  domain: string;
  status: 'running' | 'done' | 'error';
  assessment: RelationshipAssessment | null;
  error?: string;
}

export default function RelationshipPanel({ state }: { state: ContextState }) {
  if (state.status === 'running') {
    return (
      <section className="panel flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-5 sm:px-6">
        <span
          className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-line-strong border-t-tx-2"
          aria-hidden="true"
        />
        <p className="text-[12.5px] text-tx-2">
          Assessing <span className="font-mono text-tx">{state.domain}</span> to compare against this
          vendor
        </p>
      </section>
    );
  }

  if (state.status === 'error' || !state.assessment) {
    return (
      <section className="panel px-5 py-5 sm:px-6">
        <p className="micro">Your context</p>
        <p className="mt-2.5 max-w-2xl text-[12.5px] leading-relaxed text-tx-2">
          {state.error ??
            `The comparison against ${state.domain} could not be completed. The vendor assessment above is unaffected.`}
        </p>
      </section>
    );
  }

  const a = state.assessment;

  return (
    <section className="panel overflow-hidden">
      {/* ---------- Header: two scores, because the whole section is a comparison ---------- */}
      <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-5 px-5 py-5 sm:px-6">
        <div className="min-w-0">
          <p className="micro">Your context</p>
          <h2 className="mt-2 text-[17px] font-semibold tracking-tight text-tx">
            What this vendor means for {a.yourDomain}
          </h2>
          {a.sharedDependencies.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {a.sharedDependencies.map((dep) => (
                <span key={dep.key} className="chip">
                  shared {dep.label}
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-end gap-6">
          <div>
            <div
              className="num text-[34px] font-semibold leading-none"
              style={{ color: TONE[riskColorFor(a.yourScore)] }}
            >
              {a.yourScore}
            </div>
            <div className="micro mt-2">you</div>
          </div>
          <div className="pb-2 font-mono text-[11px] text-tx-3">vs</div>
          <div>
            <div
              className="num text-[34px] font-semibold leading-none"
              style={{ color: TONE[riskColorFor(a.vendorScore)] }}
            >
              {a.vendorScore}
            </div>
            <div className="micro mt-2">vendor</div>
          </div>
        </div>
      </div>

      {/* ---------- The blurb ---------- */}
      <div className="rule" />
      <div className="px-5 py-5 sm:px-6">
        <p className="max-w-3xl text-[15px] font-medium leading-snug tracking-tight text-tx sm:text-[16px]">
          {a.headline}
        </p>
        <p className="mt-3.5 max-w-3xl text-[13px] leading-relaxed text-tx-2">{a.narrative}</p>

        {a.yourCoverage < 0.999 && (
          <p className="mt-3 max-w-3xl text-[12px] leading-relaxed text-risk-warn">
            {Math.round(a.yourCoverage * 100)}% of the scoring weight could be assessed on{' '}
            {a.yourDomain}. Checks that could not be measured on both domains are excluded from the
            comparison entirely rather than counted either way.
          </p>
        )}
      </div>

      {/* ---------- Concerns ---------- */}
      {a.concerns.length > 0 && (
        <>
          <div className="rule" />
          <div className="px-5 pt-4 sm:px-6">
            <p className="micro">Carry these into the conversation</p>
          </div>

          <ol className="mt-1">
            {a.concerns.map((concern, i) => {
              const style = LEVEL_STYLE[concern.level];
              return (
                <li
                  key={concern.id}
                  className="grid gap-x-4 gap-y-2 border-t border-line px-5 py-5 first:border-t-0
                    sm:grid-cols-[26px_minmax(0,1fr)] sm:px-6"
                >
                  <span className="hidden font-mono text-[10.5px] text-tx-3 tabular-nums sm:block">
                    {String(i + 1).padStart(2, '0')}
                  </span>

                  <div className="min-w-0">
                    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1.5">
                      <h3 className="text-[13.5px] font-semibold leading-snug text-tx">
                        {concern.title}
                      </h3>
                      <span
                        className="font-mono text-[9.5px] font-medium uppercase tracking-[0.14em]"
                        style={{ color: style.color }}
                      >
                        {style.label}
                      </span>
                    </div>

                    <p className="mt-2 max-w-3xl text-[12.5px] leading-relaxed text-tx-2">
                      {concern.detail}
                    </p>
                    <p className="mt-2 max-w-3xl text-[12.5px] leading-relaxed text-tx">
                      <span className="micro mr-2 inline">Do</span>
                      {concern.watchFor}
                    </p>
                  </div>
                </li>
              );
            })}
          </ol>
        </>
      )}

      {/* ---------- Numeric evidence behind the prose ---------- */}
      {a.gaps.length > 0 && (
        <>
          <div className="rule" />
          <div className="px-5 py-4 sm:px-6">
            <p className="micro">Where the two of you diverge</p>

            <ul className="mt-3">
              {a.gaps.map((gap) => {
                const vendorBehind = gap.delta > 0;
                return (
                  <li
                    key={gap.key}
                    className="grid grid-cols-[minmax(0,1fr)_44px_44px_54px] items-center gap-3
                      border-t border-line py-2.5 first:border-t-0 first:pt-0 sm:gap-4"
                  >
                    <span className="truncate text-[12.5px] text-tx-2">{gap.label}</span>
                    <span
                      className="text-right font-mono text-[12px] tabular-nums"
                      style={{ color: TONE[riskColorFor(gap.yourScore)] }}
                    >
                      {gap.yourScore}
                    </span>
                    <span
                      className="text-right font-mono text-[12px] tabular-nums"
                      style={{ color: TONE[riskColorFor(gap.vendorScore)] }}
                    >
                      {gap.vendorScore}
                    </span>
                    <span
                      className={`text-right font-mono text-[12px] tabular-nums ${
                        vendorBehind ? 'text-risk-bad' : 'text-tx-3'
                      }`}
                    >
                      {vendorBehind ? '−' : '+'}
                      {Math.abs(gap.delta)}
                    </span>
                  </li>
                );
              })}
            </ul>

            <p className="mt-3 font-mono text-[10.5px] text-tx-3">
              your score · vendor score · difference
            </p>
          </div>
        </>
      )}

      {/* ---------- Limits, always ---------- */}
      <div className="rule" />
      <div className="px-5 py-4 sm:px-6">
        <p className="micro">What this comparison cannot see</p>
        <ul className="mt-3 space-y-2">
          {a.limits.map((limit, i) => (
            <li key={i} className="flex gap-2.5 text-[11.5px] leading-relaxed text-tx-3">
              <span
                className="mt-[6px] h-[3px] w-[3px] shrink-0 rounded-full bg-tx-3"
                aria-hidden="true"
              />
              <span className="max-w-3xl">{limit}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
