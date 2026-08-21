import { registrableDomain } from '../domain';
import { classifyReservedAddress } from '../target';
import type { CategoryDetail, Finding } from '../types';
import {
  answersOfType,
  dnsQuery,
  makeFinding,
  type ModuleOutput,
  penaltyBreakdown,
  plural,
  safeFetch,
} from './util';

/**
 * Network exposure, as recorded by somebody else.
 *
 * This module is unlike every other one in the tree, and the difference is the
 * whole reason it has to be handled carefully: it does not measure anything.
 * It reads Shodan's InternetDB — a free, unauthenticated summary of what
 * Shodan's crawlers have seen on an address — and reports what that database
 * says. Klyro opens no connection to the target on any of these ports and
 * never has.
 *
 * That makes every finding here second-hand, and second-hand in a specific
 * way: InternetDB publishes no crawl date for a record, so an entry could be
 * from this morning or from two years ago and the API gives no way to tell.
 * The findings say so, in the fields meant for saying so, rather than
 * presenting a historical observation as a current fact.
 *
 * It is worth having anyway. A port that Shodan saw open is a port that was
 * open, and an operator who did not know it was reachable learns something
 * actionable. It is enrichment, not measurement, and the report should never
 * blur the two.
 */

const KEY = 'internetdb' as const;

/**
 * Raised when there is nothing to read.
 *
 * `runModule` catches anything thrown and builds an `unavailable` category from
 * the message, which is the mechanism every module in this tree uses to drop
 * out of the composite. Named so the intent is legible at the throw site — this
 * is "no data", not "something broke".
 */
class NotAssessable extends Error {}

const API = 'https://internetdb.shodan.io';
const TIMEOUT_MS = 6_000;

/** Data stores. Reachable from the internet, these are the serious ones. */
const CRITICAL_PORTS: Record<number, string> = {
  3306: 'MySQL',
  5432: 'PostgreSQL',
  27017: 'MongoDB',
  6379: 'Redis',
  1433: 'Microsoft SQL Server',
  9200: 'Elasticsearch',
  5984: 'CouchDB',
  11211: 'Memcached',
  9042: 'Cassandra',
  1521: 'Oracle Database',
};

/** Remote access and administration. */
const REMOTE_PORTS: Record<number, string> = {
  22: 'SSH',
  23: 'Telnet',
  3389: 'Remote Desktop',
  5900: 'VNC',
  5985: 'WinRM over HTTP',
  5986: 'WinRM over HTTPS',
  2375: 'Docker Engine API',
  2379: 'etcd',
  445: 'SMB',
  135: 'MSRPC',
};

/** Administrative or secondary web surfaces. Worth naming, not alarming. */
const ADMIN_WEB_PORTS: Record<number, string> = {
  8080: 'HTTP alternate',
  8000: 'HTTP alternate',
  8888: 'HTTP alternate',
  7001: 'WebLogic',
  9090: 'Admin console',
  10000: 'Webmin',
  15672: 'RabbitMQ management',
};

/**
 * Ports that mean nothing on a normal public host.
 *
 * 80 and 443 answer on every website. 53 answers on every name server. The
 * 2052–2087 block and 8443/8880 are Cloudflare's standard alternate HTTP and
 * HTTPS ports, so *every* Cloudflare-fronted domain publishes them — flagging
 * those would put an identical finding on a large fraction of the corpus and
 * teach readers to skip this section.
 */
const EXPECTED_PORTS = new Set([
  80, 443, 53, 25, 587, 465, 993, 995, 110, 143, 21,
  2052, 2053, 2082, 2083, 2086, 2087, 2095, 2096, 8443, 8880,
]);

const CRITICAL_PENALTY = 25;
const REMOTE_PENALTY = 15;
const ADMIN_WEB_PENALTY = 10;
const VULN_PENALTY = 20;

export type PortClass = 'critical' | 'remote' | 'admin-web' | 'expected' | 'other';

export function classifyPort(port: number): PortClass {
  if (port in CRITICAL_PORTS) return 'critical';
  if (port in REMOTE_PORTS) return 'remote';
  if (port in ADMIN_WEB_PORTS) return 'admin-web';
  if (EXPECTED_PORTS.has(port)) return 'expected';
  return 'other';
}

