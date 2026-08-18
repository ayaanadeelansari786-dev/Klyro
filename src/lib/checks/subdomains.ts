import type { CategoryDetail, Finding, RiskTier, SubdomainResult } from '../types';
import { isSensitivePlatform, PROBE_CONCURRENCY, PROBE_TIMEOUT_MS, probeHost } from './probe';
import { classifyName, countByTier, TIER_ORDER, tierSubdomain } from './tiering';
import {
  answersOfType,
  dnsQuery,
  fetchJson,
  makeFinding,
  mapLimit,
  type ModuleOutput,
  penaltyBreakdown,
  plural,
} from './util';

const KEY = 'subdomains' as const;

interface CrtRecord {
  name_value?: string;
  common_name?: string;
  issuer_name?: string;
  not_after?: string;
}

interface CertSpotterRecord {
  dns_names?: string[];
  not_after?: string;
}

interface HostHarvest {
  names: string[];
  source: string;
  /**
   * True when only the apex-certificate query answered.
   *
   * That query returns the certificate for the domain itself, not the logs
   * that enumerate an estate. It is enough to keep the scan moving and not
   * enough to say anything about subdomain exposure.
   */
  degraded: boolean;
}

const JSON_HEADERS = { accept: 'application/json' };

async function fromCrtSh(domain: string): Promise<string[] | null> {
  // `exclude=expired` matters more here than anywhere else in the product: this
  // module used to report every host name ever certified, including systems
  // decommissioned years ago, as current attack surface.
  const records = await fetchJson<CrtRecord[]>(
    `https://crt.sh/?q=${encodeURIComponent(`%.${domain}`)}&output=json&exclude=expired`,
    { headers: JSON_HEADERS },
    11_000,
  );
  if (!Array.isArray(records) || records.length === 0) return null;

  return records.flatMap((record) =>
    `${record.name_value ?? ''}\n${record.common_name ?? ''}`.split('\n'),
  );
}

async function fromCertSpotter(
  domain: string,
  includeSubdomains: boolean,
  timeoutMs: number,
): Promise<string[] | null> {
  const url =
    `https://api.certspotter.com/v1/issuances?domain=${encodeURIComponent(domain)}` +
    `${includeSubdomains ? '&include_subdomains=true' : ''}&expand=dns_names&expand=not_after`;

  const records = await fetchJson<CertSpotterRecord[]>(url, { headers: JSON_HEADERS }, timeoutMs);
  if (!Array.isArray(records) || records.length === 0) return null;

  const now = Date.now();
  return records
    .filter((record) => {
      if (!record.not_after) return true;
      const expiry = new Date(record.not_after).getTime();
      return Number.isNaN(expiry) || expiry > now;
    })
    .flatMap((record) => record.dns_names ?? []);
}

/**
 * Certificate transparency lookup across two independent public logs.
 *
 * Both sources are free and unauthenticated, and both degrade under load —
 * crt.sh returns 503s during busy periods, and CertSpotter's keyless tier
 * times out on domains with very large certificate histories. They are queried
 * in parallel and merged, with a cheaper CertSpotter query as a last resort,
 * so a single flaky upstream never costs the whole category.
 */
async function harvestHostNames(domain: string): Promise<HostHarvest | null> {
  const [crtNames, spotterNames] = await Promise.all([
    fromCrtSh(domain),
    fromCertSpotter(domain, true, 11_000),
  ]);

  const sources: string[] = [];
  const names: string[] = [];

  if (crtNames) {
    sources.push('crt.sh');
    names.push(...crtNames);
  }
  if (spotterNames) {
    sources.push('CertSpotter');
    names.push(...spotterNames);
  }

  if (names.length === 0) {
    // Both rich queries failed — fall back to the apex-only query, which stays
    // fast even for domains with enormous certificate histories.
    const fallback = await fromCertSpotter(domain, false, 8_000);
    if (!fallback) return null;
    return {
      names: fallback,
      source: 'CertSpotter (apex certificates only — broader logs were unavailable)',
      degraded: true,
    };
  }

  return {
    names,
    source: `${sources.join(' + ')} certificate transparency logs, unexpired certificates only`,
    degraded: false,
  };
}

