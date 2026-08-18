'use client';

import type { DetectedTechnology, TechnologyCategory, TechnologyProfile } from '@/lib/types';

/**
 * What the site declares it runs on, and whose code it loads.
 *
 * Grouped by the question a reader is actually asking rather than by where the
 * signal came from: who runs the infrastructure, what the browser executes,
 * who is watching the visitor, who takes the money, what protects the door.
 *
 * The panel is inventory, and it says so. The only part with a risk attached
 * is the external-supplier count, which is stated in plain terms because the
 * mechanism — someone else's compromised script running on this domain — is
 * not obvious from a list of vendor names.
 */

const GROUPS: { key: TechnologyCategory; label: string; blurb: string }[] = [
  { key: 'infrastructure', label: 'Infrastructure', blurb: 'Servers, edge and hosting' },
  { key: 'frontend', label: 'Frontend', blurb: 'What runs in the browser' },
  { key: 'security', label: 'Security', blurb: 'Abuse and bot protection' },
  { key: 'analytics', label: 'Analytics', blurb: 'Visitor measurement' },
  { key: 'marketing', label: 'Marketing', blurb: 'Advertising and campaign tooling' },
  { key: 'payment', label: 'Payment', blurb: 'Money handling on the page' },
  { key: 'support', label: 'Customer support', blurb: 'Chat and helpdesk widgets' },
  { key: 'email', label: 'Email', blurb: 'From MX and SPF records' },
  { key: 'other', label: 'Other services', blurb: 'From DNS verification records' },
];

const DOT: Record<TechnologyCategory, string> = {
  infrastructure: 'bg-cyan',
  frontend: 'bg-[#4FC3F7]',
  security: 'bg-good',
  analytics: 'bg-warn',
  marketing: 'bg-[#FF7043]',
  payment: 'bg-[#B39DDB]',
  support: 'bg-[#80CBC4]',
  email: 'bg-[#9FA8DA]',
  other: 'bg-tx-3',
};

function Pill({ tech }: { tech: DetectedTechnology }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border border-line bg-raised px-2.5 py-1 text-[11.5px] text-tx-2"
      title={tech.evidence}
    >
      <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${DOT[tech.category]}`} />
      {tech.name}
      {tech.version && <span className="font-mono text-[10.5px] text-tx-3">{tech.version}</span>}
      {tech.version && (
        // A published version is not a vulnerability, and the marker never says
        // it is. It flags that the build number is readable from outside.
        <span aria-hidden="true" title="Version published in the response" className="text-warn">
          ⚑
        </span>
      )}
    </span>
  );
}

export default function TechnologyStack({ profile }: { profile: TechnologyProfile }) {
  const byCategory = GROUPS.map((group) => ({
    ...group,
    items: profile.allDetected.filter((t) => t.category === group.key),
  })).filter((group) => group.items.length > 0);

  const suppliers = profile.thirdPartyScriptHosts.length;

  return (
    <section className="panel overflow-hidden">
      <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-line px-5 py-3.5 sm:px-6">
        <p className="micro">Technology stack</p>
        <p className="text-[11.5px] text-tx-3">
          {profile.allDetected.length} identified · {suppliers} external code supplier
          {suppliers === 1 ? '' : 's'}
        </p>
      </div>

      {byCategory.length === 0 ? (
        <p className="px-5 py-6 text-[12.5px] text-tx-2 sm:px-6">
          Nothing in the response, the markup or the DNS records identified the software behind this
          site. That is an absence of signal rather than an absence of software.
        </p>
      ) : (
        <div className="grid grid-cols-1 divide-y divide-line sm:grid-cols-2 sm:divide-y-0 lg:grid-cols-3">
          {byCategory.map((group, i) => (
            <div
              key={group.key}
              className={`px-5 py-4 sm:px-6 ${i % 2 === 0 ? 'sm:border-r sm:border-line' : ''} lg:border-r lg:border-line`}
            >
              <p className="micro">{group.label}</p>
              <p className="mt-1 text-[11px] text-tx-3">{group.blurb}</p>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {group.items.map((tech) => (
                  <Pill key={`${tech.category}-${tech.name}`} tech={tech} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {suppliers > 0 && (
        <div className="border-t border-line px-5 py-4 sm:px-6">
          <p className="micro">External code suppliers</p>
          <p className="mt-2 max-w-[80ch] text-[12px] leading-relaxed text-tx-2">
            The home page loads script or stylesheet resources from {suppliers} host
            {suppliers === 1 ? '' : 's'} outside {profile.domain}. Each is a separate company whose
            code executes in a visitor&rsquo;s browser on this domain — if any one of them is
            compromised, what runs here changes without this site being touched. Klyro assessed none
            of these vendors.
          </p>
          <p className="mt-2.5 font-mono text-[10.5px] leading-relaxed text-tx-3">
            {profile.thirdPartyScriptHosts.slice(0, 24).join('  ·  ')}
            {suppliers > 24 ? `  ·  +${suppliers - 24} more` : ''}
          </p>
        </div>
      )}

      <div className="border-t border-line px-5 py-4 sm:px-6">
        <p className="micro">What this cannot see</p>
        <ul className="mt-2 space-y-1.5">
          {profile.limits.map((limit) => (
            <li key={limit} className="flex gap-2.5">
              <span aria-hidden="true" className="mt-[7px] h-px w-2.5 shrink-0 bg-line-strong" />
              <span className="text-[11.5px] leading-relaxed text-tx-3">{limit}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
