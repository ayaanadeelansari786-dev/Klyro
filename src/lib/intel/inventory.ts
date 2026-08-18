/**
 * Asset inventory — what exists, and how it connects.
 *
 * Organisation → host name → address → announced network → running software.
 *
 * Two rules govern this module.
 *
 * 1. It is unscored, and always will be. Every quantity here — how many hosts,
 *    how many networks, how much software — measures how large an organisation
 *    is, not how exposed it is. Scoring any of it would mark down large
 *    companies for being large, which is the same objection that keeps estate
 *    size and news volume out of the composite.
 *
 * 2. Attribution is never stronger than its source. A PTR record is published
 *    by whoever holds the address block, not by the organisation being
 *    assessed, so it is reported as what it is. A host name matching an
 *    internal naming convention is reported as a name, not as a fact about the
 *    system. Every technology carries the exact header, cookie or markup it was
 *    identified from, and a version only ever appears when the target stated it.
 *
 * Everything here is free and keyless: DNS over HTTPS for addresses and reverse
 * lookups, Team Cymru's public DNS interface for network attribution, and the
 * HTTP response the header check already fetched.
 */

import { answersOfType, dnsQuery, mapLimit, safeFetch } from '../checks/util';
import type {
  AssetInventory,
  CategoryResult,
  Confidence,
  HostAsset,
  NetworkAssignment,
  TechnologySignal,
} from '../types';

/** How many discovered host names get an address lookup. */
const MAX_HOSTS = 40;

/**
 * How many distinct addresses get a reverse and network lookup.
 *
 * Both are single TXT/PTR queries run eight at a time, so the ceiling is about
 * keeping the inventory inside the scan's wall time rather than about load. It
 * sits well above the count a typical estate produces; where it does bite, the
 * hosts beyond it are labelled as not looked up rather than as unattributed.
 */
const MAX_ADDRESSES = 64;

/* ------------------------------------------------------------------ *
 * Network attribution
 * ------------------------------------------------------------------ */

/**
 * Team Cymru publish the global routing table over DNS TXT records, free and
 * without a key. `1.0.16.104.origin.asn.cymru.com` returns
 * `"13335 | 104.16.0.0/12 | US | arin | 2010-07-14"`, and
 * `AS13335.asn.cymru.com` returns the operator name.
 *
 * IPv6 uses a separate zone with nibble-reversed lookups. It is deliberately
 * not implemented: the added complexity buys little when almost every host
 * that answers on v6 also answers on v4, and a partially correct attribution
 * is worse than a stated gap. The limitation is published with the inventory.
 */
function reverseIpv4(address: string): string | null {
  const parts = address.split('.');
  if (parts.length !== 4 || parts.some((p) => !/^\d{1,3}$/.test(p) || Number(p) > 255)) return null;
  return parts.reverse().join('.');
}

function isIpv4(address: string): boolean {
  return reverseIpv4(address) !== null;
}

async function cymruTxt(name: string): Promise<string | null> {
  const res = await dnsQuery(name, 'TXT', { confirmAbsence: false });
  if (!res.resolved) return null;
  const answer = answersOfType(res, 'TXT')[0];
  if (!answer) return null;
  return answer.data.replace(/^"|"$/g, '').trim();
}

const asNameCache = new Map<string, string>();

async function asnName(asn: string): Promise<string> {
  const cached = asNameCache.get(asn);
  if (cached) return cached;

  const raw = await cymruTxt(`AS${asn}.asn.cymru.com`);
  // "13335 | US | arin | 2010-07-14 | CLOUDFLARENET, US"
  //
  // The trailing two-letter country belongs to the AS registration and is
  // dropped: the prefix carries its own country code, and printing both
  // produces lines like "Akamai International B.V., NL · NL" where the two
  // are different fields that happen to disagree.
  const field = raw ? (raw.split('|')[4] ?? '').trim() : '';
  const name = field.replace(/,\s*[A-Z]{2}$/, '').trim();
  const resolved = name || `AS${asn}`;
  asNameCache.set(asn, resolved);
  return resolved;
}

async function networkFor(address: string): Promise<NetworkAssignment | null> {
  const reversed = reverseIpv4(address);
  if (!reversed) return null;

  const raw = await cymruTxt(`${reversed}.origin.asn.cymru.com`);
  if (!raw) return null;

  // "13335 | 104.16.0.0/12 | US | arin | 2010-07-14"
  const parts = raw.split('|').map((p) => p.trim());
  const asn = (parts[0] ?? '').split(/\s+/)[0];
  if (!asn || !/^\d+$/.test(asn)) return null;

  return {
    asn,
    asName: await asnName(asn),
    prefix: parts[1] ?? '',
    countryCode: parts[2] ?? '',
    registry: parts[3] ?? '',
    address,
  };
}

