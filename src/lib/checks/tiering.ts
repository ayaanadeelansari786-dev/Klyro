/**
 * Subdomain risk tiering.
 *
 * Tiers are a function of the host *name* and the *response* together. That
 * pairing is the whole point of the module: the previous design grouped hosts
 * by naming convention alone, which meant a dormant DNS entry called `admin`
 * and a live Grafana instance landed in the same bucket with the same words
 * attached.
 *
 * Every `riskReason` below states what was observed and stops there. The
 * distinction that matters most is between *reachable* and *unauthenticated*:
 * Jenkins, Grafana and GitLab all answer 200 on their sign-in pages, so "the
 * server is directly accessible without authentication" is a claim a status
 * code does not support. `looksLikeLogin` carries that difference through, and
 * the only place this file says anything about authentication is where the
 * response showed no sign of requiring it — and even then it says the page
 * carried no sign-in prompt rather than that the system is open.
 */

import type { RiskTier, SubdomainResult } from '../types';

/* ------------------------------------------------------------------ *
 * Name classes
 *
 * Matched against the label portion of the host name — everything to the left
 * of the domain — so `dev.example.com` matches and `example.com` does not.
 * ------------------------------------------------------------------ */

export const NAME_CLASSES: { key: string; label: string; pattern: RegExp }[] = [
  {
    key: 'admin',
    label: 'an administrative interface',
    pattern: /(^|[.-])(admin|adminer|manage|manager|panel|console|portal|dashboard|backoffice|cpanel|phpmyadmin|webmail)([.-]|$)/,
  },
  {
    key: 'cicd',
    label: 'a build or deployment system',
    pattern: /(^|[.-])(jenkins|ci|cd|build|builds|deploy|pipeline|pipelines|drone|gitlab|argocd|bamboo|teamcity)([.-]|$)/,
  },
  {
    key: 'data',
    label: 'a database or infrastructure service',
    pattern: /(^|[.-])(db|database|redis|elastic|elasticsearch|mongo|postgres|postgresql|mysql|rabbit|rabbitmq|kafka|grafana|prometheus|kibana|minio|backup|ftp|sftp)([.-]|$)/,
  },
  {
    key: 'nonprod',
    label: 'a non-production or internal environment',
    pattern: /(^|[.-])(staging|stage|stg|uat|preprod|pre-prod|sandbox|demo|test|testing|qa|dev|devel|development|beta|alpha|canary|preview|internal|intranet|corp|private)([.-]|$)/,
  },
  {
    key: 'remote',
    label: 'a remote access gateway',
    pattern: /(^|[.-])(vpn|sslvpn|remote|rdp|citrix|anyconnect|pulse|ipsec)([.-]|$)/,
  },
  {
    key: 'public',
    label: 'a conventional public-facing service',
    pattern: /(^|[.-])(www|mail|smtp|imap|pop|mx|autodiscover|autoconfig|ns\d*|cdn|static|assets|img|images|media|files|blog|shop|store|docs|help|status)([.-]|$)/,
  },
];

