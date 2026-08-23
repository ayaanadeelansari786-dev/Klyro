'use client';

import { useEffect, useState } from 'react';

import { COLORS } from '@/lib/constants';
import type { PortfolioComparison, PortfolioScope } from '@/lib/dataset/portfolio';
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
 * Two sets, switchable: the vendor's own industry, and everything the
 * organisation has assessed. The industry set is the sharper comparison and
 * leads when it has anything in it; the whole-portfolio set is the one that
 * exists from the second vendor onward, and is what a buyer with a
 * three-industry supplier list actually wants to see. Switching is a local
 * toggle, not a refetch — both rankings arrive in the same response, computed
 * from the same rows.
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

type ScopeKey = 'industry' | 'all';

function PortfolioPanel({ portfolio }: { portfolio: PortfolioComparison }) {
  const { industry, orgName, sameIndustry, everything, industriesCovered } = portfolio;

  /*
   * The industry set leads when it is a real comparison, and the whole
   * portfolio leads otherwise. Opening on "First Banking vendor you have
   * assessed" while a nine-vendor ranking sits one click away shows the
   * reader the emptier of the two sets by default, which is the wrong way
   * round.
   */
  const [scope, setScope] = useState<ScopeKey>(sameIndustry.rank === null ? 'all' : 'industry');

  const active = scope === 'industry' ? sameIndustry : everything;

  // Nothing else has ever been assessed here, in any industry. There is no
  // set to switch between, so no switch is offered.
  if (everything.rank === null) {
    return (
      <Shell orgName={orgName} industry={industry} tabs={null}>
        <p className="max-w-[62ch] text-[13px] leading-relaxed text-tx-2">
          This is the first vendor {orgName} has assessed. Once another is assessed, this section
          will rank each one against the others — within {industry}, and across the whole portfolio.
        </p>
      </Shell>
    );
  }

  return (
    <Shell
      orgName={orgName}
      industry={industry}
      tabs={
        <div className="flex items-center gap-1" role="tablist" aria-label="Comparison set">
          <ScopeTab
            active={scope === 'industry'}
            onClick={() => setScope('industry')}
            label={industry}
            count={sameIndustry.total}
          />
          <ScopeTab
            active={scope === 'all'}
            onClick={() => setScope('all')}
            label="All vendors"
            count={everything.total}
          />
        </div>
      }
    >
      {active.rank === null ? (
        /*
         * Reachable only for the industry tab, and only when the reader has
         * deliberately switched to it. One vendor is not a ranking: saying
         * "first of one" would dress an empty set as a favourable result,
         * which is the one reading this panel must never produce.
         */
        <p className="max-w-[62ch] text-[13px] leading-relaxed text-tx-2">
          This is the first {industry} vendor {orgName} has assessed. The whole-portfolio ranking
          above compares it against everything else, across{' '}
          {industriesCovered === 1 ? 'this industry' : `${industriesCovered} industries`}.
        </p>
      ) : (
        <p className="max-w-[62ch] text-[14px] leading-relaxed text-tx">
          <span className="font-medium">
            {ordinal(active.rank)} of {active.total}
          </span>{' '}
          {scope === 'industry' ? (
            <>
              {industry} vendors {orgName} has assessed.
            </>
          ) : (
            <>
              vendors {orgName} has assessed, across{' '}
              {industriesCovered === 1 ? 'one industry' : `${industriesCovered} industries`}.
            </>
          )}
        </p>
      )}

      <PeerList scope={active} showIndustry={scope === 'all' && industriesCovered > 1} />

      <p className="mt-5 border-t border-line pt-3 text-[11px] leading-relaxed text-tx-3">
        {scope === 'industry' ? (
          <>
            These are the {industry} domains {orgName} has assessed with Klyro, counted once each at
            their most recent assessment. This is a position within that set, not a percentile and
            not a statement about the {industry.toLowerCase()} industry — the set is whichever
            vendors your organisation chose to look at.
          </>
        ) : (
          <>
            These are every domain {orgName} has assessed with Klyro, counted once each at their
            most recent assessment and regardless of industry. A mixed set is a wider comparison and
            a looser one: sectors differ in what they typically expose, so a low position here can
            reflect the industry as much as the vendor. Use the {industry} tab for the like-for-like
            reading.
          </>
        )}{' '}
        The shared benchmark below is the industry comparison against domains outside your
        organisation, and it holds itself to a minimum pool size for that reason.
      </p>
    </Shell>
  );
}

function Shell({
  orgName,
  industry,
  tabs,
  children,
}: {
  orgName: string;
  industry: string;
  tabs: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="panel overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3 sm:px-6">
        <p className="micro">Your organisation&rsquo;s portfolio</p>
        {tabs ?? (
          <p className="text-[11.5px] text-tx-3">
            {orgName} · {industry}
          </p>
        )}
      </div>
      <div className="px-5 py-5 sm:px-6">{children}</div>
    </section>
  );
}

function ScopeTab({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`rounded-[3px] px-2.5 py-1 text-[11.5px] transition-colors ${
        active ? 'bg-raised text-tx' : 'text-tx-3 hover:text-tx-2'
      }`}
    >
      {label}
      <span className="ml-1.5 font-mono tabular-nums text-tx-3">{count}</span>
    </button>
  );
}

function PeerList({ scope, showIndustry }: { scope: PortfolioScope; showIndustry: boolean }) {
  if (scope.peers.length < 2) return null;

  return (
    <ul className="mt-5">
      {scope.peers.map((peer) => {
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
              {/* Only in the mixed set, and only when the set is actually
                  mixed — repeating one industry down every row of the
                  industry tab would be noise. */}
              {showIndustry && !peer.isTarget && peer.industry && (
                <span className="hidden shrink-0 truncate text-[10.5px] text-tx-3 sm:inline">
                  {peer.industry}
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
  );
}
