/**
 * What Klyro is allowed to point itself at.
 *
 * Klyro takes a host name from an anonymous visitor and makes server-side
 * requests to it. That is a server-side request forgery primitive unless it is
 * constrained: a visitor who controls a DNS record can aim the scanner at the
 * cloud metadata endpoint, at a service on the loopback interface, or at
 * anything else reachable from wherever Klyro runs but not from the visitor.
 *
 * `parseDomain()` already rejects IP literals and names with no dot, which
 * stops `127.0.0.1` and `localhost`. It does not stop `internal.example.com`
 * with an A record of `10.0.0.5`, because that is a perfectly well-formed
 * public domain name. Three layers close the rest:
 *
 * 1. `screenName()` rejects the special-use and private-use suffixes outright.
 *    No DNS, so it costs nothing and runs first.
 * 2. `screenTarget()` resolves the name and refuses if any address it returns
 *    is in a reserved range. This catches a domain deliberately pointed
 *    inward.
 * 3. `guardedDispatcher` validates every address again at TCP connect time,
 *    for every request and every redirect hop. This is the layer that matters:
 *    the other two check a name at one moment, and a record whose TTL is one
 *    second can answer publicly for the check and privately for the request.
 */

import dns from 'node:dns';
import type net from 'node:net';

import { Agent } from 'undici';

/* ------------------------------------------------------------------ *
 * Name screening
 * ------------------------------------------------------------------ */

/**
 * Suffixes reserved by RFC 6761, RFC 8375 and RFC 9476, plus the private-use
 * suffixes that appear on corporate networks. A name under any of these either
 * cannot be registered publicly or resolves differently inside a network than
 * outside it, so a scan of one is either meaningless or an attempt to reach
 * something the visitor cannot reach themselves.
 */
const PRIVATE_NETWORK =
  'is a reserved suffix that only resolves inside a private network, so there is nothing here Klyro could assess from the public internet';
const NOT_A_REAL_HOST =
  'is a suffix reserved for documentation and testing, so it never belongs to a host anyone operates';
const NOT_REACHABLE =
  'belongs to an overlay network that is not reachable over ordinary DNS, so Klyro cannot assess it';
const INFRASTRUCTURE =
  'is DNS infrastructure rather than a host anyone operates, so there is nothing here to assess';

const RESERVED_SUFFIXES = new Map<string, string>([
  ['local', PRIVATE_NETWORK],
  ['localhost', PRIVATE_NETWORK],
  ['localdomain', PRIVATE_NETWORK],
  ['internal', PRIVATE_NETWORK],
  ['intranet', PRIVATE_NETWORK],
  ['private', PRIVATE_NETWORK],
  ['lan', PRIVATE_NETWORK],
  ['home', PRIVATE_NETWORK],
  ['home.arpa', PRIVATE_NETWORK],
  ['corp', PRIVATE_NETWORK],
  ['domain', PRIVATE_NETWORK],
  ['host', PRIVATE_NETWORK],
  ['test', NOT_A_REAL_HOST],
  ['example', NOT_A_REAL_HOST],
  ['invalid', NOT_A_REAL_HOST],
  ['onion', NOT_REACHABLE],
  ['i2p', NOT_REACHABLE],
  ['alt', NOT_REACHABLE],
  ['arpa', INFRASTRUCTURE],
]);

export interface Screening {
  ok: boolean;
  error?: string;
}

/** Suffix check only — no DNS, safe to call from the browser or a form. */
export function screenName(domain: string): Screening {
  const host = domain.toLowerCase().replace(/\.$/, '');
  const labels = host.split('.');

  for (let i = 0; i < labels.length; i += 1) {
    const suffix = labels.slice(i).join('.');
    const reason = RESERVED_SUFFIXES.get(suffix);
    if (reason) {
      return { ok: false, error: `“${suffix}” ${reason}.` };
    }
  }

  return { ok: true };
}

/* ------------------------------------------------------------------ *
 * Address ranges
 * ------------------------------------------------------------------ */

interface Range {
  /** First address as a 32-bit unsigned integer. */
  base: number;
  bits: number;
  label: string;
}

function ipv4ToInt(address: string): number | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;

  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value >>> 0;
}

function range(cidr: string, label: string): Range {
  const [address, prefix] = cidr.split('/');
  return { base: ipv4ToInt(address) ?? 0, bits: Number(prefix), label };
}