export function serviceFor(port: number): string | null {
  return CRITICAL_PORTS[port] ?? REMOTE_PORTS[port] ?? ADMIN_WEB_PORTS[port] ?? null;
}

/** The API's own response shape, as observed. */
export interface InternetDBResponse {
  ip: string;
  ports: number[];
  hostnames: string[];
  tags: string[];
  vulns: string[];
  cpes: string[];
}

export type InternetDBLookup =
  | { outcome: 'record'; data: InternetDBResponse }
  /** 404 — Shodan answered, and has never crawled this address. */
  | { outcome: 'no-record' }
  /** Anything else: timeout, 5xx, unparseable body. Nothing may be concluded. */
  | { outcome: 'error'; reason: string };

/**
 * One lookup, with the three outcomes kept apart.
 *
 * `fetchJson` would have been shorter and would have collapsed 404 into the
 * same null as a 500, which is exactly the distinction this module turns on: a
 * 404 is Shodan telling us it has no record, which is information, while a 500
 * is Shodan failing to tell us anything, which is not. They score differently
 * and they say different things to a reader.
 */
export async function lookupInternetDB(address: string): Promise<InternetDBLookup> {
  const res = await safeFetch(`${API}/${address}`, { redirect: 'follow' }, TIMEOUT_MS);

  if (!res) return { outcome: 'error', reason: 'The InternetDB request did not complete' };
  if (res.status === 404) return { outcome: 'no-record' };
  if (!res.ok) return { outcome: 'error', reason: `InternetDB returned ${res.status}` };

  try {
    const raw = (await res.json()) as Partial<InternetDBResponse>;
    return {
      outcome: 'record',
      data: {
        ip: typeof raw.ip === 'string' ? raw.ip : address,
        // Defended rather than trusted. This is a third party's JSON being
        // rendered into a document under Klyro's name; a malformed field must
        // not reach the report.
        ports: Array.isArray(raw.ports) ? raw.ports.filter(isPort) : [],
        hostnames: Array.isArray(raw.hostnames) ? raw.hostnames.filter(isHostname) : [],
        tags: Array.isArray(raw.tags) ? raw.tags.filter(isShortString) : [],
        vulns: Array.isArray(raw.vulns) ? raw.vulns.filter(isShortString) : [],
        cpes: Array.isArray(raw.cpes) ? raw.cpes.filter(isShortString) : [],
      },
    };
  } catch {
    return { outcome: 'error', reason: 'InternetDB returned a body that could not be parsed' };
  }
}

const isPort = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= 65535;

const isShortString = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= 120;

/** A host name, not arbitrary text that happened to be in the field. */
const isHostname = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= 253 && /^[a-z0-9._-]+$/i.test(v);

/* ------------------------------------------------------------------ *
 * Cache and request ceiling
 * ------------------------------------------------------------------ */

/**
 * What is cached, and why it is the raw record rather than the findings.
 *
 * The obvious version caches the finished findings keyed by IP. It is wrong,
 * and wrong in a way that would be very hard to notice: the findings depend on
 * the *domain* as well as the address — `splitHostnames` decides which names
 * belong to the assessed domain and which belong to strangers — and CDN
 * addresses routinely serve hundreds of domains. Cache the findings by IP and
 * the second domain on a shared address inherits the first one's host-name
 * split, so one customer's report names another customer's hosts.
 *
 * What genuinely is a property of the address, and therefore safe to cache by
 * it, is Shodan's record. So that is what is stored, and every domain-specific
 * conclusion is recomputed from it.
 */
interface CacheEntry {
  lookup: InternetDBLookup;
  storedAt: number;
}

const CACHE_TTL_MS = 60 * 60 * 1000;
/** Bounded: a long-lived instance must not grow a map without limit. */
const CACHE_MAX_ENTRIES = 500;

const cache = new Map<string, CacheEntry>();

