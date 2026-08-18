'use client';

import { useMemo, useState } from 'react';

import InventoryGraph from '@/components/InventoryGraph';
import type { AssetInventory, HostAsset, NetworkAssignment } from '@/lib/types';

/**
 * The asset inventory: organisation → host → address → network → software.
 *
 * Rendered as a relationship view rather than four separate tables, because
 * the point of the section is what connects to what. Nothing here is scored,
 * and the limits block is not collapsible — an inventory that looks complete
 * when it is not is worse than no inventory.
 */

const CONFIDENCE_TONE: Record<string, string> = {
  high: 'text-risk-good',
  medium: 'text-risk-warn',
  low: 'text-tx-3',
};

const CATEGORY_LABEL: Record<string, string> = {
  server: 'Web server',
  framework: 'Framework',
  cms: 'Content management',
  cdn: 'CDN / edge',
  language: 'Language runtime',
  analytics: 'Analytics',
  security: 'Security / bot management',
};

export default function InventoryPanel({ inventory }: { inventory: AssetInventory }) {
  const [showAllHosts, setShowAllHosts] = useState(false);

  const { hosts, networks, technologies } = inventory;

  /**
   * Hosts grouped by the network their addresses sit in.
   *
   * "Not looked up" and "looked up and nothing came back" are separate groups.
   * Collapsing them puts hosts the scan simply did not reach under a heading
   * that reads like a finding, which is the same mistake as reporting a failed
   * DNS lookup as an absent record.
   */
  const byNetwork = useMemo(() => {
    const groups = new Map<
      string,
      { network: NetworkAssignment | null; hosts: HostAsset[]; kind: 'network' | 'none' | 'skipped' }
    >();

    for (const host of hosts) {
      const asn = host.asns[0];
      const key = asn ?? (host.networkLookedUp ? 'unattributed' : 'not-looked-up');
      const network = asn ? (networks.find((n) => n.asn === asn) ?? null) : null;
      const kind = asn ? 'network' : host.networkLookedUp ? 'none' : 'skipped';
      const entry = groups.get(key) ?? { network, hosts: [], kind };
      entry.hosts.push(host);
      groups.set(key, entry);
    }

    // Attributed networks first, largest first; the two residual groups last.
    const rank = { network: 0, none: 1, skipped: 2 } as const;
    return [...groups.values()].sort(
      (a, b) => rank[a.kind] - rank[b.kind] || b.hosts.length - a.hosts.length,
    );
  }, [hosts, networks]);

  const byCategory = useMemo(() => {
    const groups = new Map<string, typeof technologies>();
    for (const tech of technologies) {
      groups.set(tech.category, [...(groups.get(tech.category) ?? []), tech]);
    }
    return [...groups.entries()];
  }, [technologies]);

  const addressCount = new Set(hosts.flatMap((h) => h.addresses)).size;

  return (
    <section className="panel">
      <div className="px-5 py-5 sm:px-6">
        <p className="micro">Inventory</p>
        <h2 className="mt-2 text-[17px] font-semibold tracking-tight text-tx">
          What this organisation runs on
        </h2>
        <p className="mt-2 max-w-2xl text-[12px] leading-relaxed text-tx-3">
          Host names, the addresses they resolve to, the networks announcing those addresses, and
          the software the site declares about itself. Recorded, never scored — every number here
          measures how large an organisation is rather than how exposed it is.
        </p>

        <dl className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-4">
          {[
            { label: 'Host names', value: hosts.length },
            { label: 'Addresses', value: addressCount },
            { label: 'Networks', value: networks.length },
            { label: 'Technologies', value: technologies.length },
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

      {/* ---------- Relationship view ----------
           Every edge is a measured host-to-ASN mapping and its weight is the
           host count, so concentration is visible without reading the list. */}
      <div className="rule" />
      <div className="px-5 py-5 sm:px-6">
        <p className="micro">How the estate is distributed</p>
        <div className="mt-4 overflow-x-auto">
          <div className="min-w-[560px]">
            <InventoryGraph inventory={inventory} />
          </div>
        </div>
      </div>

      {/* ---------- Hosts, grouped by the network behind them ---------- */}
      <div className="rule" />
      <div className="px-5 py-5 sm:px-6">
        <p className="micro">Hosts by announcing network</p>

        <div className="mt-4 space-y-5">
          {byNetwork.map((group, i) => {
            const visible = showAllHosts ? group.hosts : group.hosts.slice(0, 6);
            return (
              <div key={group.network?.asn ?? `unattributed-${i}`}>
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="text-[13px] font-medium text-tx">
                    {group.network
                      ? group.network.asName
                      : group.kind === 'skipped'
                        ? 'Network not looked up in this pass'
                        : 'Looked up, no routing attribution returned'}
                  </span>
                  {group.network && (
                    <span className="font-mono text-[10.5px] text-tx-3">
                      AS{group.network.asn} · {group.network.prefix} · {group.network.countryCode} ·{' '}
                      {group.network.registry}
                    </span>
                  )}
                  <span className="font-mono text-[10.5px] text-tx-3">
                    {group.hosts.length} host{group.hosts.length === 1 ? '' : 's'}
                  </span>
                  {group.kind === 'skipped' && (
                    <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-tx-3">
                      budget, not a finding
                    </span>
                  )}
                </div>

                <ul className="mt-2 space-y-1.5 border-l border-line pl-4">
                  {visible.map((host) => (
                    <li key={host.host} className="text-[11.5px] leading-relaxed">
                      <span className="font-mono text-tx-2">{host.host}</span>
                      {host.namingSuggests && (
                        <span className="ml-2 font-mono text-[10px] uppercase tracking-[0.1em] text-risk-warn">
                          name suggests {host.namingSuggests}
                        </span>
                      )}
                      <span className="ml-2 font-mono text-[10.5px] text-tx-3">
                        {host.addresses.slice(0, 3).join(', ')}
                        {host.addresses.length > 3 ? ` +${host.addresses.length - 3}` : ''}
                      </span>
                      {host.reverseDns.length > 0 && (
                        <span className="ml-2 font-mono text-[10.5px] text-tx-3">
                          ← {host.reverseDns[0]}
                        </span>
                      )}
                    </li>
                  ))}
                  {!showAllHosts && group.hosts.length > visible.length && (
                    <li className="font-mono text-[10.5px] text-tx-3">
                      +{group.hosts.length - visible.length} more
                    </li>
                  )}
                </ul>
              </div>
            );
          })}
        </div>

        {hosts.length > 6 && (
          <button
            type="button"
            onClick={() => setShowAllHosts((v) => !v)}
            className="mt-4 font-mono text-[11px] uppercase tracking-[0.1em] text-tx-3 underline-offset-4 hover:text-tx hover:underline"
          >
            {showAllHosts ? 'Show fewer' : 'Show every host'}
          </button>
        )}
      </div>

      {/* ---------- Technology ---------- */}
      {technologies.length > 0 && (
        <>
          <div className="rule" />
          <div className="px-5 py-5 sm:px-6">
            <p className="micro">Software identified</p>
            <p className="mt-2 max-w-2xl text-[11.5px] leading-relaxed text-tx-3">
              Read from one response to the site root. A version appears only where the target
              published one — nothing here is inferred from behaviour, and nothing here establishes
              that a listed technology is vulnerable.
            </p>

            <div className="mt-4 space-y-4">
              {byCategory.map(([category, items]) => (
                <div key={category}>
                  <p className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-tx-3">
                    {CATEGORY_LABEL[category] ?? category}
                  </p>
                  <ul className="mt-1.5 space-y-1.5">
                    {items.map((tech) => (
                      <li key={`${tech.name}-${tech.evidence}`} className="text-[12px] leading-relaxed">
                        <span className="font-medium text-tx">{tech.name}</span>
                        {tech.version ? (
                          <span className="ml-2 font-mono text-[11px] text-tx-2">
                            {tech.version}
                          </span>
                        ) : (
                          <span className="ml-2 font-mono text-[10.5px] text-tx-3">
                            version not stated
                          </span>
                        )}
                        <span
                          className={`ml-2 font-mono text-[10px] uppercase tracking-[0.1em] ${
                            CONFIDENCE_TONE[tech.confidence]
                          }`}
                        >
                          {tech.confidence}
                        </span>
                        <span className="mt-0.5 block font-mono text-[10.5px] leading-relaxed text-tx-3">
                          {tech.evidence}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {/* ---------- Limits. Not collapsible, by design. ---------- */}
      <div className="rule" />
      <div className="px-5 py-5 sm:px-6">
        <p className="micro">What this inventory cannot see</p>
        <ul className="mt-3 space-y-2">
          {inventory.limits.map((limit) => (
            <li key={limit} className="flex gap-2.5 text-[11.5px] leading-relaxed text-tx-3">
              <span className="mt-[6px] h-[3px] w-[3px] shrink-0 rounded-full bg-tx-3" aria-hidden="true" />
              <span>{limit}</span>
            </li>
          ))}
        </ul>
        {inventory.unresolvedHosts > 0 && (
          <p className="mt-3 text-[11.5px] leading-relaxed text-tx-3">
            {inventory.unresolvedHosts} discovered host name
            {inventory.unresolvedHosts === 1 ? '' : 's'} could not be resolved in this pass and{' '}
            {inventory.unresolvedHosts === 1 ? 'is' : 'are'} not counted above.
          </p>
        )}
      </div>
    </section>
  );
}