/**
 * Universal architecture. Reported, never scored.
 *
 * `api`, `portal`, `auth`, `sso`, `login` and `id` used to carry a penalty.
 * Every organisation on earth publishes those, so they generated a deduction
 * for having a normal architecture rather than a finding. They are reported
 * separately now, as information, and cost nothing — unless the response
 * itself turns up something, in which case the tiering engine acts on the
 * response rather than on the name.
 */
const ENTRY_POINT_PATTERN =
  /(^|[.-])(api|graphql|gateway|auth|sso|login|id|account|accounts)([.-]|$)/;

/* ------------------------------------------------------------------ *
 * Liveness
 * ------------------------------------------------------------------ */

type Liveness = 'live' | 'dead' | 'unknown';

/**
 * How many host names get resolved before the rest are left unverified. Large
 * estates would otherwise cost hundreds of DNS queries per scan; names
 * suggesting sensitive systems are probed first, so every host this module
 * actually reports on has been confirmed to resolve.
 */
export const MAX_LIVENESS_PROBES = 140;

/**
 * How many live hosts get an HTTP fingerprinting request.
 *
 * This is the budget the whole module is shaped around. Each probe is one GET
 * with a 5-second deadline and an 8KB read cap, run eight at a time, so 30
 * probes is a few seconds of wall time on top of the certificate harvest.
 *
 * Hosts beyond the budget are reported as *not probed* rather than as hosts
 * that answered nothing — a distinction the report makes explicitly, because
 * silently presenting a budget limit as an observation about the target is the
 * kind of error that is invisible in the output.
 */
export const MAX_HTTP_PROBES = 30;

interface LivenessResult {
  liveness: Liveness;
  /** First address seen, for the inventory line. */
  address: string | null;
}

async function resolveLiveness(host: string): Promise<LivenessResult> {
  // Absence here is not used to assert anything about the organisation, only
  // to drop a host from the estate, so one resolver's answer is enough.
  const a = await dnsQuery(host, 'A', { confirmAbsence: false });
  if (!a.resolved) return { liveness: 'unknown', address: null };
  if (a.status === 3) return { liveness: 'dead', address: null };

  const v4 = answersOfType(a, 'A')[0]?.data ?? null;
  if (a.answers.length > 0) return { liveness: 'live', address: v4 };

  const aaaa = await dnsQuery(host, 'AAAA', { confirmAbsence: false });
  if (!aaaa.resolved) return { liveness: 'unknown', address: null };
  const v6 = answersOfType(aaaa, 'AAAA')[0]?.data ?? null;
  return { liveness: aaaa.answers.length > 0 ? 'live' : 'dead', address: v6 };
}

/* ------------------------------------------------------------------ *
 * Finding copy
 *
 * Kept per name class rather than per tier. An administrative console and a
 * staging environment can both land in the same tier, and describing an admin
 * console in the language of non-production environments is the kind of
 * near-miss that makes a reader stop trusting the rest of the report.
 * ------------------------------------------------------------------ */

const CONSEQUENCE: Record<string, string> = {
  admin:
    'An administrative console reachable from the internet is a fixed target for credentials leaked elsewhere, and the controls that make it safe — rate limiting, a second factor, IP restriction — are not observable from outside. Klyro attempted no credentials.',
  cicd: 'A continuous integration or source control server holds source code, build credentials and deployment access. It is frequently the shortest path from the internet to production, because it holds the credentials that deploy there. Klyro did not attempt authentication.',
  data: 'Data stores and file transfer services on public addresses are commonly deployed with default credentials or none at all, because whoever deployed them did not expect them to be publicly reachable. Klyro connected to no service on these hosts.',
  nonprod:
    'Non-production environments commonly carry copies of production data with weaker access control, and run code that has not been through the release process. Publishing their names removes the need for an attacker to guess where they are. Whether any of these is actually less protected was not tested.',
  remote:
    'Remote access gateways are meant to be publicly reachable, so their presence is expected. Naming them publicly does tell an outsider exactly where to direct credential-stuffing attempts, which is the practical consequence.',
  public:
    'None follows from the naming alone. These are listed for inventory completeness.',
};