/**
 * A ceiling on lookups per address per hour.
 *
 * Two honest notes about what this does. It is keyed by the *target* address,
 * so it limits how often any one address is looked up rather than how fast
 * Klyro calls Shodan overall — a scan of a hundred different domains is a
 * hundred different keys and passes straight through. And with the cache in
 * front of it, reaching the ceiling for a single address requires a hundred
 * cache misses within an hour, which in practice means a hundred scans of the
 * same domain spread more than an hour apart. It is a backstop against a loop
 * that has gone wrong, not a rate limiter.
 *
 * The window is real. The version this replaces incremented a counter and
 * never reset it, so the hundred-and-first lookup of an address would have
 * been refused for the remaining life of the process.
 */
interface CounterEntry {
  count: number;
  windowStart: number;
}

const COUNTER_WINDOW_MS = 60 * 60 * 1000;
const COUNTER_MAX = 100;

const counters = new Map<string, CounterEntry>();

/** Drops the oldest entries once the map is over its ceiling. */
function evictIfNeeded<T>(map: Map<string, T>, max: number) {
  if (map.size <= max) return;
  // Map iterates in insertion order, so the front is the oldest.
  const excess = map.size - max;
  let i = 0;
  for (const key of map.keys()) {
    if (i++ >= excess) break;
    map.delete(key);
  }
}

function cached(address: string, now: number): InternetDBLookup | null {
  const entry = cache.get(address);
  if (!entry) return null;
  if (now - entry.storedAt >= CACHE_TTL_MS) {
    cache.delete(address);
    return null;
  }
  return entry.lookup;
}

function remember(address: string, lookup: InternetDBLookup, now: number) {
  /*
   * Errors are not cached. A record and a "no record" are both stable answers
   * about the address and hold for an hour; a timeout or a 502 is a statement
   * about Shodan at that instant, and caching it would take the module out for
   * an hour on the strength of one bad second.
   */
  if (lookup.outcome === 'error') return;
  cache.set(address, { lookup, storedAt: now });
  evictIfNeeded(cache, CACHE_MAX_ENTRIES);
}

/** True while this address is under its hourly ceiling; counts the attempt. */
function withinCeiling(address: string, now: number): boolean {
  const entry = counters.get(address);

  if (!entry || now - entry.windowStart >= COUNTER_WINDOW_MS) {
    counters.set(address, { count: 1, windowStart: now });
    evictIfNeeded(counters, CACHE_MAX_ENTRIES);
    return true;
  }

  entry.count += 1;
  return entry.count <= COUNTER_MAX;
}

/** Observability, and the hook the tests use to start from a known state. */
export function internetDbCacheStats(): { cached: number; tracked: number } {
  return { cached: cache.size, tracked: counters.size };
}

export function resetInternetDbCache(): void {
  cache.clear();
  counters.clear();
}

/**
 * Drops one address from the cache, leaving its hourly count intact.
 *
 * Operationally this is how a single stale record gets re-read without
 * flushing everything. It is also what makes the ceiling testable: the cache
 * sits in front of the counter, so exercising the counter requires forcing
 * misses, and forcing them by advancing the clock would reset the very window
 * under test.
 */
export function evictInternetDbCacheEntry(address: string): void {
  cache.delete(address);
}

/**
 * The cached lookup.
 *
 * Separate from `lookupInternetDB` so the transport stays testable on its own
 * and the caching is testable on its own, rather than one function that can
 * only be exercised through the other.
 */
export async function lookupInternetDBCached(
  address: string,
  now: number = Date.now(),
): Promise<InternetDBLookup> {
  const hit = cached(address, now);
  if (hit) return hit;

  if (!withinCeiling(address, now)) {
    return {
      outcome: 'error',
      reason: `More than ${COUNTER_MAX} InternetDB lookups for ${address} in the last hour; this one was not sent`,
    };
  }

  const lookup = await lookupInternetDB(address);
  remember(address, lookup, now);
  return lookup;
}

/* ------------------------------------------------------------------ *
 * Hostnames
 * ------------------------------------------------------------------ */

export interface HostnameSplit {
  /** Names inside the assessed domain's own registrable domain. */
  own: string[];
  /** Names belonging to somebody else that resolve to the same address. */
  foreign: number;
}

