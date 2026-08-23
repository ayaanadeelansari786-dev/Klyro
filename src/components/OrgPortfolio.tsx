'use client';

import { useEffect, useState } from 'react';

import { COLORS } from '@/lib/constants';
import type { PortfolioComparison } from '@/lib/dataset/portfolio';
import { riskColorFor } from '@/lib/scoring';

/**
 * This vendor against the others the organisation has already assessed.
 *
 * The wording is load-bearing and is doing the same job the rest of the
 * report does: saying exactly what was compared and no more. "Third of seven
 * Technology vendors your organisation has assessed" names the set, its size,
 * and who assembled it. It is deliberately never phrased as a percentile,
 * never as "better than 71% of the industry", and never as a benchmark —
 * seven domains one buyer happened to look at is not a sample of an industry,
 * and the shared corpus below has a thirty-domain floor precisely because
 * that distinction matters.
 *
 * Every peer is listed with its score. The reader can therefore see the set
 * the position was computed from, which is the difference between a ranking
 * they can check and a number they have to accept.
 */

const ORDINALS = ['', 'First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth', 'Ninth', 'Tenth'];

function ordinal(n: number): string {
  if (n < ORDINALS.length) return ORDINALS[n];
  const suffix = n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th';
  return `${n}${suffix}`;
}

/**
 * Fetches its own data and reports up, the way `OwnershipPanel` does.
 *
 * Renders nothing at all until the answer arrives, and nothing ever if the
 * reader is signed out, filed the scan personally, or is not a member of the
 * organisation named in the URL. `onLoaded` is what lets the section rail
 * gain an entry only once there is a section for it to point at.
 */
export default function OrgPortfolio({
  orgId,
  domain,
  industry,
  score,
  onLoaded,
}: {
  orgId: string;
  domain: string;
  industry: string;
  score: number;
  onLoaded?: (portfolio: PortfolioComparison | null) => void;
}) {
  const [portfolio, setPortfolio] = useState<PortfolioComparison | null>(null);

  useEffect(() => {
    let live = true;
    const params = new URLSearchParams({ org: orgId, domain, industry, score: String(score) });

    fetch(`/api/org/portfolio?${params.toString()}`)
      .then((r) => (r.ok ? r.json() : { portfolio: null }))
      .catch(() => ({ portfolio: null }))
      .then((payload: { portfolio: PortfolioComparison | null }) => {
        if (!live) return;
        setPortfolio(payload.portfolio ?? null);
        onLoaded?.(payload.portfolio ?? null);
      });

    return () => {
      live = false;
    };
    // `onLoaded` is deliberately not a dependency: it is a setState from the
    // parent and including it would re-run the fetch on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, domain, industry, score]);

  if (!portfolio) return null;
  return <PortfolioPanel portfolio={portfolio} />;
}

function PortfolioPanel({ portfolio }: { portfolio: PortfolioComparison }) {
  const { rank, total, industry, orgName, peers } = portfolio;

  return (
    <section className="panel overflow-hidden">
      <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-line px-5 py-3.5 sm:px-6">
        <p className="micro">Your organisation&rsquo;s portfolio</p>
        <p className="text-[11.5px] text-tx-3">
          {orgName} · {industry}
        </p>
      </div>

      <div className="px-5 py-5 sm:px-6">
        {rank === null ? (
          /*
           * One vendor is not a ranking. Saying "first of one" would dress a
           * portfolio with nothing in it as a favourable result, which is the
           * one reading this panel must never produce.
           */
          <p className="max-w-[62ch] text-[13px] leading-relaxed text-tx-2">
            This is the first {industry} vendor {orgName} has assessed. Once another is assessed,
            this section will show where each one sits against the others.
          </p>
        ) : (
          <p className="max-w-[62ch] text-[14px] leading-relaxed text-tx">
            <span className="font-medium">
              {ordinal(rank)} of {total}
            </span>{' '}
            {industry} vendors {orgName} has assessed.
          </p>
        )}

        {peers.length > 1 && (
          <ul className="mt-5">
            {peers.map((peer) => {
              // `riskColorFor` returns exactly the three keys COLORS carries.
              const accent = COLORS[riskColorFor(peer.score)];
              return (
                <li
                  key={peer.domain}
                  className={`grid grid-cols-[minmax(0,1fr)_88px_38px] items-center gap-3 border-t border-line
                    py-2.5 first:border-t-0 sm:gap-4 ${peer.isTarget ? 'bg-raised' : ''}`}
                >
                  <span className="flex min-w-0 items-baseline gap-2">
                    <span
                      className={`truncate font-mono text-[12.5px] ${peer.isTarget ? 'text-tx' : 'text-tx-2'}`}
                    >
                      {peer.domain}
                    </span>
                    {peer.isTarget && (
                      <span className="shrink-0 font-mono text-[9.5px] uppercase tracking-[0.12em] text-seal-ink">
                        this scan
                      </span>
                    )}
                  </span>

                  <span className="relative block h-[6px] w-full bg-line">
                    <span
                      className="absolute inset-y-0 left-0"
                      style={{ width: `${peer.score}%`, background: accent }}
                    />
                  </span>

                  <span
                    className="text-right font-mono text-[12.5px] tabular-nums"
                    style={{ color: accent }}
                  >
                    {peer.score}
                  </span>
                </li>
              );
            })}
          </ul>
        )}

        <p className="mt-5 border-t border-line pt-3 text-[11px] leading-relaxed text-tx-3">
          These are the {industry} domains {orgName} has assessed with Klyro, counted once each at
          their most recent assessment. This is a position within that set, not a percentile and not
          a statement about the {industry.toLowerCase()} industry — the set is whichever vendors
          your organisation chose to look at. The shared benchmark below is the industry comparison,
          and it holds itself to a minimum pool size for that reason.
        </p>
      </div>
    </section>
  );
}