const PLATFORM_CONSEQUENCE =
  'Engineering, observability and administration tools hold internal architecture, dashboards, ticket contents and sometimes credentials in build logs. Several have had authentication bypasses in recent years, which is why reaching one from the open internet is reported even when it asks for a password.';

function consequenceFor(nameClass: string | null, platformSensitive: boolean): string {
  if (platformSensitive) return PLATFORM_CONSEQUENCE;
  return CONSEQUENCE[nameClass ?? ''] ?? CONSEQUENCE.public;
}

const RECOMMENDATION =
  'Confirm each of these hosts is intended to be internet-facing. Put anything non-production or administrative behind a VPN or an IP allow-list. To keep internal names out of public certificate logs in future, use a private certificate authority for internal systems, or DNS-01 wildcard issuance so individual names are never submitted.';

/** What the probe saw, as one line of evidence. */
function observedLine(result: SubdomainResult): string {
  const parts: string[] = [];
  parts.push(
    result.statusCode !== null
      ? `HTTP ${result.statusCode}`
      : result.unreachableReason === 'timed-out'
        ? 'no response within 5 seconds'
        : result.unreachableReason === 'not-probed'
          ? 'not requested (probe budget reached)'
          : 'no response',
  );
  if (result.redirectTarget) parts.push(`redirect to ${result.redirectTarget}`);
  if (result.detectedPlatform) parts.push(`identified as ${result.detectedPlatform} by ${result.platformEvidence}`);
  if (result.serverHeader) parts.push(`Server: ${result.serverHeader}`);
  if (result.poweredBy) parts.push(`X-Powered-By: ${result.poweredBy}`);
  if (result.authType) parts.push(`WWW-Authenticate: ${result.authType}`);
  if (result.cookieNames.length > 0) parts.push(`cookies named ${result.cookieNames.join(', ')}`);
  return parts.join('; ');
}

/**
 * Confidence in a host-level finding.
 *
 * A response that names its own software is a materially stronger observation
 * than a host name that suggests something, and the two must never be
 * published at the same standing.
 */
function confidenceFor(result: SubdomainResult): 'high' | 'medium' | 'low' {
  // Only a confirmed identification lifts confidence. A page that merely
  // mentions a product's name is weaker evidence than the host name itself.
  if (result.platformConfirmed && result.statusCode !== null) return 'medium';
  return 'low';
}

const PROBE_LIMITATION =
  'Klyro issued one GET to the host root, read at most the first 8KB of the response and followed no redirect. It did not authenticate, did not submit anything, and did not request any path beyond `/`. Software identification comes from what the response published about itself — a page title, a marker in the markup, a cookie name or a header — all of which can be edited, proxied or removed. Reaching a page is not the same as bypassing whatever sits behind it.';

/* ------------------------------------------------------------------ */