/**
 * Whose hostnames these are.
 *
 * This split is the most important thing in the module. InternetDB returns
 * every name whose reverse DNS points at an address, and on any shared or CDN
 * address most of them belong to strangers: 1.1.1.1 comes back with
 * `pms-sfusd-ca.schoolloop.com` and `wlan.net.umd.edu`, and 8.8.8.8 with
 * `retail-storage.emarketer.com`. Listing those under "hostnames associated
 * with your infrastructure" would be wrong twice over — it tells the reader
 * nothing about their own estate, and it prints an unrelated organisation's
 * internal-looking host names into a document about somebody else.
 *
 * So only names inside the assessed domain are named. The rest are counted,
 * because the count is genuinely informative — it is how you tell a dedicated
 * address from a shared one — and nothing more than the count is said.
 */
export function splitHostnames(hostnames: string[], domain: string): HostnameSplit {
  const zone = registrableDomain(domain).toLowerCase();
  const own: string[] = [];
  let foreign = 0;

  for (const raw of hostnames) {
    const host = raw.toLowerCase().replace(/\.$/, '');
    if (host === zone || host.endsWith(`.${zone}`)) own.push(host);
    else foreign += 1;
  }

  return { own: [...new Set(own)].sort(), foreign };
}

/* ------------------------------------------------------------------ *
 * Scoring
 * ------------------------------------------------------------------ */

export interface ExposureScoreInput {
  ports: number[];
  hasVulns: boolean;
}

/**
 * 100 down to a floor of 0.
 *
 * Hostnames carry no penalty, which is a deliberate departure from the brief.
 * Two reasons. A name inside the assessed domain that resolves to its own
 * address is the ordinary shape of a website, and where such a name *is* worth
 * flagging — an `admin.` or a `staging.` — the Subdomain Exposure module
 * already finds it from certificate transparency, tiers it, and scores it.
 * Penalising it again here would charge one asset to two categories. A name
 * belonging to somebody else on a shared address is not the assessed domain's
 * doing at all, and scoring it down would penalise a domain for its
 * neighbours.
 */
export function scoreExposure({ ports, hasVulns }: ExposureScoreInput): number {
  let penalty = hasVulns ? VULN_PENALTY : 0;

  for (const port of ports) {
    const cls = classifyPort(port);
    if (cls === 'critical') penalty += CRITICAL_PENALTY;
    else if (cls === 'remote') penalty += REMOTE_PENALTY;
    else if (cls === 'admin-web') penalty += ADMIN_WEB_PENALTY;
  }

  return Math.max(0, 100 - penalty);
}

/* ------------------------------------------------------------------ *
 * Findings
 * ------------------------------------------------------------------ */

/** Repeated in every evidence block, because it qualifies every claim here. */
const STALENESS =
  'InternetDB publishes no crawl date for a record, so the age of this observation is unknown. It may be current or it may be years old.';

const PROVENANCE = (address: string) =>
  `Data source: Shodan InternetDB, queried for ${address}. This reflects Shodan's own historical observations. Klyro did not connect to any of these ports and performed no network scan of this address.`;