async function reverseDns(address: string): Promise<string | null> {
  const reversed = reverseIpv4(address);
  if (!reversed) return null;
  const res = await dnsQuery(`${reversed}.in-addr.arpa`, 'PTR', { confirmAbsence: false });
  if (!res.resolved) return null;
  const answer = res.answers.find((a) => a.type === 12);
  return answer ? answer.data.replace(/\.$/, '') : null;
}

/* ------------------------------------------------------------------ *
 * Naming inference
 * ------------------------------------------------------------------ */

const NAMING_HINTS: { pattern: RegExp; label: string }[] = [
  { pattern: /(^|[.-])(staging|stage|dev|devel|test|testing|qa|uat|sandbox|preprod|demo)([.-]|$)/, label: 'non-production' },
  { pattern: /(^|[.-])(internal|intranet|corp|private|backoffice)([.-]|$)/, label: 'internal' },
  { pattern: /(^|[.-])(admin|manage|manager|webmail|cpanel)([.-]|$)/, label: 'administrative' },
  { pattern: /(^|[.-])(vpn|rdp|citrix|remote|pulse)([.-]|$)/, label: 'remote access' },
];

function namingSuggestion(host: string, domain: string): string | null {
  const prefix = host.endsWith(`.${domain}`) ? host.slice(0, host.length - domain.length - 1) : host;
  for (const hint of NAMING_HINTS) {
    if (hint.pattern.test(prefix)) return hint.label;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Technology fingerprinting
 *
 * Passive only: everything below is read from one response that would have
 * been fetched anyway. No version is ever inferred from behaviour — a version
 * appears in the output only where the target published it in a header or a
 * generator tag, and the evidence field carries that exact string so the
 * reader can judge it.
 * ------------------------------------------------------------------ */

interface HeaderRule {
  header: string;
  /** Matched against the header value; omit to match on presence alone. */
  match?: RegExp;
  name: string;
  category: TechnologySignal['category'];
  confidence: Confidence;
  /** Captures a version from the header value where one is stated. */
  version?: RegExp;
}

const HEADER_RULES: HeaderRule[] = [
  { header: 'cf-ray', name: 'Cloudflare', category: 'cdn', confidence: 'high' },
  { header: 'x-amz-cf-id', name: 'Amazon CloudFront', category: 'cdn', confidence: 'high' },
  { header: 'x-vercel-id', name: 'Vercel', category: 'cdn', confidence: 'high' },
  { header: 'x-nf-request-id', name: 'Netlify', category: 'cdn', confidence: 'high' },
  { header: 'x-fastly-request-id', name: 'Fastly', category: 'cdn', confidence: 'high' },
  { header: 'x-served-by', match: /cache-/i, name: 'Fastly', category: 'cdn', confidence: 'medium' },
  { header: 'x-akamai-transformed', name: 'Akamai', category: 'cdn', confidence: 'high' },
  { header: 'x-azure-ref', name: 'Azure Front Door', category: 'cdn', confidence: 'high' },
  { header: 'x-goog-generation', name: 'Google Cloud Storage', category: 'cdn', confidence: 'medium' },
  { header: 'x-shopify-stage', name: 'Shopify', category: 'cms', confidence: 'high' },
  { header: 'x-drupal-cache', name: 'Drupal', category: 'cms', confidence: 'high' },
  { header: 'x-generator', match: /drupal/i, name: 'Drupal', category: 'cms', confidence: 'high', version: /drupal\s*(\d+[\d.]*)/i },
  { header: 'x-powered-by', match: /express/i, name: 'Express', category: 'framework', confidence: 'high' },
  { header: 'x-powered-by', match: /php/i, name: 'PHP', category: 'language', confidence: 'high', version: /php\/?\s*([\d.]+)/i },
  { header: 'x-powered-by', match: /asp\.net/i, name: 'ASP.NET', category: 'framework', confidence: 'high' },
  { header: 'x-powered-by', match: /next\.js/i, name: 'Next.js', category: 'framework', confidence: 'high' },
  { header: 'x-aspnet-version', name: 'ASP.NET', category: 'framework', confidence: 'high', version: /([\d.]+)/ },
  { header: 'x-nextjs-cache', name: 'Next.js', category: 'framework', confidence: 'high' },
  { header: 'x-rails-request-id', name: 'Ruby on Rails', category: 'framework', confidence: 'high' },
  { header: 'server', match: /nginx/i, name: 'nginx', category: 'server', confidence: 'high', version: /nginx\/([\d.]+)/i },
  { header: 'server', match: /apache/i, name: 'Apache httpd', category: 'server', confidence: 'high', version: /apache\/([\d.]+)/i },
  { header: 'server', match: /microsoft-iis/i, name: 'Microsoft IIS', category: 'server', confidence: 'high', version: /iis\/([\d.]+)/i },
  { header: 'server', match: /litespeed/i, name: 'LiteSpeed', category: 'server', confidence: 'high' },
  { header: 'server', match: /caddy/i, name: 'Caddy', category: 'server', confidence: 'high' },
  { header: 'server', match: /^cloudflare/i, name: 'Cloudflare', category: 'cdn', confidence: 'high' },
  { header: 'server', match: /awselb/i, name: 'AWS Elastic Load Balancing', category: 'cdn', confidence: 'high' },
  { header: 'server', match: /gws|gse/i, name: 'Google Web Server', category: 'server', confidence: 'medium' },
];

interface CookieRule {
  pattern: RegExp;
  name: string;
  category: TechnologySignal['category'];
}

const COOKIE_RULES: CookieRule[] = [
  { pattern: /^PHPSESSID=/i, name: 'PHP', category: 'language' },
  { pattern: /^JSESSIONID=/i, name: 'Java servlet container', category: 'server' },
  { pattern: /^ASP\.NET_SessionId=/i, name: 'ASP.NET', category: 'framework' },
  { pattern: /^laravel_session=/i, name: 'Laravel', category: 'framework' },
  { pattern: /^_shopify_/i, name: 'Shopify', category: 'cms' },
  { pattern: /^wordpress_/i, name: 'WordPress', category: 'cms' },
  { pattern: /^_ga=/i, name: 'Google Analytics', category: 'analytics' },
  { pattern: /^_fbp=/i, name: 'Meta Pixel', category: 'analytics' },
  { pattern: /^__cf_bm=/i, name: 'Cloudflare Bot Management', category: 'security' },
  { pattern: /^incap_ses|^visid_incap/i, name: 'Imperva', category: 'security' },
  { pattern: /^AWSALB|^AWSALBCORS/i, name: 'AWS Application Load Balancer', category: 'cdn' },
];

interface MarkupRule {
  pattern: RegExp;
  name: string;
  category: TechnologySignal['category'];
  confidence: Confidence;
  describe: string;
}

const MARKUP_RULES: MarkupRule[] = [
  { pattern: /\/wp-content\/|\/wp-includes\//i, name: 'WordPress', category: 'cms', confidence: 'high', describe: 'wp-content or wp-includes asset path in the markup' },
  { pattern: /__NEXT_DATA__|\/_next\/static\//, name: 'Next.js', category: 'framework', confidence: 'high', describe: '__NEXT_DATA__ payload or /_next/static asset path' },
  { pattern: /\/_nuxt\//, name: 'Nuxt', category: 'framework', confidence: 'high', describe: '/_nuxt/ asset path' },
  { pattern: /ng-version="([\d.]+)"/, name: 'Angular', category: 'framework', confidence: 'high', describe: 'ng-version attribute on the application root' },
  { pattern: /data-reactroot|react(-dom)?[.@][\d.]+/i, name: 'React', category: 'framework', confidence: 'medium', describe: 'React root attribute or bundled React reference' },
  { pattern: /Drupal\.settings|drupal-settings-json/i, name: 'Drupal', category: 'cms', confidence: 'high', describe: 'Drupal settings object in the markup' },
  { pattern: /\/sites\/all\/(themes|modules)\//i, name: 'Drupal', category: 'cms', confidence: 'medium', describe: 'Drupal theme or module asset path' },
  { pattern: /Joomla!|\/media\/jui\//i, name: 'Joomla', category: 'cms', confidence: 'medium', describe: 'Joomla asset path or generator string' },
  { pattern: /cdn\.shopify\.com/i, name: 'Shopify', category: 'cms', confidence: 'high', describe: 'Shopify CDN asset host' },
  { pattern: /googletagmanager\.com\/gtm\.js/i, name: 'Google Tag Manager', category: 'analytics', confidence: 'high', describe: 'Google Tag Manager script tag' },
  { pattern: /static\.hotjar\.com/i, name: 'Hotjar', category: 'analytics', confidence: 'high', describe: 'Hotjar script host' },
  { pattern: /js\.hs-scripts\.com|js\.hsforms\.net/i, name: 'HubSpot', category: 'analytics', confidence: 'high', describe: 'HubSpot script host' },
];

function dedupeTechnologies(signals: TechnologySignal[]): TechnologySignal[] {
  const best = new Map<string, TechnologySignal>();
  const rank: Record<Confidence, number> = { high: 3, medium: 2, low: 1 };

  for (const signal of signals) {
    const existing = best.get(signal.name);
    if (!existing) {
      best.set(signal.name, signal);
      continue;
    }
    // Prefer the identification that carries a version, then the stronger
    // confidence — a version is only ever present when the target stated one.
    const better =
      (signal.version && !existing.version) ||
      (Boolean(signal.version) === Boolean(existing.version) &&
        rank[signal.confidence] > rank[existing.confidence]);
    if (better) best.set(signal.name, signal);
  }

  return [...best.values()].sort(
    (a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name),
  );
}

async function fingerprint(domain: string): Promise<TechnologySignal[]> {
  const res = await safeFetch(`https://${domain}/`, { method: 'GET', redirect: 'follow' }, 9_000);
  if (!res) return [];

  const signals: TechnologySignal[] = [];

  for (const rule of HEADER_RULES) {
    const value = res.headers.get(rule.header);
    if (value === null) continue;
    if (rule.match && !rule.match.test(value)) continue;

    const version = rule.version ? (rule.version.exec(value)?.[1] ?? null) : null;
    signals.push({
      name: rule.name,
      category: rule.category,
      version,
      confidence: rule.confidence,
      evidence: `Response header \`${rule.header}: ${value.slice(0, 120)}\``,
    });
  }

  const rawCookies =
    typeof (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie === 'function'
      ? (res.headers as unknown as { getSetCookie: () => string[] }).getSetCookie()
      : res.headers.get('set-cookie')
        ? [res.headers.get('set-cookie') as string]
        : [];

  for (const cookie of rawCookies) {
    for (const rule of COOKIE_RULES) {
      if (!rule.pattern.test(cookie)) continue;
      signals.push({
        name: rule.name,
        category: rule.category,
        version: null,
        // A cookie name is a convention, not a declaration — anything can set a
        // cookie called PHPSESSID.
        confidence: 'medium',
        evidence: `Set-Cookie name \`${cookie.split('=')[0]}\``,
      });
    }
  }

  let body = '';
  try {
    body = (await res.text()).slice(0, 300_000);
  } catch {
    body = '';
  }

  if (body) {
    // A generator meta tag is the target stating its own software and version.
    const generator = /<meta[^>]+name=["']generator["'][^>]+content=["']([^"']+)["']/i.exec(body)?.[1];
    if (generator) {
      const version = /([\d]+(?:\.[\d]+)+)/.exec(generator)?.[1] ?? null;
      const name = generator.replace(/\s*[\d]+(?:\.[\d]+)+.*$/, '').trim() || generator;
      signals.push({
        name,
        category: 'cms',
        version,
        confidence: 'high',
        evidence: `<meta name="generator" content="${generator.slice(0, 100)}">`,
      });
    }

    for (const rule of MARKUP_RULES) {
      const match = rule.pattern.exec(body);
      if (!match) continue;
      signals.push({
        name: rule.name,
        category: rule.category,
        // Only a capture group that is itself a version counts as a version.
        version: match[1] && /^\d+(\.\d+)*$/.test(match[1]) ? match[1] : null,
        confidence: rule.confidence,
        evidence: rule.describe,
      });
    }
  }

  return dedupeTechnologies(signals);
}

/* ------------------------------------------------------------------ *
 * Assembly
 * ------------------------------------------------------------------ */

function hostsFromCategories(domain: string, categories: CategoryResult[]): string[] {
  const subdomains = categories.find((c) => c.key === 'subdomains');
  const live = subdomains?.facts?.liveHosts;
  const names = Array.isArray(live) ? live.filter((h): h is string => typeof h === 'string') : [];
  return [domain, ...names.filter((h) => h !== domain)];
}

/**
 * Builds the inventory from names the scan already established, plus address,
 * reverse and network lookups. Returns null only when nothing at all resolved,
 * which means there is no inventory to report rather than an empty one.
 */
export async function buildInventory(
  domain: string,
  categories: CategoryResult[],
): Promise<AssetInventory | null> {
  const candidates = hostsFromCategories(domain, categories);
  const selected = candidates.slice(0, MAX_HOSTS);
  const skipped = Math.max(0, candidates.length - selected.length);

  const [resolved, technologies] = await Promise.all([
    mapLimit(selected, 10, async (host) => {
      const [a, aaaa] = await Promise.all([
        dnsQuery(host, 'A', { confirmAbsence: false }),
        dnsQuery(host, 'AAAA', { confirmAbsence: false }),
      ]);
      const addresses = [
        ...answersOfType(a, 'A').map((r) => r.data),
        ...answersOfType(aaaa, 'AAAA').map((r) => r.data),
      ];
      return { host, addresses, answered: a.resolved || aaaa.resolved };
    }),
    fingerprint(domain),
  ]);

  const withAddresses = resolved.filter((r) => r.addresses.length > 0);
  if (withAddresses.length === 0) return null;

  // One lookup per distinct address rather than per host — a load-balanced
  // estate shares a handful of addresses across dozens of names.
  const allV4 = [...new Set(withAddresses.flatMap((r) => r.addresses).filter(isIpv4))];
  const distinctV4 = allV4.slice(0, MAX_ADDRESSES);
  const lookedUp = new Set(distinctV4);

  const lookups = await mapLimit(distinctV4, 8, async (address) => {
    const [ptr, network] = await Promise.all([reverseDns(address), networkFor(address)]);
    return { address, ptr, network };
  });

  const ptrByAddress = new Map<string, string>();
  const networkByAddress = new Map<string, NetworkAssignment>();
  for (const entry of lookups) {
    if (entry.ptr) ptrByAddress.set(entry.address, entry.ptr);
    if (entry.network) networkByAddress.set(entry.address, entry.network);
  }

  const hosts: HostAsset[] = withAddresses.map((r) => ({
    host: r.host,
    origin: r.host === domain ? 'apex' : 'certificate-transparency',
    addresses: r.addresses,
    reverseDns: [
      ...new Set(r.addresses.map((a) => ptrByAddress.get(a)).filter((p): p is string => Boolean(p))),
    ],
    asns: [
      ...new Set(
        r.addresses.map((a) => networkByAddress.get(a)?.asn).filter((n): n is string => Boolean(n)),
      ),
    ],
    networkLookedUp: r.addresses.some((a) => lookedUp.has(a)),
    namingSuggests: namingSuggestion(r.host, domain),
  }));

  const networks = [...new Map([...networkByAddress.values()].map((n) => [n.asn, n])).values()].sort(
    (a, b) => a.asName.localeCompare(b.asName),
  );

  const ipv6Only = withAddresses.filter((r) => !r.addresses.some(isIpv4)).length;

  const limits = [
    'Host names come from public certificate transparency logs and from this domain\'s own DNS. Anything using a private certificate authority, sitting behind a wildcard certificate, or serving no certificate is invisible to this inventory.',
    `Address, reverse and network lookups were performed for the first ${MAX_HOSTS} host names and the first ${MAX_ADDRESSES} distinct addresses${skipped > 0 ? `; ${skipped} further host names were not resolved in this pass` : ''}${allV4.length > distinctV4.length ? `. ${allV4.length - distinctV4.length} addresses were beyond the lookup budget and are shown as not looked up rather than as unattributed` : ''}.`,
    'Network attribution comes from the public routing table via Team Cymru. It identifies who announces the address block, which for anything hosted on a cloud or CDN is the provider rather than this organisation.',
    'Reverse DNS is published by whoever holds the address block, not by this organisation. A PTR record naming a hosting provider is the provider naming its own infrastructure and implies nothing about ownership.',
    ...(ipv6Only > 0
      ? [`${ipv6Only} host name(s) resolved only over IPv6. Network attribution is IPv4-only, so those carry no ASN.`]
      : []),
    'Technology identification is passive, from one response to the site root. It reports what the software declared about itself; declarations can be edited, proxied or removed, and a version appears only where the target published one.',
    'No port scanning, service enumeration or version probing was performed. Nothing here establishes that a listed technology is vulnerable.',
  ];

  return {
    domain,
    hosts,
    networks,
    technologies,
    unresolvedHosts: resolved.length - withAddresses.length + skipped,
    limits,
    collectedAt: new Date().toISOString(),
  };
}