/** Everything IANA has reserved. A public web host sits in none of them. */
const RESERVED_V4: Range[] = [
  range('0.0.0.0/8', 'this network'),
  range('10.0.0.0/8', 'private use'),
  range('100.64.0.0/10', 'carrier-grade NAT'),
  range('127.0.0.0/8', 'loopback'),
  range('169.254.0.0/16', 'link-local, including cloud metadata'),
  range('172.16.0.0/12', 'private use'),
  range('192.0.0.0/24', 'IETF protocol assignments'),
  range('192.0.2.0/24', 'documentation'),
  range('192.88.99.0/24', '6to4 relay anycast'),
  range('192.168.0.0/16', 'private use'),
  range('198.18.0.0/15', 'benchmarking'),
  range('198.51.100.0/24', 'documentation'),
  range('203.0.113.0/24', 'documentation'),
  range('224.0.0.0/4', 'multicast'),
  range('240.0.0.0/4', 'reserved'),
];

function classifyIpv4(address: string): string | null {
  const value = ipv4ToInt(address);
  if (value === null) return null;

  for (const entry of RESERVED_V4) {
    const mask = entry.bits === 0 ? 0 : (0xffffffff << (32 - entry.bits)) >>> 0;
    if ((value & mask) >>> 0 === (entry.base & mask) >>> 0) return entry.label;
  }
  return null;
}

function classifyIpv6(address: string): string | null {
  const a = address.toLowerCase().split('%')[0];

  if (a === '::' || a === '::1') return 'loopback or unspecified';
  // IPv4-mapped and IPv4-compatible forms carry a v4 address inside them, and
  // reach exactly the same host — so they get the same treatment.
  const mapped = /^::(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/.exec(a);
  if (mapped) return classifyIpv4(mapped[1]) ?? null;

  if (/^f[cd][0-9a-f]{2}:/.test(a)) return 'unique local address';
  if (/^fe[89ab][0-9a-f]:/.test(a)) return 'link-local';
  if (/^ff[0-9a-f]{2}:/.test(a)) return 'multicast';
  if (a.startsWith('2001:db8:')) return 'documentation';
  if (a.startsWith('64:ff9b:')) return 'NAT64 translation';

  return null;
}

/** Returns the reason an address is off-limits, or null if it is routable. */
export function classifyReservedAddress(address: string): string | null {
  return address.includes(':') ? classifyIpv6(address) : classifyIpv4(address);
}

/* ------------------------------------------------------------------ *
 * Connect-time enforcement
 * ------------------------------------------------------------------ */

/**
 * A dispatcher whose DNS lookup refuses reserved addresses.
 *
 * This is the layer that actually holds. `screenTarget()` resolves a name once
 * before the scan begins; this runs on every connection the scan makes,
 * including every redirect hop, so a record that answers publicly for the
 * pre-flight check and privately a moment later still cannot be reached.
 *
 * The error surfaces through `safeFetch`'s existing catch, so a blocked host
 * looks to a check module exactly like an unreachable one — which is the
 * correct outcome. Nothing is scored from it either way.
 */
type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address?: string | { address: string; family: number }[],
  family?: number,
) => void;

/**
 * A drop-in replacement for `dns.lookup` that removes reserved addresses from
 * the answer and fails the connection outright if nothing routable is left.
 *
 * Exported so the TLS probe — which opens a socket directly rather than
 * through fetch — gets the same enforcement at the same point.
 *
 * Typed loosely because Node's `LookupFunction` and undici's expected shape
 * describe the same callback with incompatible option types; the runtime
 * contract is identical and is what both callers rely on.
 */
export const guardedLookup = ((
  hostname: string,
  options: dns.LookupOptions,
  callback: LookupCallback,
): void => {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);

    const list = Array.isArray(addresses) ? addresses : [];
    const allowed = list.filter((entry) => !classifyReservedAddress(entry.address));

    if (allowed.length === 0) {
      const reason = list.length
        ? (classifyReservedAddress(list[0].address) ?? 'a reserved range')
        : 'no address';
      const blocked: NodeJS.ErrnoException = new Error(
        `Refusing to connect to ${hostname}: resolves to ${reason}`,
      );
      blocked.code = 'EKLYROBLOCKED';
      return callback(blocked);
    }

    callback(null, allowed, allowed[0].family);
  });
}) as unknown as net.LookupFunction;

