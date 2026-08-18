'use client';

import { useEffect, useState } from 'react';

import { COLORS } from '@/lib/constants';
import { riskColorFor } from '@/lib/scoring';

export interface OwnershipContext {
  known: boolean;
  vendor?: {
    domain: string;
    display_name: string;
    legal_name: string | null;
    ownership_type: string;
    parent_name: string | null;
    parent_domain: string | null;
    ultimate_parent_name: string | null;
    ownership_source: string | null;
    ownership_source_url: string | null;
    ownership_confidence: string;
    lei: string | null;
    hq_country: string | null;
  };
  assessment?: {
    parent_name: string | null;
    linkage_verdict: string;
    vendor_score: number | null;
    parent_score: number | null;
    score_delta: number | null;
    narrative: string;
    evidence: {
      signals?: { label: string; shared: boolean | null; vendorValue: string; parentValue: string }[];
    };
    assessed_at: string;
  } | null;
}

const TONE = { good: COLORS.good, warn: COLORS.warn, bad: COLORS.bad } as const;

const VERDICT_COPY: Record<string, { label: string; tone: string }> = {
  integrated: { label: 'Runs on parent infrastructure', tone: 'text-tx' },
  partially_integrated: { label: 'Partly on parent infrastructure', tone: 'text-risk-warn' },
  independent: { label: 'Operates independent infrastructure', tone: 'text-tx-2' },
  unknown: { label: 'Linkage could not be established', tone: 'text-tx-3' },
};

export default function OwnershipPanel({
  domain,
  onLoaded,
}: {
  domain: string;
  onLoaded?: (ctx: OwnershipContext | null) => void;
}) {
  const [ctx, setCtx] = useState<OwnershipContext | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/intel/ownership?domain=${encodeURIComponent(domain)}`)
      .then((r) => r.json())
      .then((d: OwnershipContext) => {
        if (cancelled) return;
        setCtx(d);
        onLoaded?.(d);
      })
      .catch(() => {
        if (!cancelled) onLoaded?.(null);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [domain]);

  if (!ctx?.known || !ctx.vendor) return null;

  const v = ctx.vendor;
  const a = ctx.assessment;
  const signals = a?.evidence?.signals ?? [];

  // Nothing worth a panel if the vendor is independent and we have no analysis.
  if (!v.parent_name && !a) return null;

  const verdict = VERDICT_COPY[a?.linkage_verdict ?? 'unknown'];
  const shared = signals.filter((s) => s.shared).length;

  return (
    <section className="panel overflow-hidden">
      <div className="flex flex-wrap items-start justify-between gap-6 px-5 py-5 sm:px-6">
        <div className="min-w-0">
          <p className="micro">Corporate ownership</p>
          <h2 className="mt-2 text-[17px] font-semibold tracking-tight text-tx">
            {v.parent_name ? <>Part of {v.parent_name}</> : 'Independently owned'}
          </h2>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {v.legal_name && <span className="chip normal-case tracking-normal">{v.legal_name}</span>}
            <span className="chip">{v.ownership_type.replace('_', ' ')}</span>
            <span className="chip">ownership {v.ownership_confidence}</span>
            {v.lei && (
              <a
                href={`https://search.gleif.org/#/record/${v.lei}`}
                target="_blank"
                rel="noopener noreferrer"
                className="chip transition-colors duration-150 hover:border-line-strong hover:text-tx"
              >
                LEI {v.lei}
              </a>
            )}
          </div>
        </div>

        {/* Two scores, side by side, because the whole point is that they are
            different numbers and neither one implies the other. */}
        {a && a.parent_score !== null && a.vendor_score !== null && (
          <div className="flex shrink-0 items-end gap-6">
            <div>
              <div
                className="num text-[34px] font-semibold leading-none"
                style={{ color: TONE[riskColorFor(a.vendor_score)] }}
              >
                {a.vendor_score}
              </div>
              <div className="micro mt-2">this vendor</div>
            </div>
            <div className="pb-2 font-mono text-[11px] text-tx-3">vs</div>
            <div>
              <div
                className="num text-[34px] font-semibold leading-none"
                style={{ color: TONE[riskColorFor(a.parent_score)] }}
              >
                {a.parent_score}
              </div>
              <div className="micro mt-2">parent</div>
            </div>
          </div>
        )}
      </div>

      {a && (
        <>
          <div className="rule" />
          <div className="px-5 py-5 sm:px-6">
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
              <span
                className={`font-mono text-[11.5px] font-medium uppercase tracking-[0.14em] ${verdict.tone}`}
              >
                {verdict.label}
              </span>
              {signals.length > 0 && (
                <span className="font-mono text-[11px] text-tx-3 tabular-nums">
                  {shared}/{signals.length} signals shared
                </span>
              )}
            </div>
            <p className="mt-3 max-w-3xl text-[13px] leading-relaxed text-tx">{a.narrative}</p>
          </div>

          {signals.length > 0 && (
            <>
              <div className="rule" />
              <div className="relative overflow-x-auto">
                <table className="w-full min-w-[560px] border-collapse text-left">
                  <thead>
                    <tr className="border-b border-line bg-raised/60">
                      <th className="micro px-5 py-2.5 font-medium sm:px-6">Signal</th>
                      <th className="micro px-5 py-2.5 font-medium">This vendor</th>
                      <th className="micro px-5 py-2.5 font-medium">Parent</th>
                      <th className="micro px-5 py-2.5 font-medium sm:px-6">Shared</th>
                    </tr>
                  </thead>
                  <tbody>
                    {signals.map((s) => (
                      <tr key={s.label} className="border-b border-line last:border-b-0">
                        <td className="px-5 py-2.5 text-[12px] text-tx-2 sm:px-6">{s.label}</td>
                        <td className="px-5 py-2.5 font-mono text-[11px] text-tx">{s.vendorValue}</td>
                        <td className="px-5 py-2.5 font-mono text-[11px] text-tx-2">
                          {s.parentValue}
                        </td>
                        <td className="px-5 py-2.5 sm:px-6">
                          <span
                            className={`font-mono text-[11px] uppercase tracking-[0.1em] ${
                              s.shared ? 'text-tx' : 'text-tx-3'
                            }`}
                          >
                            {s.shared ? 'yes' : 'no'}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}

      {v.ownership_source && (
        <>
          <div className="rule" />
          <p className="px-5 py-4 text-[11.5px] leading-relaxed text-tx-3 sm:px-6">
            Ownership sourced from {v.ownership_source}
            {v.ownership_source_url && (
              <>
                {' ('}
                <a
                  href={v.ownership_source_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline decoration-dotted underline-offset-2 transition-colors duration-150 hover:text-tx"
                >
                  reference
                </a>
                {')'}
              </>
            )}
            . A parent&apos;s reputation is never applied to this vendor&apos;s score — only the
            infrastructure overlap measured above is treated as evidence.
          </p>
        </>
      )}
    </section>
  );
}
