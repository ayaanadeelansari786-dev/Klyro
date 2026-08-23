'use client';

import { classifyPort, serviceFor, type PortClass } from '@/lib/checks/ports';
import type { InternetDbFacts } from '@/lib/checks/internetdb';

/**
 * Network exposure, as its own section — not folded into a matrix row or a
 * paragraph in the risk register.
 *
 * Every other enrichment section on this page (Subdomains, Technology,
 * Inventory) gets its own place in the rail because the reader has to be able
 * to find "what does the outside world already know" without reading the
 * whole findings list top to bottom first. This is that section for the one
 * signal Klyro did not measure itself: what Shodan's InternetDB already
 * recorded on this address.
 *
 * Each port is its own row — the previous version folded every notable port
 * into a single finding's prose ("Shodan records administrative ports as
 * open on this address: 22, 3389"), which read as one line to skim past
 * rather than as several separate, individually actionable things to check.
 */

const CLASS_LABEL: Record<PortClass, string> = {
  critical: 'Data store',
  remote: 'Remote access',
  'admin-web': 'Admin surface',
  expected: 'Expected',
  other: 'Other',
};

const CLASS_TONE: Record<PortClass, { text: string; dot: string; border: string }> = {
  critical: { text: 'text-risk-bad', dot: 'bg-risk-bad', border: 'border-risk-bad/35' },
  remote: { text: 'text-risk-high', dot: 'bg-risk-high', border: 'border-risk-high/30' },
  'admin-web': { text: 'text-risk-warn', dot: 'bg-risk-warn', border: 'border-risk-warn/25' },
  expected: { text: 'text-tx-3', dot: 'bg-tx-3', border: 'border-line' },
  other: { text: 'text-tx-2', dot: 'bg-tx-3', border: 'border-line' },
};

function PortRow({ port }: { port: number }) {
  const cls = classifyPort(port);
  const service = serviceFor(port);
  const tone = CLASS_TONE[cls];

  return (
    <li
      className={`flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line px-4 py-2.5 first:border-t-0 sm:px-5`}
    >
      <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${tone.dot}`} />
      <span className="font-mono text-[13px] text-tx">{port}</span>
      {service && <span className="text-[12px] text-tx-2">{service}</span>}
      <span className={`ml-auto font-mono text-[10px] uppercase tracking-[0.1em] ${tone.text}`}>
        {CLASS_LABEL[cls]}
      </span>
    </li>
  );
}

export default function NetworkExposure({ facts }: { facts: InternetDbFacts }) {
  const notable = facts.notablePorts.filter((p) => p);
  const critical = notable.filter((p) => classifyPort(p) === 'critical');
  const remoteOrAdmin = notable.filter((p) => classifyPort(p) !== 'critical');
  const clean = notable.length === 0;

  return (
    <section className="panel overflow-hidden">
      <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-line px-5 py-3.5 sm:px-6">
        <p className="micro">Network exposure</p>
        <p className="text-[11.5px] text-tx-3">
          {facts.address} · {facts.ports.length} port{facts.ports.length === 1 ? '' : 's'} on record
        </p>
      </div>

      <div className="px-4 py-5 sm:px-6">
        {clean ? (
          <p className="text-[12.5px] text-tx-2">
            Shodan holds a record for {facts.address} and lists none of the data-store, remote-access
            or administrative ports Klyro looks for as open.
          </p>
        ) : (
          <div className="space-y-2.5">
            {critical.length > 0 && (
              <div className="overflow-hidden rounded border border-risk-bad/35">
                <p className="border-b border-risk-bad/35 bg-risk-bad/[0.06] px-4 py-2 text-[11.5px] font-medium text-risk-bad sm:px-5">
                  Data-store ports ({critical.length})
                </p>
                <ul>
                  {critical.map((p) => (
                    <PortRow key={p} port={p} />
                  ))}
                </ul>
              </div>
            )}

            {remoteOrAdmin.length > 0 && (
              <div className="overflow-hidden rounded border border-line">
                <p className="border-b border-line bg-raised px-4 py-2 text-[11.5px] font-medium text-tx-2 sm:px-5">
                  Remote-access &amp; administrative ports ({remoteOrAdmin.length})
                </p>
                <ul>
                  {remoteOrAdmin.map((p) => (
                    <PortRow key={p} port={p} />
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {facts.vulns.length > 0 && (
          <div className="mt-4 overflow-hidden rounded border border-risk-warn/30">
            <p className="border-b border-risk-warn/30 bg-risk-warn/[0.06] px-4 py-2 text-[11.5px] font-medium text-risk-warn sm:px-5">
              Vulnerability identifiers attributed by Shodan ({facts.vulns.length})
            </p>
            <p className="px-4 py-2.5 font-mono text-[11.5px] leading-relaxed text-tx-2 sm:px-5">
              {facts.vulns.join(', ')}
            </p>
          </div>
        )}

        {facts.hostnamesInDomain.length > 0 && (
          <p className="mt-4 text-[11.5px] leading-relaxed text-tx-3">
            <span className="text-tx-2">{facts.hostnamesInDomain.length} host name(s)</span> in this
            domain resolve to {facts.address}: <span className="font-mono">{facts.hostnamesInDomain.join(', ')}</span>
            {facts.hostnamesElsewhere > 0 &&
              ` — a further ${facts.hostnamesElsewhere} outside this domain share the address.`}
          </p>
        )}

        <p className="mt-4 border-t border-line pt-3 text-[11px] leading-relaxed text-tx-3">
          Data from Shodan InternetDB, a third-party record — Klyro opened no connection to any of
          these ports and performed no scan of this address. InternetDB publishes no crawl date, so
          an entry may be from this morning or from years ago; check it against the operator&rsquo;s
          own inventory rather than treating it as current.
        </p>
      </div>
    </section>
  );
}