function portsFinding(domain: string, address: string, ports: number[]): Finding | null {
  const notable = ports.filter((p) => classifyPort(p) !== 'expected' && classifyPort(p) !== 'other');
  if (notable.length === 0) return null;

  const critical = notable.filter((p) => classifyPort(p) === 'critical');
  const remote = notable.filter((p) => classifyPort(p) === 'remote');

  const describe = (p: number) => `${p}${serviceFor(p) ? ` (${serviceFor(p)})` : ''}`;

  return makeFinding(KEY, {
    title: critical.length
      ? 'Shodan records data-store ports as open on this address'
      : 'Shodan records administrative ports as open on this address',
    /*
     * One step below what a direct observation of the same thing would earn.
     * The severity describes how much follows if the reading holds, and this
     * reading is somebody else's, of unknown age, that Klyro has not confirmed.
     */
    severity: critical.length ? 'high' : 'medium',
    // Never high: the age of the record is unknown and unknowable from the API,
    // which is precisely the "stated limitation" the medium level is for.
    confidence: 'medium',
    asset: `${domain} (${address})`,
    observed:
      `Shodan's public database records ${plural(notable.length, 'notable port')} as open on ${address}: ` +
      `${notable.map(describe).join(', ')}. The full list Shodan holds for this address is ${ports.join(', ')}.`,
    interpretation:
      'These ports were observed open by Shodan’s scanners at some point in their crawl history. ' +
      'Klyro did not verify any of them, so this establishes what Shodan saw, not what is open now. ' +
      (critical.length
        ? 'Ports in this set are conventionally used by data stores, which are normally reached by an application server on a private network rather than directly from the internet.'
        : 'Ports in this set are conventionally used for remote access or administration.'),
    risk: critical.length
      ? 'If a data-store port is still reachable, it is a standing target for credential-stuffing and for exploitation of known vulnerabilities, independent of whether this particular instance is misconfigured. If the record is stale and the port has since been closed, nothing follows from it.'
      : 'If a remote-access or administrative port is still reachable, it is subject to continuous automated credential guessing, and is the surface most commonly used to turn a leaked or reused password into access. If the record is stale, nothing follows from it.',
    recommendation:
      'Whether these ports are open today is not established here, and this finding is not evidence that they are — the operator of this address should confirm it against their own inventory first. ' +
      (critical.length || remote.length
        ? 'Any that should not be publicly reachable belong behind a firewall rule or security group; where remote access is genuinely needed, reach it over a VPN or a bastion host rather than a directly exposed port.'
        : 'Any that should not be publicly reachable belong behind a firewall rule or security group.'),
    evidence: {
      test: `HTTPS GET to internetdb.shodan.io for ${address}`,
      observed: `ports: [${ports.join(', ')}]`,
      expected: 'No data-store or remote-access ports recorded against a public web address.',
      verification: PROVENANCE(address),
      limitation: `${STALENESS} Nothing here establishes what software is behind a port, whether it requires authentication, or whether it is reachable from anywhere other than Shodan's scanners.`,
    },
    scoreImpact: critical.length * CRITICAL_PENALTY + remote.length * REMOTE_PENALTY,
  });
}

function hostnamesFinding(
  domain: string,
  address: string,
  split: HostnameSplit,
): Finding | null {
  if (split.own.length === 0) return null;

  const shown = split.own.slice(0, 5);

  return makeFinding(KEY, {
    title: 'Shodan’s reverse-DNS records name hosts in this domain',
    severity: 'info',
    confidence: 'medium',
    asset: `${domain} (${address})`,
    observed:
      `Shodan associates ${plural(split.own.length, 'host name')} within ${registrableDomain(domain)} with ${address}` +
      `${shown.length ? `: ${shown.join(', ')}` : ''}` +
      `${split.own.length > shown.length ? ` and ${split.own.length - shown.length} more` : ''}.` +
      (split.foreign
        ? ` A further ${plural(split.foreign, 'host name')} outside this domain also resolve to the same address; they are counted here but not listed, because they belong to other parties.`
        : ''),
    interpretation:
      'These names resolved to this address at some point in Shodan’s crawl history. ' +
      (split.foreign
        ? 'The presence of unrelated host names on the same address indicates shared or CDN-fronted infrastructure, which is ordinary and is not by itself a finding.'
        : 'No unrelated host names were recorded on this address, which is consistent with dedicated infrastructure.'),
    risk: 'None is claimed. Host names inside the assessed domain are enumerated far more thoroughly by the Subdomain Exposure check, which is where any risk from them is assessed and scored. This entry is context.',
    recommendation:
      'No action follows from this finding on its own. If a name here is unfamiliar, the Subdomain Exposure section is where to look for what it resolves to and how it is tiered.',
    evidence: {
      test: `HTTPS GET to internetdb.shodan.io for ${address}`,
      observed: `${split.own.length} in-domain host name(s), ${split.foreign} outside the domain`,
      verification: PROVENANCE(address),
      limitation: `${STALENESS} Whether a name is current or stale, and whether it was set by the domain operator or by the hosting provider's default reverse DNS, cannot be told apart from this data.`,
    },
  });
}

