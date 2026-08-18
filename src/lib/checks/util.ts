import { CHECK_TIMEOUT_MS, TOOL_VERSION } from '../constants';
import { SCANNER_INFO_URL } from '../site';
import type {
  CategoryDetail,
  CategoryKey,
  CategoryPayload,
  CategoryResult,
  Confidence,
  Finding,
  FindingEvidence,
  ScoreLine,
  Severity,
} from '../types';
import { CATEGORY_LABELS } from '../constants';
import { clampScore } from '../scoring';
import { classifyReservedAddress, guardedDispatcher } from '../target';

/**
 * How Klyro identifies itself to every host it contacts.
 *
 * The `+URL` is the part that matters. An operator who sees an unfamiliar
 * client in their logs follows it, and it has to lead to a page that says who
 * is asking, what was requested and how to stop it — which is why the origin
 * is read from the deployment rather than hardcoded.
 */
export const USER_AGENT = `Mozilla/5.0 (compatible; KlyroExposureScanner/${TOOL_VERSION}; +${SCANNER_INFO_URL})`;

/**
 * How many redirects a check will follow.
 *
 * The default is 20, which is a lot of hops to hand to a host chosen by an
 * anonymous visitor. Every hop is re-checked by the guarded dispatcher, so the
 * ceiling is about budget rather than safety — but a chain this long is a
 * broken site, not a site worth measuring.
 */
const MAX_REDIRECTS = 5;

/**
 * Whether a URL is somewhere Klyro is willing to send a request.
 *
 * The dispatcher's guarded lookup covers host *names*, because a name has to be
 * resolved before a socket can be opened. It does not fire at all for an IP
 * literal — undici skips DNS entirely in that case — so `http://169.254.169.254/`
 * sails straight through it. That gap is only reachable through a redirect,
 * since `parseDomain` rejects IP literals as scan targets, but a redirect is
 * exactly what an attacker-controlled site would use.
 *
 * Verified by hand: with the dispatcher alone, `http://localhost:PORT/` is
 * refused with EKLYROBLOCKED and `http://127.0.0.1:PORT/` returns the body.
 */
function blockedReason(url: URL): string | null {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return `unsupported scheme ${url.protocol}`;
  }

  const host = url.hostname.replace(/^\[/, '').replace(/\]$/, '');
  const isLiteral = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
  if (!isLiteral) return null;

  return classifyReservedAddress(host);
}

/** 303 always becomes GET; 301 and 302 do in practice for anything but GET/HEAD. */
function methodAfterRedirect(status: number, method: string): string {
  if (status === 303) return 'GET';
  if ((status === 301 || status === 302) && method !== 'GET' && method !== 'HEAD') return 'GET';
  return method;
}

/**
 * Fetch with a hard deadline, a dispatcher that refuses reserved addresses, and
 * redirects followed one hop at a time so every hop can be checked.
 *
 * Redirect following is done here rather than handed to undici because undici
 * follows the chain internally and never shows us the intermediate URLs. A
 * scanned site that answers `302 Location: http://10.0.0.1/` would otherwise be
 * followed without anything getting a look at where it pointed.
 *
 * Never throws for network errors — returns null. A blocked host therefore
 * looks identical to an unreachable one, which is the correct outcome: nothing
 * is concluded from it and nothing is scored.
 */