/** The class a host name falls into, or null when the name suggests nothing. */
export function classifyName(prefix: string): { key: string; label: string } | null {
  for (const entry of NAME_CLASSES) {
    if (entry.pattern.test(prefix)) return { key: entry.key, label: entry.label };
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Tiering
 * ------------------------------------------------------------------ */

export interface TierInput {
  hostname: string;
  /** Label portion of the host name, lowercased. */
  prefix: string;
  statusCode: number | null;
  detectedPlatform: string | null;
  /**
   * Whether the identified software is the kind whose mere reachability is
   * material — a build server, a database console, an observability stack.
   */
  platformSensitive: boolean;
  looksLikeLogin: boolean;
  redirectTarget: string | null;
  unreachableReason: 'timed-out' | 'no-response' | 'not-probed' | null;
  /**
   * Path-level exposures confirmed on *this specific host* by another module —
   * `.env`, `.git`, a debug endpoint, GraphQL introspection.
   *
   * Only ever populated for the apex domain today. Klyro probes paths on the
   * domain it was asked about and not on every host it discovers, because that
   * would turn one assessment into a few hundred unsolicited requests against
   * systems the operator did not submit. The rule exists here so the wiring is
   * ready if that changes; it is not silently doing something broader.
   */
  exposedSecrets: string[];
}

function describeStatus(status: number | null, reason: TierInput['unreachableReason']): string {
  if (status !== null) return `HTTP ${status}`;
  if (reason === 'timed-out') return 'no response within the probe deadline';
  if (reason === 'not-probed') return 'no HTTP request within this scan\'s budget';
  return 'no response';
}

/**
 * Places a host in a tier and says why, in one sentence.
 *
 * Rules are evaluated most-severe first and the first match wins, so the order
 * of the blocks below *is* the priority order.
 */
export function tierSubdomain(input: TierInput): { riskTier: RiskTier; riskReason: string } {
  const {
    hostname,
    prefix,
    statusCode,
    detectedPlatform,
    platformSensitive,
    looksLikeLogin,
    redirectTarget,
    unreachableReason,
    exposedSecrets,
  } = input;

  const named = classifyName(prefix);
  const nameClass = named?.key ?? null;
  const answered = statusCode !== null;
  const observed = describeStatus(statusCode, unreachableReason);

  /*
   * A host that was never probed is not a host that answered nothing.
   *
   * Every rule below reads a status code, and `null` would drop an unprobed
   * host into the same branches as a refused connection — reporting a budget
   * limit as an observation about the target. It is tiered on the name alone,
   * capped at medium, and says plainly that no request was made.
   */
  if (unreachableReason === 'not-probed') {
    const material = nameClass === 'admin' || nameClass === 'cicd' || nameClass === 'data' || nameClass === 'nonprod';
    return {
      riskTier: material ? 'medium' : 'info',
      riskReason: named
        ? `${hostname} resolves and is named for ${named.label}, but the scan's HTTP probe budget was reached before it could be requested. The name is the only evidence here.`
        : `${hostname} resolves. No HTTP request was made within this scan's budget, so nothing is known about what runs on it.`,
    };
  }

  /* ---------------- Critical ---------------- */

  if (exposedSecrets.length > 0) {
    return {
      riskTier: 'critical',
      riskReason: `${hostname} returned ${exposedSecrets.join(', ')} to an unauthenticated request.`,
    };
  }

  if (platformSensitive && statusCode === 200 && !looksLikeLogin) {
    return {
      riskTier: 'critical',
      riskReason: `${detectedPlatform} answered on ${hostname} with a page carrying no sign-in prompt — Klyro read the response and did not authenticate, so whether the application enforces access control behind it was not established.`,
    };
  }

  /* ---------------- High ---------------- */

  if (platformSensitive && statusCode === 200 && looksLikeLogin) {
    return {
      riskTier: 'high',
      riskReason: `${detectedPlatform} is reachable at ${hostname} and returned what appears to be a sign-in page. Access looks controlled; the tool itself is still exposed to the internet.`,
    };
  }

  if (platformSensitive && answered) {
    return {
      riskTier: 'high',
      riskReason: `${detectedPlatform} exists at ${hostname} and returned ${observed}${redirectTarget ? `, redirecting to ${redirectTarget}` : ''}. The request was refused or sent elsewhere, so access appears controlled, but the service is internet-facing.`,
    };
  }

  if (nameClass === 'admin' && (statusCode === 200 || (statusCode !== null && statusCode >= 300 && statusCode < 400))) {
    return {
      riskTier: 'high',
      riskReason: `${hostname} is named for an administrative interface and answered ${observed}${redirectTarget ? `, redirecting to ${redirectTarget}` : ''}. The name is a convention rather than a declaration, and no request beyond the home page was made.`,
    };
  }

  if (nameClass === 'cicd' && answered) {
    return {
      riskTier: 'high',
      riskReason: `${hostname} is named for a build or deployment system and answered ${observed}. Systems in that class hold source, build credentials and deployment access when the name is accurate.`,
    };
  }

  if (nameClass === 'data' && answered) {
    return {
      riskTier: 'high',
      riskReason: `${hostname} is named for a database or infrastructure service and answered ${observed}. Klyro connected to no service on this host and identified nothing beyond the HTTP response.`,
    };
  }

  /* ---------------- Medium ---------------- */

  if (
    nameClass === 'nonprod' &&
    statusCode !== null &&
    (statusCode === 200 || statusCode === 403 || (statusCode >= 300 && statusCode < 400))
  ) {
    return {
      riskTier: 'medium',
      riskReason: `${hostname} is named for a non-production or internal environment and answered ${observed}. Environments in that class commonly hold copies of production data under lighter access control; whether this one does was not tested.`,
    };
  }

  /*
   * An administrative name that answered something other than 200 or a
   * redirect — a 403, or a 5xx.
   *
   * Without this rule those fell through every branch to the `info` default,
   * which then said "nothing in the name or the response suggests a sensitive
   * system" about a host called `people-admin`. Observed live on a real
   * estate: two administrative hosts returning 403 were reported as
   * unremarkable. A refusal means the host exists and is gated, which is
   * weaker than an open console and much stronger than nothing.
   */
  if (nameClass === 'admin' && answered) {
    return {
      riskTier: 'medium',
      riskReason: `${hostname} is named for an administrative interface and answered ${observed}. The request was refused rather than served, so access appears controlled — the host is nonetheless reachable from the internet.`,
    };
  }

  if (nameClass === 'remote') {
    return {
      riskTier: 'medium',
      riskReason: `${hostname} is named for a remote access gateway and returned ${observed}. Gateways are meant to be reachable, so this is noted rather than faulted — the practical consequence is that it tells an outsider exactly where to direct credential attempts.`,
    };
  }

  /* ---------------- Low ---------------- */

  if (nameClass === 'nonprod' && statusCode !== null && statusCode >= 500) {
    return {
      riskTier: 'low',
      riskReason: `${hostname} is named for a non-production environment and returned ${observed}, so a host exists but nothing is currently serving it. A dormant name that resolves is worth an owner even when it answers nothing.`,
    };
  }

  if (nameClass === 'nonprod') {
    return {
      riskTier: 'low',
      riskReason: `${hostname} is named for a non-production environment and returned ${observed} over HTTPS. The name resolves, so something is registered for it.`,
    };
  }

  if (!answered) {
    return {
      riskTier: 'low',
      riskReason: `${hostname} resolves but returned ${observed}. Nothing follows from this beyond the name existing in DNS.`,
    };
  }

  /* ---------------- Info ---------------- */

  if (nameClass === 'public' || nameClass === null) {
    return {
      riskTier: 'info',
      riskReason: detectedPlatform
        ? `${hostname} answered ${observed} and identified itself as ${detectedPlatform}. The naming and the software are both what an ordinary public estate produces.`
        : `${hostname} answered ${observed} with nothing identifying in the response. Listed for inventory completeness.`,
    };
  }

  // Reached only by a classified name no rule above claimed. The reason names
  // the class rather than denying there is one — the previous wording said
  // "nothing in the name suggests a sensitive system" about hosts whose names
  // plainly did.
  return {
    riskTier: 'info',
    riskReason: `${hostname} answered ${observed}. Its name suggests ${named?.label ?? 'nothing in particular'}, and the response gave no further indication either way.`,
  };
}

/* ------------------------------------------------------------------ *
 * Presentation helpers
 * ------------------------------------------------------------------ */

export const TIER_ORDER: RiskTier[] = ['critical', 'high', 'medium', 'low', 'info'];

export const TIER_LABELS: Record<RiskTier, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  info: 'Informational',
};

export function groupByTier(results: SubdomainResult[]): Record<RiskTier, SubdomainResult[]> {
  const grouped: Record<RiskTier, SubdomainResult[]> = {
    critical: [],
    high: [],
    medium: [],
    low: [],
    info: [],
  };
  for (const result of results) grouped[result.riskTier].push(result);
  for (const tier of TIER_ORDER) {
    grouped[tier].sort((a, b) => a.hostname.localeCompare(b.hostname));
  }
  return grouped;
}

export function countByTier(results: SubdomainResult[]): Record<RiskTier, number> {
  const counts: Record<RiskTier, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const result of results) counts[result.riskTier] += 1;
  return counts;
}
