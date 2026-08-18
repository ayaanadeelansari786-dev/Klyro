'use client';

import { useMemo } from 'react';

import type { AssetInventory } from '@/lib/types';

/**
 * Organisation → announcing network → host names.
 *
 * Every edge here is a measured host-to-ASN mapping, and the thickness of one
 * is the number of host names behind it — nothing is drawn that was not
 * observed. Hosts whose network could not be looked up get their own terminal
 * node rather than being folded into an "unknown" bucket alongside hosts that
 * were looked up and came back unattributed; those are different facts and the
 * diagram would be lying if it merged them.
 *
 * Deliberately not interactive. It exists to make the shape of an estate
 * legible at a glance — how concentrated it is, and on whom — which is the
 * question the grouped list below answers slowly.
 */

const ROW_HEIGHT = 34;
const TOP = 26;
const DOMAIN_X = 4;
const DOMAIN_W = 150;
const NETWORK_X = 250;
const NETWORK_W = 300;
const MAX_ROWS = 8;

interface Row {
  label: string;
  detail: string;
  hosts: number;
  flagged: number;
  kind: 'network' | 'unattributed' | 'skipped';
}

export default function InventoryGraph({ inventory }: { inventory: AssetInventory }) {
  const rows = useMemo<Row[]>(() => {
    const byAsn = new Map<string, Row>();

    for (const host of inventory.hosts) {
      const asn = host.asns[0];
      const key = asn ?? (host.networkLookedUp ? 'unattributed' : 'skipped');
      const network = asn ? inventory.networks.find((n) => n.asn === asn) : undefined;

      const row =
        byAsn.get(key) ??
        {
          label: network?.asName ?? (key === 'skipped' ? 'Not looked up' : 'No attribution'),
          detail: network ? `AS${network.asn} · ${network.countryCode}` : 'this pass',
          hosts: 0,
          flagged: 0,
          kind: asn ? ('network' as const) : key === 'skipped' ? ('skipped' as const) : ('unattributed' as const),
        };

      row.hosts += 1;
      if (host.namingSuggests) row.flagged += 1;
      byAsn.set(key, row);
    }

    const all = [...byAsn.values()].sort(
      (a, b) => (a.kind === 'network' ? 0 : 1) - (b.kind === 'network' ? 0 : 1) || b.hosts - a.hosts,
    );

    if (all.length <= MAX_ROWS) return all;

    // Collapsing is only honest if the collapsed row says how many it covers.
    const shown = all.slice(0, MAX_ROWS - 1);
    const rest = all.slice(MAX_ROWS - 1);
    shown.push({
      label: `${rest.length} further networks`,
      detail: 'smallest by host count',
      hosts: rest.reduce((sum, r) => sum + r.hosts, 0),
      flagged: rest.reduce((sum, r) => sum + r.flagged, 0),
      kind: 'network',
    });
    return shown;
  }, [inventory]);

  if (rows.length === 0) return null;

  const height = TOP + rows.length * ROW_HEIGHT + 12;
  const totalHosts = rows.reduce((sum, r) => sum + r.hosts, 0);
  const domainY = TOP + (rows.length * ROW_HEIGHT) / 2 - 10;

  return (
    <svg
      viewBox={`0 0 720 ${height}`}
      className="w-full"
      role="img"
      aria-label={`${inventory.domain} resolves across ${rows.length} announcing networks covering ${totalHosts} host names`}
    >
      <text x={DOMAIN_X} y={12} className="fill-tx-3 font-mono text-[9px] uppercase tracking-[0.12em]">
        Organisation
      </text>
      <text x={NETWORK_X} y={12} className="fill-tx-3 font-mono text-[9px] uppercase tracking-[0.12em]">
        Announcing network
      </text>
      <text x={600} y={12} className="fill-tx-3 font-mono text-[9px] uppercase tracking-[0.12em]">
        Host names
      </text>

      {/* Domain node */}
      <rect
        x={DOMAIN_X}
        y={domainY}
        width={DOMAIN_W}
        height={22}
        className="fill-raised stroke-line-strong"
        strokeWidth={1}
      />
      <text
        x={DOMAIN_X + 8}
        y={domainY + 15}
        className="fill-tx font-mono text-[10px]"
      >
        {inventory.domain.length > 22 ? `${inventory.domain.slice(0, 21)}…` : inventory.domain}
      </text>

      {rows.map((row, i) => {
        const y = TOP + i * ROW_HEIGHT;
        const mid = y + 11;
        // Edge weight is the host count, so a concentrated estate looks
        // concentrated rather than looking like a tidy fan.
        const weight = Math.max(1.5, Math.min(11, (row.hosts / totalHosts) * 26));

        return (
          <g key={`${row.label}-${i}`}>
            <path
              d={`M ${DOMAIN_X + DOMAIN_W} ${domainY + 11} C ${DOMAIN_X + DOMAIN_W + 60} ${domainY + 11}, ${NETWORK_X - 60} ${mid}, ${NETWORK_X} ${mid}`}
              fill="none"
              strokeWidth={weight}
              className={row.kind === 'network' ? 'stroke-line-strong' : 'stroke-line'}
              strokeOpacity={row.kind === 'network' ? 0.75 : 0.45}
            />

            <rect
              x={NETWORK_X}
              y={y}
              width={NETWORK_W}
              height={22}
              className={row.kind === 'network' ? 'fill-raised stroke-line' : 'fill-transparent stroke-line'}
              strokeWidth={1}
              strokeDasharray={row.kind === 'skipped' ? '3 3' : undefined}
            />
            <text x={NETWORK_X + 8} y={mid + 4} className="fill-tx text-[10.5px]">
              {row.label.length > 34 ? `${row.label.slice(0, 33)}…` : row.label}
            </text>
            <text
              x={NETWORK_X + NETWORK_W - 8}
              y={mid + 4}
              textAnchor="end"
              className="fill-tx-3 font-mono text-[9px]"
            >
              {row.detail}
            </text>

            <text x={600} y={mid + 4} className="fill-tx font-mono text-[11px]">
              {row.hosts}
            </text>
            {row.flagged > 0 && (
              <text x={632} y={mid + 4} className="fill-risk-warn font-mono text-[9px]">
                {row.flagged} named internal
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}