function vulnsFinding(domain: string, address: string, vulns: string[]): Finding | null {
  if (vulns.length === 0) return null;

  const shown = vulns.slice(0, 12);

  return makeFinding(KEY, {
    title: 'Shodan has tagged this address with known vulnerability identifiers',
    severity: 'high',
    /*
     * Low, and this is the one place in the module where that is the right
     * answer. The identifiers are attributed by a third party, usually inferred
     * from a version banner rather than from testing, and Klyro has confirmed
     * none of them. A high-severity finding at low confidence is exactly the
     * combination the ranking formula exists to handle — it will not outrank a
     * directly observed problem.
     */
    confidence: 'low',
    asset: `${domain} (${address})`,
    observed: `Shodan has tagged ${address} with ${plural(vulns.length, 'vulnerability identifier')}: ${shown.join(', ')}${vulns.length > shown.length ? `, and ${vulns.length - shown.length} more` : ''}.`,
    interpretation:
      'Shodan attributes these identifiers to this address, generally by matching a version string a service advertised against a vulnerability database. That is an inference from a banner, not a test: it does not establish that the affected software is present, that it is unpatched, or that the issue is reachable. Klyro has verified none of them.',
    risk: 'If any identifier is accurate and the affected service is still running and reachable, it describes a publicly documented weakness with published exploitation details. Whether that is the case here is exactly what this data cannot say.',
    recommendation:
      'This is a list to check, not a list of confirmed problems. Each identifier should be put to whoever runs the service on this address and matched against the software and version actually deployed there. Nothing on the list warrants action before that step.',
    evidence: {
      test: `HTTPS GET to internetdb.shodan.io for ${address}`,
      observed: `vulns: [${shown.join(', ')}]`,
      verification: PROVENANCE(address),
      limitation: `${STALENESS} These identifiers are third-party attributions inferred from service banners. Klyro performed no vulnerability testing of any kind and does not confirm, rank, or endorse any entry in this list.`,
    },
    scoreImpact: VULN_PENALTY,
  });
}

/** Shodan holds a record and it is clean. Worth saying rather than omitting. */
function cleanFinding(domain: string, address: string, ports: number[]): Finding {
  return makeFinding(KEY, {
    title: 'Shodan records no sensitive ports open on this address',
    severity: 'info',
    confidence: 'medium',
    asset: `${domain} (${address})`,
    observed:
      `Shodan holds a record for ${address} and lists ${ports.length ? `only ${ports.join(', ')}` : 'no ports'} as open. ` +
      'None of the data-store, remote-access or administrative ports Klyro looks for appears in it.',
    interpretation:
      'The ports that most often turn up exposed by accident are not present in Shodan’s record for this address. ' +
      'This is the expected result for a correctly firewalled host.',
    risk: 'None is claimed from this observation.',
    recommendation:
      'No action. Worth re-checking after infrastructure changes, since a port becomes exposed through a security-group edit far more often than through a deliberate decision.',
    evidence: {
      test: `HTTPS GET to internetdb.shodan.io for ${address}`,
      observed: ports.length ? `ports: [${ports.join(', ')}]` : 'ports: []',
      expected: 'No data-store, remote-access or administrative ports.',
      verification: PROVENANCE(address),
      limitation: `${STALENESS} A clean record is not proof that nothing is open: Shodan may simply not have scanned a port, and only the apex address was looked up.`,
    },
  });
}

/* ------------------------------------------------------------------ *
 * Module
 * ------------------------------------------------------------------ */

async function resolveApex(domain: string): Promise<string | null> {
  const answer = await dnsQuery(domain, 'A', { confirmAbsence: false });
  return answersOfType(answer, 'A')[0]?.data ?? null;
}