export async function checkSubdomains(domain: string): Promise<ModuleOutput> {
  const findings: Finding[] = [];
  const details: CategoryDetail[] = [];

  const harvest = await harvestHostNames(domain);

  if (!harvest) {
    throw new Error('Certificate transparency logs did not respond.');
  }

  /*
   * A degraded harvest is not a clean result with less data in it.
   *
   * The apex-only fallback returns the certificate for the domain itself, so
   * the module would go on to report "2 host names found, none of them
   * sensitive" and score 100 — absence of evidence presented as evidence of
   * absence, on the one category where the estate is the whole subject. It was
   * observed live: two scans of the same domain twenty minutes apart scored
   * 100 and 76 on this category, the difference being entirely whether crt.sh
   * answered. Reporting the category as unassessed drops it from the composite
   * and renormalises the rest, which is what the coverage figure is for.
   */
  if (harvest.degraded) {
    throw new Error(
      'Only the apex certificate could be retrieved. The certificate transparency logs that enumerate host names did not respond, and the apex certificate alone says nothing about the wider estate.',
    );
  }

  const hosts = new Set<string>();
  let wildcardCerts = 0;

  for (const raw of harvest.names) {
    const name = raw.trim().toLowerCase();
    if (!name) continue;

    if (name.startsWith('*.')) {
      wildcardCerts += 1;
      continue;
    }
    if (name === domain || name.endsWith(`.${domain}`)) {
      hosts.add(name);
    }
  }

  const discovered = [...hosts].filter((h) => h !== domain).sort();

  /* ---------------- Which of these actually exist ---------------- */

  const prefixOf = (host: string) => host.slice(0, Math.max(0, host.length - domain.length - 1));

  /*
   * Probe order, and it matters more than it looks.
   *
   * The budget is thirty hosts. Sorting only by "interesting, then
   * alphabetical" put every `api-qa.…` name ahead of `people-admin.…` on a
   * real estate, so the administrative host — the one the category exists to
   * find — fell off the end of the budget and was reported as unprobed.
   * Ranking the classes against each other fixes it: an administrative,
   * build or data name is spent on before a non-production one, and a
   * conventional public name is spent on last.
   */
  const CLASS_PRIORITY: Record<string, number> = {
    admin: 0,
    cicd: 0,
    data: 0,
    nonprod: 1,
    remote: 1,
    public: 3,
  };
  const priorityOf = (host: string) => {
    const named = classifyName(prefixOf(host));
    // An unclassified name sits between "named for something sensitive" and
    // "named for something ordinary": it could be anything.
    return CLASS_PRIORITY[named?.key ?? ''] ?? 2;
  };

  const ordered = [...discovered].sort(
    (a, b) => priorityOf(a) - priorityOf(b) || a.localeCompare(b),
  );

  const probed = ordered.slice(0, MAX_LIVENESS_PROBES);
  const unprobed = ordered.slice(MAX_LIVENESS_PROBES);

  const liveness = await mapLimit(probed, 12, (host) => resolveLiveness(host));

  const live: string[] = [];
  const addressOf = new Map<string, string | null>();
  let dead = 0;
  let unresolvedProbes = 0;

  probed.forEach((host, i) => {
    if (liveness[i].liveness === 'live') {
      live.push(host);
      addressOf.set(host, liveness[i].address);
    } else if (liveness[i].liveness === 'dead') dead += 1;
    else unresolvedProbes += 1;
  });

  /** Discovered but never confirmed either way — over the probe cap, or the lookup failed. */
  const unknown = unresolvedProbes + unprobed.length;
  const total = live.length;

  /* ---------------- Fingerprinting ----------------
     One GET per host, size-limited, in priority order. This is the step that
     turns a name into an observation: what is running, whether it asks for
     credentials, where it sends an unauthenticated visitor. */

  const httpTargets = [...live].sort((a, b) => priorityOf(a) - priorityOf(b) || a.localeCompare(b));
  const toProbe = httpTargets.slice(0, MAX_HTTP_PROBES);
  const notProbed = httpTargets.slice(MAX_HTTP_PROBES);

  const probes = await mapLimit(toProbe, PROBE_CONCURRENCY, (host) =>
    probeHost(host, { timeoutMs: PROBE_TIMEOUT_MS }),
  );
  const probeByHost = new Map(probes.map((p) => [p.host, p]));

  const subdomains: SubdomainResult[] = httpTargets.map((host) => {
    const probe = probeByHost.get(host) ?? null;
    const named = classifyName(prefixOf(host));

    const unreachableReason: SubdomainResult['unreachableReason'] = !probe
      ? 'not-probed'
      : probe.status !== null
        ? null
        : probe.timedOut
          ? 'timed-out'
          : 'no-response';

    // Comes from the probe rather than from the name alone: a weak
    // identification — a brand word in a title — is never sensitive, however
    // sensitive the product itself would be.
    const platformSensitive = probe?.platformSensitive === true;

    const base: Omit<SubdomainResult, 'riskTier' | 'riskReason'> = {
      hostname: host,
      ip: addressOf.get(host) ?? null,
      statusCode: probe?.status ?? null,
      unreachableReason,
      redirectTarget: probe?.redirectTarget ?? null,
      serverHeader: probe?.server ?? null,
      poweredBy: probe?.poweredBy ?? null,
      detectedPlatform: probe?.platform ?? null,
      platformEvidence: probe?.platformEvidence ?? '',
      platformConfirmed: probe?.platformStrength === 'strong',
      authType: probe?.authType ?? null,
      cookieNames: probe?.cookieNames ?? [],
      looksLikeLogin: probe?.looksLikeLogin ?? false,
      namingSuggests: named?.label ?? null,
    };

    const tier = tierSubdomain({
      hostname: host,
      prefix: prefixOf(host),
      statusCode: base.statusCode,
      detectedPlatform: base.detectedPlatform,
      platformSensitive,
      looksLikeLogin: base.looksLikeLogin,
      redirectTarget: base.redirectTarget,
      unreachableReason,
      // Path-level exposure is established on the apex by the exposed-paths
      // module, and Klyro does not probe paths on hosts the operator did not
      // submit. Empty here rather than absent, so the rule stays wired.
      exposedSecrets: [],
    });

    return { ...base, ...tier };
  });

  const tierCounts = countByTier(subdomains);
  const byTier = (tier: RiskTier) => subdomains.filter((s) => s.riskTier === tier);
  const answeringHttp = subdomains.filter((s) => s.statusCode !== null);
  const identified = subdomains.filter((s) => s.detectedPlatform !== null && s.platformConfirmed);

  /* ---------------- Findings: one per critical and high host ---------------- */

  /**
   * Hosts in the top two tiers get their own finding so they reach the risk
   * register individually. Everything below is grouped: a report with forty
   * separate entries for forty staging names is a list, not an assessment.
   */
  const HOST_FINDING_CAP = 12;
  const individual = [...byTier('critical'), ...byTier('high')];
  const listed = individual.slice(0, HOST_FINDING_CAP);
  const overflow = individual.slice(HOST_FINDING_CAP);

  for (const result of listed) {
    const named = classifyName(prefixOf(result.hostname));
    const platformSensitive = result.platformConfirmed && isSensitivePlatform(result.detectedPlatform);

    findings.push(
      makeFinding(KEY, {
        // Naming the software in the title is only honest when the
        // identification is confirmed. An unconfirmed match — a brand word in
        // a page title — produces a title about the host name instead.
        title: result.platformConfirmed && result.detectedPlatform
          ? `${result.detectedPlatform} is reachable at ${result.hostname}`
          : `${result.hostname} answers publicly and is named for ${named?.label ?? 'a sensitive system'}`,
        severity: result.riskTier === 'critical' ? 'critical' : 'high',
        confidence: confidenceFor(result),
        asset: result.hostname,
        observed: `${result.hostname} resolves${result.ip ? ` to ${result.ip}` : ''} and returned ${observedLine(result)}.`,
        interpretation: result.riskReason,
        risk: consequenceFor(named?.key ?? null, platformSensitive),
        recommendation: RECOMMENDATION,
        evidence: {
          test: `DNS resolution of ${result.hostname}, then one GET to https://${result.hostname}/ with redirects unfollowed and the response body read up to 8KB`,
          observed: observedLine(result),
          expected:
            'Administrative, build and non-production systems not reachable from the public internet, or reachable only behind a network control',
          verification: result.detectedPlatform
            ? `Software identified from ${result.platformEvidence}.${result.platformConfirmed ? '' : ' That is a mention rather than a confirmation, so it did not raise this host\'s tier.'} ${result.looksLikeLogin ? 'The response carried the marks of a sign-in page.' : 'The response carried no sign-in prompt that Klyro could detect.'}`
            : 'The host was confirmed to resolve and to answer, and the response published nothing identifying the software behind it.',
          limitation: PROBE_LIMITATION,
        },
      }),
    );
  }

  if (overflow.length > 0) {
    findings.push(
      makeFinding(KEY, {
        title: 'Further hosts in the upper risk tiers',
        severity: 'high',
        confidence: 'low',
        asset: overflow.map((r) => r.hostname).slice(0, 8).join(', '),
        observed: `${plural(overflow.length, 'further host')} fell into the critical or high tier beyond the ${HOST_FINDING_CAP} listed individually: ${overflow.map((r) => r.hostname).slice(0, 12).join(', ')}${overflow.length > 12 ? ` (+${overflow.length - 12} more)` : ''}.`,
        interpretation:
          'These are grouped rather than listed separately so the register stays readable. Each carries its own tier and reason in the subdomain table.',
        risk: 'The same consequences described for the hosts above apply to each of these, individually.',
        recommendation: RECOMMENDATION,
        evidence: {
          test: 'Same probe as the hosts above: DNS resolution, then one GET to the host root',
          observed: overflow.map((r) => `${r.hostname} → ${r.statusCode ?? 'no response'}`).slice(0, 12).join(', '),
          verification: 'Every host counted here resolved and was probed.',
          limitation: PROBE_LIMITATION,
        },
      }),
    );
  }

  /* ---------------- Findings: medium tier, grouped by name class ---------------- */

  const mediumByClass = new Map<string, SubdomainResult[]>();
  for (const result of byTier('medium')) {
    const named = classifyName(prefixOf(result.hostname));
    const key = named?.key ?? 'other';
    mediumByClass.set(key, [...(mediumByClass.get(key) ?? []), result]);
  }

  for (const [key, group] of mediumByClass) {
    const label = NAME_CLASS_LABEL[key] ?? 'a system worth reviewing';
    const answering = group.filter((r) => r.statusCode !== null);

    findings.push(
      makeFinding(KEY, {
        title: `Host names suggesting ${label} resolve publicly`,
        severity: 'medium',
        confidence: answering.length > 0 ? 'medium' : 'low',
        asset: group.map((r) => r.hostname).slice(0, 8).join(', '),
        observed: `${plural(group.length, 'host name')} under ${domain} whose naming suggests ${label} resolve today: ${group.map((r) => r.hostname).slice(0, 10).join(', ')}${group.length > 10 ? ` (+${group.length - 10} more)` : ''}. ${answering.length} of ${group.length} answered an HTTPS request.`,
        interpretation: `${group.length === 1 ? 'This name suggests' : 'These names suggest'} ${label}. The classification comes from the name; the status codes come from a single request to each host root.`,
        risk: consequenceFor(key, false),
        recommendation: RECOMMENDATION,
        evidence: {
          test: `Certificate transparency harvest under ${domain}, DNS resolution of each name, then one GET to each host root`,
          observed: group
            .slice(0, 10)
            .map((r) => `${r.hostname} → ${r.statusCode ?? (r.unreachableReason === 'not-probed' ? 'not probed' : 'no response')}`)
            .join(', ') + (group.length > 10 ? ` (+${group.length - 10} more)` : ''),
          expected: 'Internal and non-production systems not appearing in public certificate logs, or not resolving publicly',
          verification: `DNS resolution confirmed for every name listed. ${answering.length} of ${group.length} returned an HTTP status.`,
          limitation: PROBE_LIMITATION,
        },
      }),
    );
  }

  /* ---------------- Estate size — reported, never scored ---------------- */

  if (total >= 100) {
    findings.push(
      makeFinding(KEY, {
        title: 'Large public host estate',
        severity: 'info',
        confidence: 'high',
        asset: domain,
        observed: `${total} host names under ${domain} appear in unexpired certificate transparency records and resolve today, out of ${discovered.length} discovered.`,
        interpretation:
          'This is a measure of organisation size rather than exposure, which is why it carries no score. Large estates do reliably contain systems nobody currently owns.',
        risk:
          'Forgotten systems stop receiving patches while remaining reachable. Nobody finds those without an inventory, which is the reason this figure is reported at all.',
        recommendation:
          'Run a quarterly inventory of internet-facing host names and decommission anything without a named owner.',
        evidence: {
          test: 'Certificate transparency harvest, followed by DNS resolution of each discovered name',
          observed: `${total} resolving of ${discovered.length} discovered`,
          verification: `Every counted host was resolved; ${unknown} could not be confirmed and are excluded from this figure.`,
          limitation:
            'Certificate transparency only sees names that were given a publicly trusted certificate. Hosts using a private CA, or no certificate, do not appear here at all.',
        },
      }),
    );
  }

  const entryPoints = live.filter((host) => ENTRY_POINT_PATTERN.test(prefixOf(host)));

  if (entryPoints.length > 0) {
    findings.push(
      makeFinding(KEY, {
        title: 'Public application entry points',
        severity: 'info',
        confidence: 'high',
        asset: entryPoints.slice(0, 8).join(', '),
        observed: `${plural(entryPoints.length, 'host name')} matching common application, API or sign-in naming resolve publicly: ${entryPoints.slice(0, 10).join(', ')}${entryPoints.length > 10 ? ` (+${entryPoints.length - 10} more)` : ''}.`,
        interpretation:
          'These are the names an ordinary application architecture produces. Their presence is expected and says nothing about how well the systems behind them are defended.',
        risk:
          'None follows from the naming. They are listed for inventory completeness and carry no score.',
        recommendation:
          'No action from this observation. The controls that matter on these hosts — rate limiting, multi-factor authentication, authorisation — are not visible from outside and would need to be confirmed with the operator.',
        evidence: {
          test: 'Certificate transparency harvest, DNS resolution, name matched against a list of conventional entry-point labels',
          observed: entryPoints.slice(0, 12).join(', '),
          verification: 'Every name listed was confirmed to resolve.',
          limitation:
            'Naming convention only. Where one of these hosts was also probed, its response appears in the subdomain table with its own tier.',
        },
      }),
    );
  }

  if (wildcardCerts > 0) {
    findings.push(
      makeFinding(KEY, {
        title: 'Wildcard certificate issued for this domain',
        severity: 'info',
        confidence: 'high',
        asset: `*.${domain}`,
        observed: `${wildcardCerts} unexpired certificate entr${wildcardCerts === 1 ? 'y covers' : 'ies cover'} \`*.${domain}\`.`,
        interpretation:
          'A wildcard certificate is a configuration characteristic, not a weakness. It is the standard way to avoid publishing every internal host name to the public certificate logs, and it reduces certificate management overhead. It is noted here because it changes what this section can see.',
        risk:
          'Two consequences follow, neither demonstrated here. First, the host names covered by a wildcard do not appear in transparency logs, so the estate listed above is incomplete by an unknown amount. Second, a single private key covers every host under the domain, so the impact of that key being exposed is broader than for a per-host certificate. Klyro observed no evidence of key exposure or inappropriate reuse.',
        recommendation:
          'No action is required for the wildcard itself. Keep the private key off shared application servers, restrict it to the terminating load balancer, and rotate on a fixed schedule so the blast radius stays bounded.',
        evidence: {
          test: `Certificate transparency queried for unexpired certificates matching %.${domain}`,
          observed: `${wildcardCerts} entries with a *.${domain} subject alternative name`,
          verification: 'Counted from the same harvest used for the host inventory; expired certificates were excluded at the source.',
          limitation:
            'Klyro cannot see how the private key is stored or where it is deployed, and makes no claim about either.',
        },
      }),
    );
  }

  /* ---------------- Details ---------------- */

  details.push(
    { label: 'Host names in certificate logs', value: String(discovered.length), mono: true },
    {
      label: 'Resolving today',
      value: `${total}${dead > 0 ? ` (${dead} no longer resolve)` : ''}`,
      mono: true,
      tone: 'neutral',
    },
    {
      label: 'Risk tiers',
      value: TIER_ORDER.filter((tier) => tierCounts[tier] > 0)
        .map((tier) => `${tier} ${tierCounts[tier]}`)
        .join(' · ') || 'None',
      mono: true,
      tone: tierCounts.critical > 0 ? 'bad' : tierCounts.high > 0 ? 'warn' : 'good',
    },
    {
      label: 'Answered an HTTPS request',
      value: toProbe.length
        ? `${answeringHttp.length} of ${toProbe.length} probed`
        : 'None probed',
      mono: true,
      tone: answeringHttp.length ? 'warn' : 'neutral',
    },
    {
      label: 'Software identified from the response',
      value: identified.length
        ? identified
            .slice(0, 8)
            .map((r) => `${r.hostname} → ${r.detectedPlatform}`)
            .join(', ')
        : 'None identified',
      mono: true,
      tone: identified.length ? 'warn' : 'neutral',
    },
    {
      label: 'Wildcard certificates',
      value: wildcardCerts ? `${wildcardCerts} observed` : 'None',
      tone: 'neutral',
    },
    {
      label: 'Sample of the live estate',
      value: live.slice(0, 10).join(', ') || 'No resolving subdomains found',
      mono: true,
    },
    { label: 'Data source', value: harvest.source },
    {
      label: 'Verification',
      value:
        `${live.length + dead} of ${discovered.length} host names were resolved` +
        (unknown > 0
          ? `; ${unknown} could not be confirmed${unprobed.length > 0 ? ` (${unprobed.length} beyond the ${MAX_LIVENESS_PROBES}-host resolution limit)` : ''} and are excluded from both the findings and the score`
          : '') +
        (notProbed.length > 0
          ? `. ${notProbed.length} resolving host(s) were beyond the ${MAX_HTTP_PROBES}-host HTTP probe budget and are reported as not probed rather than as unreachable`
          : ''),
      tone: unknown > 0 || notProbed.length > 0 ? 'neutral' : 'good',
    },
    {
      label: 'What this cannot see',
      value:
        'Only names given a publicly trusted certificate appear in transparency logs. Hosts behind a wildcard certificate, using a private certificate authority, or serving no certificate are invisible to this check. Software identification reads what a response published about itself and can be edited, proxied or removed.',
      tone: 'neutral',
    },
  );

  /* ---------------- Score ----------------
     Driven by tier rather than by naming class, so a live administrative
     console and a dormant DNS entry with the same name no longer cost the same.

     Penalties saturate per tier rather than stacking per host. Five staging
     hosts are not five times the finding that one is — they are the same
     finding, at slightly larger scale — and charging linearly drove any
     organisation with a normal number of internal names to zero.

     Wildcard certificates carry no penalty at all. They are a configuration
     characteristic, and a deduction for them would charge domains for
     following the practice that keeps internal names *out* of these logs. */

  const TIER_PENALTY: Record<RiskTier, number> = {
    critical: 30,
    high: 12,
    medium: 5,
    low: 1,
    info: 0,
  };

  let penaltyTotal = 0;
  const penalties: { label: string; points: number; note: string }[] = [];

  for (const tier of TIER_ORDER) {
    const group = byTier(tier);
    if (group.length === 0 || TIER_PENALTY[tier] === 0) continue;

    const scale = 1 + Math.min(group.length - 1, 5) * 0.15;
    const points = Math.round(TIER_PENALTY[tier] * scale);
    penaltyTotal += points;

    const confirmed = group.filter((r) => r.statusCode !== null).length;
    penalties.push({
      label: `${tier === 'critical' ? 'Critical' : tier === 'high' ? 'High' : tier === 'medium' ? 'Medium' : 'Low'}-tier hosts`,
      points,
      note: `${plural(group.length, 'host')}, ${confirmed} of which answered an HTTPS request. Charged once for the tier with a size multiplier, not once per host.`,
    });
  }

  const capped = Math.min(penaltyTotal, 85);
  if (capped < penaltyTotal) {
    penalties.push({
      label: 'Penalty cap applied',
      points: -(penaltyTotal - capped),
      note: 'Total deductions were capped at 85 points so that a large estate cannot drive this category to zero.',
    });
  }

  const score = Math.max(0, Math.round(100 - capped));

  const upper = tierCounts.critical + tierCounts.high;
  const summary =
    upper === 0
      ? `${total} of ${discovered.length} host names in certificate records still resolve, and none of the ${toProbe.length} probed returned anything placing it in the critical or high tier.`
      : `${total} host names resolve publicly. ${tierCounts.critical} fell into the critical tier and ${tierCounts.high} into the high tier${identified.length ? `, with software identified on ${plural(identified.length, 'host')}` : ''}.`;

  const facts = {
    discovered: discovered.length,
    live: total,
    dead,
    unknown,
    wildcardCerts,
    liveHosts: live.slice(0, 200),
    tierCounts,
    // Kept under its historical name so a comparison against an older scan
    // still has something to diff against.
    flagged: subdomains.filter((s) => s.riskTier !== 'info').map((s) => s.hostname),
  };

  return {
    score,
    summary,
    findings,
    details,
    scoreBreakdown: penaltyBreakdown(100, penalties),
    facts,
    payload: { subdomains },
  };
}

/** Display labels for the grouped medium-tier findings. */
const NAME_CLASS_LABEL: Record<string, string> = {
  admin: 'an administrative interface',
  cicd: 'a build or deployment system',
  data: 'a database or infrastructure service',
  nonprod: 'a non-production or internal environment',
  remote: 'a remote access gateway',
  public: 'a conventional public-facing service',
  other: 'a system worth reviewing',
};