export const guardedDispatcher = new Agent({ connect: { lookup: guardedLookup } });

/* ------------------------------------------------------------------ *
 * Pre-flight
 * ------------------------------------------------------------------ */

export interface TargetVerdict {
  ok: boolean;
  error?: string;
  /** Addresses observed during screening, for the scan's own record. */
  addresses: string[];
}

/**
 * Resolves the target and refuses it if any address is reserved.
 *
 * Deliberately fails *open* when nothing resolves. A name that does not
 * resolve cannot be connected to, so there is nothing to protect against, and
 * refusing would turn every transient resolver failure into a rejected scan.
 * The connect-time guard above is what covers the case where resolution
 * changes between this check and the request.
 *
 * Refuses if *any* address is reserved rather than all of them: a legitimate
 * public host has no reason to publish a private address, and a mixed answer
 * is the shape of a deliberate attempt to get one past the check.
 */
/**
 * The DNS interface both pre-flight checks take, so tests can drive them.
 *
 * `status` is the RCODE. It is the field that separates "this name does not
 * exist" (3, NXDOMAIN) from "this name exists and has no record of that type"
 * (0 with an empty answer), and those two are not the same question.
 */
export type Resolver = (
  name: string,
  type: string,
) => Promise<{
  resolved: boolean;
  /**
   * Optional because `screenTarget` has no use for it — it cares only about
   * the addresses. A resolver that omits it cannot be used to assert that a
   * name is missing, which is the safe direction: pre-flight then fails open
   * and the scan proceeds.
   */
  status?: number | null;
  answers: { data: string; type: number }[];
}>;

export async function screenTarget(
  domain: string,
  resolve: Resolver,
): Promise<TargetVerdict> {
  const named = screenName(domain);
  if (!named.ok) return { ok: false, error: named.error, addresses: [] };

  const [a, aaaa] = await Promise.all([resolve(domain, 'A'), resolve(domain, 'AAAA')]);

  const addresses = [
    ...a.answers.filter((r) => r.type === 1).map((r) => r.data),
    ...aaaa.answers.filter((r) => r.type === 28).map((r) => r.data),
  ];

  for (const address of addresses) {
    const reason = classifyReservedAddress(address);
    if (reason) {
      return {
        ok: false,
        addresses,
        error: `${domain} resolves to ${address}, which is ${reason}. Klyro assesses hosts on the public internet; scanning an address that is only reachable from inside a network would report on infrastructure the person running the scan may have no right to probe.`,
      };
    }
  }

  return { ok: true, addresses };
}

/* ------------------------------------------------------------------ *
 * Existence
 *
 * Separate from the screening above, and answering a different question.
 * `screenTarget` asks "may Klyro connect to this?"; this asks "is there
 * anything here at all?" A name with no address is not a security problem —
 * it is a typo, and it deserves to be told apart from one in under two
 * seconds rather than after eleven modules have each failed to reach it.
 * ------------------------------------------------------------------ */

/**
 * Second-level labels that are part of a public suffix rather than part of
 * somebody's name. `X.co.ae` is a registered name; swapping its `.ae` for
 * `.com` would produce `X.co.com`, which is nonsense.
 */
const AE_SECOND_LEVEL = new Set(['ac', 'co', 'gov', 'org', 'net', 'sch', 'mil']);

/** At most this many variants are probed, so a typo cannot cost a long wait. */
const MAX_VARIANT_PROBES = 3;

/**
 * Plausible corrections for a name that does not resolve.
 *
 * Scoped deliberately narrowly to the confusion that actually came up in
 * testing — `.ae` against `.com` — rather than attempting general spelling
 * correction. A wrong suggestion is worse than none: it invites the reader to
 * assess a domain they did not mean and may not have any relationship with.
 * Every candidate is confirmed to resolve before it is offered.
 */