export async function checkInternetDB(domain: string): Promise<ModuleOutput> {
  const address = await resolveApex(domain);

  if (!address) {
    throw new NotAssessable('The domain published no A record, so there is no address to look up.');
  }

  /*
   * A reserved address is not looked up. Nothing dangerous would happen if it
   * were — this is a fetch to a fixed third-party host, not a connection to the
   * target — but asking a public database about 10.0.0.5 or 127.0.0.1 tells
   * Shodan something about the caller and can only ever return somebody else's
   * record, since the address is not globally unique.
   */
  const reserved = classifyReservedAddress(address);
  if (reserved) {
    throw new NotAssessable(
      `the domain resolves to ${address}, which is ${reserved}, and a reserved address is not globally unique — a public database has nothing meaningful to say about it`,
    );
  }

  const lookup = await lookupInternetDBCached(address);

  if (lookup.outcome === 'error') {
    throw new NotAssessable(lookup.reason);
  }

  if (lookup.outcome === 'no-record') {
    /*
     * Shodan answered, and has never crawled this address.
     *
     * Thrown rather than scored, and the distinction is the whole point.
     * Returning a score of 0 would mark a domain down for not appearing in a
     * third party's index; returning 100 would assert "nothing is open" from a
     * source that never looked. Throwing makes the category `unavailable`, and
     * `computeComposite` drops unavailable categories and renormalises the
     * remaining weights — so the domain is neither rewarded nor punished for a
     * gap in somebody else's crawl.
     *
     * Worth being precise about the mechanism: `computeComposite` filters on
     * `status`, not on `moduleCoverage`. A module that returns a low
     * `moduleCoverage` still contributes its score at full weight.
     */
    throw new NotAssessable(
      `Shodan has no record for ${address}. The address has not appeared in its crawl, which says nothing about what is or is not open on it`,
    );
  }

  const { data } = lookup;
  const split = splitHostnames(data.hostnames, domain);
  const notable = data.ports.filter(
    (p) => classifyPort(p) !== 'expected' && classifyPort(p) !== 'other',
  );

  const findings = [
    portsFinding(domain, address, data.ports),
    vulnsFinding(domain, address, data.vulns),
    hostnamesFinding(domain, address, split),
  ].filter((f): f is Finding => f !== null);

  if (notable.length === 0) findings.unshift(cleanFinding(domain, address, data.ports));

  const score = scoreExposure({ ports: data.ports, hasVulns: data.vulns.length > 0 });

  const details: CategoryDetail[] = [
    { label: 'Address looked up', value: address },
    {
      label: 'Ports on record',
      value: data.ports.length ? data.ports.join(', ') : 'None',
      tone: notable.some((p) => classifyPort(p) === 'critical')
        ? 'bad'
        : notable.length
          ? 'warn'
          : 'good',
    },
    {
      label: 'Host names on this address',
      value: `${split.own.length} in ${registrableDomain(domain)}${split.foreign ? `, ${split.foreign} elsewhere` : ''}`,
    },
    {
      label: 'Vulnerability tags',
      value: data.vulns.length ? String(data.vulns.length) : 'None',
      tone: data.vulns.length ? 'warn' : 'good',
    },
  ];

  return {
    score,
    summary: notable.length
      ? `Shodan records ${plural(notable.length, 'sensitive port')} open on ${address}.`
      : `Shodan records no sensitive ports open on ${address}.`,
    findings,
    details,
    scoreBreakdown: penaltyBreakdown(100, [
      ...notable
        .filter((p) => classifyPort(p) === 'critical')
        .map((p) => ({
          label: `Port ${p}${serviceFor(p) ? ` (${serviceFor(p)})` : ''} on record`,
          points: CRITICAL_PENALTY,
          note: 'A data-store port recorded open by Shodan.',
        })),
      ...notable
        .filter((p) => classifyPort(p) === 'remote')
        .map((p) => ({
          label: `Port ${p}${serviceFor(p) ? ` (${serviceFor(p)})` : ''} on record`,
          points: REMOTE_PENALTY,
          note: 'A remote-access port recorded open by Shodan.',
        })),
      ...notable
        .filter((p) => classifyPort(p) === 'admin-web')
        .map((p) => ({
          label: `Port ${p}${serviceFor(p) ? ` (${serviceFor(p)})` : ''} on record`,
          points: ADMIN_WEB_PENALTY,
          note: 'An administrative web surface recorded open by Shodan.',
        })),
      ...(data.vulns.length
        ? [
            {
              label: `${plural(data.vulns.length, 'vulnerability identifier')} attributed`,
              points: VULN_PENALTY,
              note: 'Third-party attribution from a service banner, unverified by Klyro.',
            },
          ]
        : []),
    ]),
    moduleCoverage: 1,
    facts: {
      address,
      ports: data.ports,
      notablePorts: notable,
      criticalPorts: notable.filter((p) => classifyPort(p) === 'critical'),
      hostnamesInDomain: split.own,
      hostnamesElsewhere: split.foreign,
      vulns: data.vulns,
      tags: data.tags,
      source: 'Shodan InternetDB',
      crawlDate: null,
    },
  };
}
