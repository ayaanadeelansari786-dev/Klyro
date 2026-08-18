'use client';

import { useState } from 'react';

import { TIER_LABELS, TIER_ORDER, groupByTier } from '@/lib/checks/tiering';
import type { RiskTier, SubdomainResult } from '@/lib/types';

/**
 * The discovered estate, grouped by how much attention each host warrants.
 *
 * A flat alphabetical list of ninety host names is an inventory, not an
 * assessment — the reader has to do the triage the tool was supposed to do.
 * Grouping by tier puts the two hosts that matter at the top and folds the
 * eighty-eight that do not out of the way, while keeping them one click from
 * view so nothing is hidden.
 *
 * Critical and high open by default. Everything below stays collapsed: a
 * reader who wants the full estate can ask for it, and one who does not should
 * not have to scroll past it.
 */

const TIER_STYLE: Record<RiskTier, { bar: string; text: string; dot: string }> = {
  critical: { bar: 'bg-bad/15 border-bad/40', text: 'text-bad', dot: 'bg-bad' },
  high: { bar: 'bg-[#FF7043]/12 border-[#FF7043]/35', text: 'text-[#FF7043]', dot: 'bg-[#FF7043]' },
  medium: { bar: 'bg-warn/12 border-warn/30', text: 'text-warn', dot: 'bg-warn' },
  low: { bar: 'bg-[#4FC3F7]/10 border-[#4FC3F7]/25', text: 'text-[#4FC3F7]', dot: 'bg-[#4FC3F7]' },
  info: { bar: 'bg-raised border-line', text: 'text-tx-3', dot: 'bg-tx-3' },
};

/** Green for a served page, amber for a gate, red for a fault, grey for silence. */
function statusTone(status: number | null): string {
  if (status === null) return 'border-line text-tx-3';
  if (status >= 200 && status < 300) return 'border-good/40 text-good';
  if (status >= 300 && status < 500) return 'border-warn/40 text-warn';
  return 'border-bad/40 text-bad';
}

function statusLabel(result: SubdomainResult): string {
  if (result.statusCode !== null) return String(result.statusCode);
  if (result.unreachableReason === 'timed-out') return 'timeout';
  if (result.unreachableReason === 'not-probed') return 'not probed';
  return 'no reply';
}

function HostRow({ result }: { result: SubdomainResult }) {
  return (
    <li className="border-t border-line px-4 py-3 first:border-t-0 sm:px-5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[12.5px] text-tx">{result.hostname}</span>

        <span
          className={`rounded-sm border px-1.5 py-px font-mono text-[10.5px] ${statusTone(result.statusCode)}`}
          title={
            result.unreachableReason === 'not-probed'
              ? 'No HTTP request was made to this host within the scan budget'
              : undefined
          }
        >
          {statusLabel(result)}
        </span>

        {result.detectedPlatform && (
          // A dashed border marks an unconfirmed identification: the response
          // mentioned the product without emitting anything only that product
          // emits. It reads as a guess because it is one.
          <span
            className={`rounded-full px-2 py-px text-[10.5px] ${
              result.platformConfirmed
                ? 'border border-line-strong text-tx-2'
                : 'border border-dashed border-line text-tx-3'
            }`}
            title={result.platformEvidence ? `Identified by ${result.platformEvidence}` : undefined}
          >
            {result.detectedPlatform}
            {result.platformConfirmed ? '' : '?'}
          </span>
        )}

        {result.looksLikeLogin && (
          <span className="rounded-full border border-line px-2 py-px text-[10.5px] text-tx-3">
            sign-in
          </span>
        )}

        {result.redirectTarget && (
          <span className="font-mono text-[10.5px] text-tx-3">→ {result.redirectTarget}</span>
        )}
      </div>

      <p className="mt-1.5 text-[11.5px] leading-relaxed text-tx-3">{result.riskReason}</p>

      {(result.serverHeader || result.poweredBy || result.cookieNames.length > 0) && (
        <p className="mt-1 font-mono text-[10.5px] leading-relaxed text-tx-3/80">
          {[
            result.serverHeader && `Server: ${result.serverHeader}`,
            result.poweredBy && `X-Powered-By: ${result.poweredBy}`,
            result.authType && `Auth: ${result.authType}`,
            // Names only — values are discarded at the probe. See probe.ts.
            result.cookieNames.length > 0 && `Cookies: ${result.cookieNames.join(', ')}`,
          ]
            .filter(Boolean)
            .join('  ·  ')}
        </p>
      )}
    </li>
  );
}

function Tier({
  tier,
  results,
  defaultOpen,
}: {
  tier: RiskTier;
  results: SubdomainResult[];
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const style = TIER_STYLE[tier];

  return (
    <div className="overflow-hidden rounded border border-line">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={`flex w-full items-center gap-3 border-b px-4 py-2.5 text-left transition-colors sm:px-5 ${style.bar} ${open ? '' : 'border-b-transparent'}`}
      >
        <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${style.dot}`} />
        <span className={`text-[12.5px] font-medium ${style.text}`}>
          {TIER_LABELS[tier]} ({results.length})
        </span>
        <span aria-hidden="true" className="ml-auto text-[11px] text-tx-3">
          {open ? '−' : '+'}
        </span>
      </button>

      {open && (
        <ul>
          {results.map((result) => (
            <HostRow key={result.hostname} result={result} />
          ))}
        </ul>
      )}
    </div>
  );
}

export default function SubdomainTiers({ subdomains }: { subdomains: SubdomainResult[] }) {
  const grouped = groupByTier(subdomains);
  const populated = TIER_ORDER.filter((tier) => grouped[tier].length > 0);
  const probed = subdomains.filter((s) => s.unreachableReason !== 'not-probed').length;
  const identified = subdomains.filter((s) => s.detectedPlatform && s.platformConfirmed).length;

  return (
    <section className="panel overflow-hidden">
      <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-line px-5 py-3.5 sm:px-6">
        <p className="micro">Subdomain exposure</p>
        <p className="text-[11.5px] text-tx-3">
          {subdomains.length} resolving · {probed} requested · {identified} identified
        </p>
      </div>

      <div className="space-y-2.5 px-4 py-5 sm:px-6">
        {populated.length === 0 ? (
          <p className="text-[12.5px] text-tx-2">
            No resolving host names were discovered for this domain in the public certificate logs.
          </p>
        ) : (
          populated.map((tier) => (
            <Tier
              key={tier}
              tier={tier}
              results={grouped[tier]}
              defaultOpen={tier === 'critical' || tier === 'high'}
            />
          ))
        )}

        <p className="pt-2 text-[11px] leading-relaxed text-tx-3">
          Each host received at most one GET to its root, with redirects unfollowed and the response
          read up to 8KB. Software names come from what the response published about itself and can
          be edited, proxied or removed. A name followed by <span className="text-tx-2">?</span> was
          inferred from a mention rather than confirmed, and never raises a host&rsquo;s tier. Klyro
          did not authenticate to any of these systems, so a host reported as reachable is not a
          host reported as unprotected.
        </p>
      </div>
    </section>
  );
}