export async function safeFetch(
  url: string,
  init: RequestInit = {},
  timeoutMs: number = CHECK_TIMEOUT_MS,
): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const follow = (init.redirect ?? 'follow') === 'follow';
  let method = (init.method ?? 'GET').toUpperCase();
  let current: URL;

  try {
    current = new URL(url);
  } catch {
    clearTimeout(timer);
    return null;
  }

  try {
    for (let hop = 0; ; hop += 1) {
      if (blockedReason(current)) return null;

      const response = await fetch(current.href, {
        ...init,
        method,
        // Every hop is inspected here, so undici must not follow any itself.
        redirect: 'manual',
        signal: controller.signal,
        cache: 'no-store',
        headers: {
          'user-agent': USER_AGENT,
          accept: '*/*',
          ...(init.headers ?? {}),
        },
        // `dispatcher` and `maxRedirections` are undici options that Node's
        // fetch accepts but the DOM RequestInit type does not describe.
        ...({ dispatcher: guardedDispatcher, maxRedirections: 0 } as Record<string, unknown>),
      });

      const location = response.headers.get('location');
      const isRedirect = response.status >= 300 && response.status < 400 && location;

      // Each hop is a separate request, so `response.url` is already the URL
      // this hop was sent to — which is what callers use to tell a real
      // resource from a bounce to the homepage.
      if (!follow || !isRedirect || hop >= MAX_REDIRECTS) return response;

      let next: URL;
      try {
        next = new URL(location, current.href);
      } catch {
        return response;
      }

      // Nothing further will read this body; releasing it keeps the connection
      // from being held open for the rest of the scan.
      await response.body?.cancel().catch(() => undefined);

      method = methodAfterRedirect(response.status, method);
      current = next;
    }
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchJson<T>(
  url: string,
  init: RequestInit = {},
  timeoutMs: number = CHECK_TIMEOUT_MS,
): Promise<T | null> {
  const res = await safeFetch(url, init, timeoutMs);
  if (!res || !res.ok) return null;
  try {
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export async function fetchText(
  url: string,
  init: RequestInit = {},
  timeoutMs: number = CHECK_TIMEOUT_MS,
): Promise<{ status: number; text: string; headers: Headers } | null> {
  const res = await safeFetch(url, init, timeoutMs);
  if (!res) return null;
  try {
    const text = await res.text();
    return { status: res.status, text, headers: res.headers };
  } catch {
    return { status: res.status, text: '', headers: res.headers };
  }
}

/* ------------------------------------------------------------------ *
 * DNS over HTTPS
 *
 * Two rules govern this layer, both learned the hard way:
 *
 * 1. A lookup that *failed* is not a record that is *absent*. The two used to
 *    be indistinguishable — every transport error collapsed to `null`, and a
 *    rate-limited DMARC query became "No DMARC policy published" at critical
 *    severity. A `DnsResult` now says which of the two happened, and callers
 *    are expected to treat `resolved: false` as unknown.
 *
 * 2. One resolver is not a source of truth. Every DNS-derived fact in the
 *    product used to come from a single provider that rate-limits per IP —
 *    and on serverless that IP is shared across every customer. Queries are
 *    spread across providers, and absence is confirmed against a second
 *    resolver before it is reported, so a stale negative cache at one provider
 *    cannot manufacture a finding.
 * ------------------------------------------------------------------ */

export interface DnsAnswer {
  name: string;
  type: number;
  TTL: number;
  data: string;
}

/** Raw DoH JSON, as returned by every resolver below. */
interface DnsResponse {
  Status: number;
  /** Authenticated Data — the resolver validated a DNSSEC chain. */
  AD?: boolean;
  Answer?: DnsAnswer[];
  Authority?: DnsAnswer[];
  Comment?: string;
}

export interface DnsResult {
  /**
   * True when at least one resolver gave a real DNS answer — including an
   * authoritative "this does not exist". False means the question could not be
   * put to anyone, and nothing may be concluded from it.
   */
  resolved: boolean;
  /** DNS RCODE: 0 NOERROR, 3 NXDOMAIN. Null when unresolved. */
  status: number | null;
  /** The resolver validated a DNSSEC chain for this answer. */
  ad: boolean;
  answers: DnsAnswer[];
  /** Resolvers that answered, in the order they were consulted. */
  resolvers: string[];
  /** Present only when `resolved` is false. */
  reason?: string;
}

export const DNS_TYPE_CODES: Record<string, number> = {
  A: 1,
  NS: 2,
  CNAME: 5,
  SOA: 6,
  PTR: 12,
  MX: 15,
  TXT: 16,
  AAAA: 28,
  DS: 43,
  DNSKEY: 48,
  CAA: 257,
};

interface Resolver {
  name: string;
  build: (name: string, type: string, dnssec: boolean) => string;
}

/**
 * Two independent operators, both on 443 with a JSON API.
 *
 * Quad9 was a candidate but publishes its JSON endpoint on port 5053, which is
 * filtered on plenty of hosts — including this one. A resolver that usually
 * fails is worse than no third resolver: every rotation into it burns the full
 * per-attempt budget before falling through, and the module hits its own
 * deadline. Add a third only if it answers on 443.
 */
const RESOLVERS: Resolver[] = [
  {
    name: 'Google',
    build: (n, t, d) =>
      `https://dns.google/resolve?name=${encodeURIComponent(n)}&type=${t}${d ? '&do=1' : ''}`,
  },
  {
    name: 'Cloudflare',
    build: (n, t, d) =>
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(n)}&type=${t}${d ? '&do=true' : ''}`,
  },
];

/**
 * Per-attempt budget. Deliberately short: a query that falls through to the
 * second resolver must still leave the module inside its own deadline.
 */
const RESOLVER_TIMEOUT_MS = 5_000;

/** Rotates which provider is asked first, so no single one carries every scan. */
let resolverCursor = 0;

function resolverOrder(): Resolver[] {
  const start = resolverCursor++ % RESOLVERS.length;
  return [...RESOLVERS.slice(start), ...RESOLVERS.slice(0, start)];
}

async function askResolver(
  resolver: Resolver,
  name: string,
  type: string,
  dnssec: boolean,
): Promise<DnsResponse | null> {
  return fetchJson<DnsResponse>(
    resolver.build(name, type, dnssec),
    { headers: { accept: 'application/dns-json' } },
    RESOLVER_TIMEOUT_MS,
  );
}

function toResult(res: DnsResponse, resolvers: string[]): DnsResult {
  return {
    resolved: true,
    status: res.Status,
    ad: res.AD === true,
    answers: res.Answer ?? [],
    resolvers,
  };
}

export async function dnsQuery(
  name: string,
  type: string,
  opts: {
    dnssec?: boolean;
    /**
     * Confirm an empty or NXDOMAIN answer against a second resolver before
     * reporting it. On by default. Turn it off for bulk lookups whose result is
     * never used to assert absence — host liveness, DKIM selector probing —
     * where the second query would double the traffic for no claim.
     */
    confirmAbsence?: boolean;
  } = {},
): Promise<DnsResult> {
  const dnssec = opts.dnssec ?? false;
  const confirmAbsence = opts.confirmAbsence ?? true;
  const order = resolverOrder();

  let first: { res: DnsResponse; name: string } | null = null;
  const failures: string[] = [];

  for (const resolver of order) {
    const res = await askResolver(resolver, name, type, dnssec);
    if (res && typeof res.Status === 'number') {
      first = { res, name: resolver.name };
      break;
    }
    failures.push(resolver.name);
  }

  if (!first) {
    return {
      resolved: false,
      status: null,
      ad: false,
      answers: [],
      resolvers: [],
      reason: `No DNS resolver answered for ${name} ${type} (tried ${failures.join(', ')})`,
    };
  }

  const positive = (first.res.Answer?.length ?? 0) > 0;
  if (positive || !confirmAbsence) {
    return toResult(first.res, [first.name]);
  }

  // The first resolver reports nothing there. Before that becomes a finding,
  // ask someone else — a stale negative cache at one provider is exactly how a
  // correctly configured domain gets told its records are missing.
  const second = order.find((r) => r.name !== first.name);
  if (!second) return toResult(first.res, [first.name]);

  const confirmation = await askResolver(second, name, type, dnssec);
  if (!confirmation || typeof confirmation.Status !== 'number') {
    // Only one opinion available, but it *is* a real DNS answer.
    return toResult(first.res, [first.name]);
  }

  // A positive from either resolver beats a negative from the other: the record
  // either exists or it does not, and one of them is looking at stale state.
  if ((confirmation.Answer?.length ?? 0) > 0) {
    return toResult(confirmation, [second.name, first.name]);
  }

  return toResult(first.res, [first.name, second.name]);
}

/** Records of the requested type only — DoH answers often include the CNAME chain. */
export function answersOfType(res: DnsResult | null, type: string): DnsAnswer[] {
  const code = DNS_TYPE_CODES[type];
  if (!res?.resolved || code === undefined) return [];
  return res.answers.filter((a) => a.type === code);
}

/** DoH quotes TXT strings and splits long records; rebuild the logical value. */
export function normaliseTxt(data: string): string {
  return data
    .split(/"\s+"/)
    .map((part) => part.replace(/^"|"$/g, ''))
    .join('')
    .trim();
}

export function txtValues(res: DnsResult | null): string[] {
  return answersOfType(res, 'TXT').map((a) => normaliseTxt(a.data));
}

/* ------------------------------------------------------------------ *
 * Concurrency
 * ------------------------------------------------------------------ */

/** `Promise.all` with a ceiling, for bulk lookups that would otherwise flood. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  async function worker() {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

/* ------------------------------------------------------------------ *
 * Finding + result helpers
 * ------------------------------------------------------------------ */

/** FNV-1a. Short, stable, and no crypto import — this is an identifier, not a digest. */
function stableHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/**
 * Finding ids are derived from the finding itself, not from a counter.
 *
 * The same issue on the same domain must produce the same id on every scan,
 * otherwise two runs cannot be diffed and the product can never say "three of
 * last month's findings are fixed". Titles are the stable part — they are
 * chosen per branch and do not carry volatile values the way evidence does.
 */
export interface FindingInput {
  title: string;
  severity: Severity;
  /**
   * How well the evidence supports the claim. Required, not defaulted: a
   * default would let a module quietly publish an inference at the same
   * standing as a direct reading.
   */
  confidence: Confidence;
  /** What this is about — a domain, a host name, a URL. */
  asset: string;
  /** What was measured. No inference. */
  observed: string;
  /** What the measurement reasonably indicates. */
  interpretation: string;
  /** What could follow if that reading is right. Conditional voice. */
  risk: string;
  recommendation: string;
  evidence: FindingEvidence;
  scoreImpact?: number;
}

export function makeFinding(category: CategoryKey, finding: FindingInput): Finding {
  return {
    id: `${category}-${stableHash(finding.title)}`,
    category,
    categoryLabel: CATEGORY_LABELS[category],
    ...finding,
  };
}

/**
 * An observation that could not be completed.
 *
 * Kept as a distinct constructor because the rule it enforces is the one this
 * product is built on: an unknown is never a finding. It is always `info`,
 * always high confidence (we are confident the measurement failed — that part
 * *was* observed), and its risk field says explicitly that none is being
 * claimed.
 */
export function makeUnknown(
  category: CategoryKey,
  args: {
    title: string;
    asset: string;
    /** What was attempted and how it failed. */
    observed: string;
    /** What could have been concluded had it worked. */
    wouldHaveShown: string;
    recommendation: string;
    evidence: FindingEvidence;
  },
): Finding {
  return makeFinding(category, {
    title: args.title,
    severity: 'info',
    confidence: 'high',
    asset: args.asset,
    observed: args.observed,
    interpretation: `No conclusion is drawn. ${args.wouldHaveShown}`,
    risk: 'None is claimed. This area was excluded from the score rather than counted against the domain, so the score reflects only what could actually be measured.',
    recommendation: args.recommendation,
    evidence: args.evidence,
  });
}

/**
 * Guards the one weakness of deriving ids from titles: two findings in the same
 * category that happen to share a title would collide. Order within a module is
 * deterministic, so the suffix is stable too.
 */
function withUniqueIds(findings: Finding[]): Finding[] {
  const seen = new Map<string, number>();
  return findings.map((finding) => {
    const count = (seen.get(finding.id) ?? 0) + 1;
    seen.set(finding.id, count);
    return count === 1 ? finding : { ...finding, id: `${finding.id}-${count}` };
  });
}

/* ------------------------------------------------------------------ *
 * Component scoring
 * ------------------------------------------------------------------ */

export interface ScoreComponent {
  /** What this component measures, shown to the reader. */
  label: string;
  /** Points earned, between 0 and `max`. */
  value: number;
  /** Points this component is worth when it can be assessed. */
  max: number;
  /** False when the underlying observation could not be made at all. */
  known?: boolean;
  /** Why it scored what it scored — or, when dropped, what failed. */
  note: string;
}

/**
 * Module-level equivalent of the composite's renormalisation: a component that
 * could not be observed is dropped and the remainder rescaled, rather than
 * scored as though it had failed. An unknown must never cost a domain points —
 * that is the difference between measuring a weakness and inventing one.
 *
 * `coverage` is the share of the module's intended weight that was assessable,
 * so callers can say so rather than quietly reporting a partial score.
 *
 * `breakdown` is the arithmetic itself, kept so the report can show how a
 * number was reached instead of asking the reader to trust it.
 */
export function scoreFromComponents(components: ScoreComponent[]): {
  score: number;
  coverage: number;
  breakdown: ScoreLine[];
} {
  const totalMax = components.reduce((sum, c) => sum + c.max, 0);
  const known = components.filter((c) => c.known !== false);
  const knownMax = known.reduce((sum, c) => sum + c.max, 0);

  const breakdown: ScoreLine[] = components.map((c) => ({
    label: c.label,
    value: c.known === false ? 0 : Math.max(0, Math.min(c.value, c.max)),
    max: c.max,
    assessed: c.known !== false,
    note: c.note,
  }));

  if (knownMax <= 0) return { score: 0, coverage: 0, breakdown };

  const earned = known.reduce((sum, c) => sum + Math.max(0, Math.min(c.value, c.max)), 0);

  return {
    score: clampScore((earned / knownMax) * 100),
    coverage: totalMax > 0 ? Number((knownMax / totalMax).toFixed(4)) : 0,
    breakdown,
  };
}

/**
 * The breakdown for modules that subtract penalties from a starting score
 * rather than adding up components. Same contract — the reader sees the
 * arithmetic — expressed the way those modules actually compute.
 */
export function penaltyBreakdown(
  start: number,
  penalties: { label: string; points: number; note: string }[],
): ScoreLine[] {
  return [
    { label: 'Starting score', value: start, max: start, assessed: true, note: 'Every module in this category starts from a clean sheet and subtracts only for what was confirmed.' },
    ...penalties.map((p) => ({
      label: p.label,
      value: -p.points,
      max: 0,
      assessed: true,
      note: p.note,
    })),
  ];
}

export interface ModuleOutput {
  score: number;
  summary: string;
  findings: Finding[];
  details: CategoryDetail[];
  /** How the score was reached. */
  scoreBreakdown?: ScoreLine[];
  /** Share of the module's own weight that was assessable (0-1). */
  moduleCoverage?: number;
  /** Machine-readable observations for cross-scan comparison. */
  facts?: Record<string, unknown>;
  /** Structured output the dashboard and the PDF render directly. */
  payload?: CategoryPayload;
}

export function buildCategory(
  key: CategoryKey,
  output: ModuleOutput,
  durationMs: number,
): CategoryResult {
  return {
    key,
    label: CATEGORY_LABELS[key],
    score: clampScore(output.score),
    status: 'assessed',
    findings: withUniqueIds(output.findings),
    summary: output.summary,
    details: output.details,
    scoreBreakdown: output.scoreBreakdown,
    moduleCoverage: output.moduleCoverage,
    facts: output.facts,
    payload: output.payload,
    durationMs,
  };
}

export function unavailableCategory(
  key: CategoryKey,
  error: string,
  durationMs: number,
): CategoryResult {
  return {
    key,
    label: CATEGORY_LABELS[key],
    score: 0,
    status: 'unavailable',
    error,
    findings: withUniqueIds([
      makeUnknown(key, {
        title: `${CATEGORY_LABELS[key]} could not be assessed`,
        asset: 'this assessment',
        observed: `The check did not complete: ${error}`,
        wouldHaveShown: `Had it completed, it would have reported on ${CATEGORY_LABELS[key].toLowerCase()}.`,
        recommendation:
          'Re-run the assessment later. If this area keeps failing, verify the domain resolves and is reachable from the public internet.',
        evidence: {
          test: `${CATEGORY_LABELS[key]} module`,
          observed: error,
          verification: 'The failure itself is the observation; no claim about the domain follows from it.',
          limitation:
            'This category contributed nothing to the composite score. The reported coverage figure states how much of the intended assessment was completed.',
        },
      }),
    ]),
    summary: 'Not assessed — the required public data source was unavailable.',
    details: [{ label: 'Status', value: 'Unable to assess', tone: 'warn' }],
    durationMs,
  };
}

/** Runs a module with a hard timeout, degrading to `unavailable` on failure. */
export async function runModule(
  key: CategoryKey,
  fn: (domain: string) => Promise<ModuleOutput>,
  domain: string,
  timeoutMs: number = CHECK_TIMEOUT_MS + 4_000,
): Promise<CategoryResult> {
  const started = Date.now();
  try {
    const output = await Promise.race([
      fn(domain),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Check timed out')), timeoutMs),
      ),
    ]);
    return buildCategory(key, output, Date.now() - started);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return unavailableCategory(key, message, Date.now() - started);
  }
}

export function pct(part: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((part / total) * 100);
}

export function plural(count: number, singular: string, pluralForm?: string): string {
  return `${count} ${count === 1 ? singular : (pluralForm ?? `${singular}s`)}`;
}

export function daysBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / 86_400_000);
}

export function truncate(value: string, max = 160): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