export function variantsFor(domain: string): string[] {
  const host = domain.toLowerCase().replace(/\.$/, '');
  const labels = host.split('.');
  const out: string[] = [];

  const add = (candidate: string) => {
    if (candidate !== host && !out.includes(candidate)) out.push(candidate);
  };

  if (host.endsWith('.ac.ae')) {
    // fad.ac.ae → fad.ae. Universities in the UAE sit under both.
    add(`${host.slice(0, -'.ac.ae'.length)}.ae`);
  }

  if (host.endsWith('.ae')) {
    const secondLevel = labels.length >= 3 ? labels[labels.length - 2] : null;
    // Only when `.ae` is the whole suffix — never turn `X.co.ae` into `X.co.com`.
    if (!secondLevel || !AE_SECOND_LEVEL.has(secondLevel)) {
      add(`${host.slice(0, -'.ae'.length)}.com`);
    }
  }

  if (host.endsWith('.com')) {
    add(`${host.slice(0, -'.com'.length)}.ae`);
  }

  return out.slice(0, MAX_VARIANT_PROBES);
}

/** RCODE 3. The name itself is not in the DNS. */
const NXDOMAIN = 3;

export interface PreflightResult {
  /**
   * Whether the *name* exists, which is not the same as whether it has an
   * address. A domain that answers NOERROR with no records — no apex A, mail
   * and subdomains only — exists, and refusing to assess it would be wrong.
   */
  exists: boolean;
  hasARecord: boolean;
  hasAAAARecord: boolean;
  /** A name that does resolve, when one of the variants did. */
  suggestion?: string;
}

/**
 * Does this domain exist?
 *
 * `knownAddresses` lets the caller hand over what it has already resolved —
 * the scan route runs `screenTarget` first, which queries exactly these two
 * record types, so passing its answer through means an existing domain adds no
 * DNS work and no latency to the normal path. Only a name that resolves to
 * nothing pays for the variant probes, which is the correct place for that
 * cost to fall.
 *
 * Absence here is a much weaker claim than the DNS module makes elsewhere: it
 * is one lookup, not a confirmed absence across two resolvers. That is
 * deliberate. The consequence of being wrong is a refused scan the reader can
 * immediately retry, not a finding published about a domain.
 */
export async function preflightDomainCheck(
  domain: string,
  resolve: Resolver,
  knownAddresses?: string[],
): Promise<PreflightResult> {
  /*
   * An address already in hand settles it, and settles it for free. This is
   * the path almost every real scan takes, so it must add no DNS work.
   */
  if (knownAddresses && knownAddresses.length > 0) {
    return {
      exists: true,
      hasARecord: knownAddresses.some((a) => !a.includes(':')),
      hasAAAARecord: knownAddresses.some((a) => a.includes(':')),
    };
  }

  /*
   * No address. That is where the two cases that look identical part company,
   * and the distinction is the whole correctness of this check:
   *
   *   emiratesnbd.ae  → NOERROR, zero answers. The zone is delegated and the
   *                     name exists; it simply publishes nothing at the apex.
   *                     A real domain, and blocking it would be a far worse
   *                     bug than the confusing report this check exists to
   *                     prevent.
   *   fad.ac.ae       → NXDOMAIN. The name is not registered at all.
   *
   * Keying off "has an A record" cannot tell those apart. The RCODE can, so
   * that is what decides it. Absence is only claimed when *both* families say
   * NXDOMAIN — a single resolver hiccup on one of them is not enough to refuse
   * somebody's scan.
   */
  const [a, aaaa] = await Promise.allSettled([resolve(domain, 'A'), resolve(domain, 'AAAA')]);

  const hasARecord = a.status === 'fulfilled' && a.value.answers.some((r) => r.type === 1);
  const hasAAAARecord = aaaa.status === 'fulfilled' && aaaa.value.answers.some((r) => r.type === 28);

  const saysMissing = (r: PromiseSettledResult<Awaited<ReturnType<Resolver>>>) =>
    r.status === 'fulfilled' && r.value.status === NXDOMAIN;

  // Fails open: a resolver that did not answer at all leaves `status` null,
  // which is not NXDOMAIN, so the scan proceeds rather than being refused on
  // the strength of a network blip.
  const exists = !(saysMissing(a) && saysMissing(aaaa));

  if (exists) return { exists, hasARecord, hasAAAARecord };

  for (const candidate of variantsFor(domain)) {
    // A suggestion still has to be a name Klyro would agree to scan.
    if (!screenName(candidate).ok) continue;

    const probe = await Promise.allSettled([resolve(candidate, 'A')]);
    const resolves =
      probe[0].status === 'fulfilled' && probe[0].value.answers.some((r) => r.type === 1);

    if (resolves) return { exists, hasARecord, hasAAAARecord, suggestion: candidate };
  }

  return { exists, hasARecord, hasAAAARecord };
}
