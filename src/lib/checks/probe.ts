/**
 * HTTP fingerprinting probe.
 *
 * One request, size-limited, shared by the subdomain module and the technology
 * module. It is the layer that turns "this name resolves" into "something is
 * running here, and here is what it says it is".
 *
 * Three rules govern everything below, and each of them is load-bearing.
 *
 * 1. **Only what the target published.** A platform is reported because the
 *    response said so — a title, a marker in the markup, a cookie name, a
 *    header. Nothing is inferred from timing, behaviour or absence, and the
 *    string that triggered the identification travels with it so a reader can
 *    disagree with the conclusion.
 *
 * 2. **Cookie names, never cookie values.** `Set-Cookie` is split on the first
 *    `=` and only the left side is kept. A session cookie belonging to whoever
 *    the target last served is not Klyro's to record, and a fingerprinting
 *    feature that quietly collected them would be indefensible. Enforced by
 *    test, not by care.
 *
 * 3. **Reaching a page is not bypassing its authentication.** Jenkins, Grafana
 *    and GitLab all answer 200 on their sign-in pages. `looksLikeLogin` exists
 *    so the difference between "reachable" and "unauthenticated" survives into
 *    the report, because those are very different claims and only one of them
 *    is usually true.
 *
 * Redirects are never followed here. A 302 is more informative than whatever
 * sits at the other end of it: where a host sends an unauthenticated visitor is
 * itself the observation.
 */

import { safeFetch } from './util';

/** First 8KB of a subdomain's response. Enough for <head>, which is where the tells are. */
export const SUBDOMAIN_BODY_BYTES = 8 * 1024;

/** First 50KB of the primary domain — script tags run well past the head. */
export const PRIMARY_BODY_BYTES = 50 * 1024;

/** Per-host deadline, applied separately to the headers and to the body read. */
export const PROBE_TIMEOUT_MS = 5_000;

/** How many hosts are probed at once. */
export const PROBE_CONCURRENCY = 8;

export interface HostProbe {
  host: string;
  /** Null when nothing answered. `timedOut` says which kind of nothing. */
  status: number | null;
  /**
   * True when no response arrived inside the deadline, as opposed to the
   * connection being refused or the host being blocked.
   *
   * Inferred from elapsed time rather than read from the error: `safeFetch`
   * collapses every transport failure to null on purpose, so that a blocked
   * host and an unreachable one are indistinguishable to callers. The
   * inference is stated in the report as "did not answer within 5 seconds"
   * rather than as a claim about filtering, because that is all it supports.
   */
  timedOut: boolean;
  /** `Location`, when the response was a redirect. Never followed. */
  redirectTarget: string | null;
  server: string | null;
  poweredBy: string | null;
  generator: string | null;
  aspNetVersion: string | null;
  via: string | null;
  /** Scheme from `WWW-Authenticate` — Basic, Bearer, NTLM, Negotiate. */
  authType: string | null;
  /** Names only. Never values. */
  cookieNames: string[];
  title: string | null;
  /** Identified software, when the response named it. */
  platform: string | null;
  /** Which signal identified it, phrased for a report line. */
  platformEvidence: string | null;
  /** How well the evidence supports the identification. See `PlatformStrength`. */
  platformStrength: PlatformStrength | null;
  /**
   * The identification is strong *and* the software is one whose reachability
   * is material. Only this drives the risk tier — a brand name in a title
   * never does.
   */
  platformSensitive: boolean;
  /** The response carries the marks of a sign-in page. */
  looksLikeLogin: boolean;
  /** Bytes actually read, which is at most the cap. */
  bodyBytes: number;
}

/* ------------------------------------------------------------------ *
 * Size-limited body reading
 * ------------------------------------------------------------------ */

/**
 * Reads at most `maxBytes`, then cancels.
 *
 * The deadline matters as much as the size cap. `safeFetch` clears its abort
 * timer once the response headers arrive, so a host that sends headers
 * promptly and then dribbles the body forever would hold a worker for the rest
 * of the scan. The reader gets its own timer, and cancelling it unblocks the
 * pending `read()`.
 */
export async function readCapped(res: Response, maxBytes: number, timeoutMs: number): Promise<string> {
  const body = res.body;
  if (!body) return '';

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  const timer = setTimeout(() => {
    void reader.cancel().catch(() => undefined);
  }, timeoutMs);

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(value);
      total += value.byteLength;
      if (total >= maxBytes) break;
    }
  } catch {
    // A cancelled or truncated read still leaves usable bytes in `chunks`.
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => undefined);
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  // `fatal: false` because a cap will usually land mid-codepoint, and a
  // replacement character at the tail is not worth losing the whole read over.
  return new TextDecoder('utf-8', { fatal: false }).decode(merged.subarray(0, maxBytes));
}

/* ------------------------------------------------------------------ *
 * Header extraction
 * ------------------------------------------------------------------ */

/**
 * Cookie *names*.
 *
 * Everything before the first `=` and nothing after it. See rule 2 at the top
 * of this file — this function is the whole of that guarantee, and
 * `tests/probe.test.ts` asserts that a value never survives it.
 */
export function cookieNamesFrom(headers: Headers): string[] {
  const raw =
    typeof (headers as unknown as { getSetCookie?: () => string[] }).getSetCookie === 'function'
      ? (headers as unknown as { getSetCookie: () => string[] }).getSetCookie()
      : headers.get('set-cookie')
        ? [headers.get('set-cookie') as string]
        : [];

  const names: string[] = [];
  for (const cookie of raw) {
    const name = cookie.split('=')[0]?.trim();
    // Anything with whitespace or a semicolon in it is not a cookie name; a
    // header this malformed is more likely a parsing accident than a fact.
    if (!name || /[\s;,]/.test(name)) continue;
    if (!names.includes(name)) names.push(name.slice(0, 64));
  }
  return names.slice(0, 12);
}

/** The scheme, not the realm — a realm string is target-controlled prose. */
function authSchemeFrom(headers: Headers): string | null {
  const value = headers.get('www-authenticate');
  if (!value) return null;
  const scheme = value.trim().split(/[\s,]/)[0];
  return scheme ? scheme.slice(0, 24) : null;
}

/* ------------------------------------------------------------------ *
 * Markup extraction
 * ------------------------------------------------------------------ */

export function titleOf(html: string): string | null {
  const match = /<title[^>]*>([\s\S]{0,300}?)<\/title>/i.exec(html);
  if (!match) return null;
  const text = match[1]
    .replace(/\s+/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .trim();
  return text ? text.slice(0, 160) : null;
}

export function metaGeneratorOf(html: string): string | null {
  const match =
    /<meta[^>]+name=["']generator["'][^>]*content=["']([^"']{1,160})["']/i.exec(html) ??
    /<meta[^>]+content=["']([^"']{1,160})["'][^>]*name=["']generator["']/i.exec(html);
  return match ? match[1].trim() : null;
}

/* ------------------------------------------------------------------ *
 * Platform identification
 *
 * `sensitive` marks software where reaching the login page from the open
 * internet is itself worth reporting: build servers, database consoles,
 * observability stacks, artefact registries. It is not a claim that the
 * software is vulnerable, and it never becomes one.
 * ------------------------------------------------------------------ */

/**
 * Identification strength, and the reason this type exists.
 *
 * A live scan of `gitlab.com` produced eight critical findings: every page in
 * the estate has "GitLab" in its title, because GitLab the company owns the
 * domain. The scanner reported a marketing page as a reachable source-control
 * server, and the category score fell to 24 on the strength of a brand name.
 *
 * `strong` means the response emitted something only that product emits — a
 * product-specific cookie, a header naming it, or a marker from its own
 * application shell. `weak` means the response merely mentions it, which a
 * vendor's own website, a documentation page or a status page all do.
 *
 * Only a strong identification is allowed to drive the risk tier. A weak one
 * is still reported, with its evidence, so a reader can see what was seen.
 */
export type PlatformStrength = 'strong' | 'weak';

export interface PlatformRule {
  name: string;
  /**
   * A marker only this product's own application emits. Strong.
   *
   * Kept deliberately narrow — `grafanaBootData` rather than `grafana`. The
   * broad version matches any page that links to the product's website.
   */
  signature?: RegExp;
  /**
   * A cookie only this product sets. Strong.
   *
   * Must be product-specific. `sid` and `session` were here once and matched
   * a large share of the internet.
   */
  cookie?: RegExp;
  /** Server, X-Powered-By or X-Generator naming the software. Strong. */
  header?: RegExp;
  /** Matched against the <title>. Weak — a brand name is not a deployment. */
  title?: RegExp;
  /** A loose marker anywhere in the markup. Weak. */
  markup?: RegExp;
  /**
   * Reaching this from the internet is material regardless of whether it is
   * authenticated. Only takes effect on a strong identification.
   */
  sensitive: boolean;
}

export const PLATFORM_RULES: PlatformRule[] = [
  // --- Build, source control and deployment ---
  { name: 'Jenkins', signature: /hudson\.model|jenkins-js-|Jenkins-Session|\/static\/[a-f0-9]{8}\/jsbundles\//i, cookie: /^JENKINS_SESSION|^ACEGI_SECURITY/i, header: /jenkins/i, title: /\bjenkins\b/i, sensitive: true },
  { name: 'GitLab', signature: /gon\.gitlab|gitlab-workhorse|\/assets\/webpack\/runtime\./i, cookie: /^_gitlab_session/i, header: /gitlab/i, title: /\bgitlab\b/i, markup: /gitlab-/i, sensitive: true },
  { name: 'Argo CD', signature: /argocd\.argoproj\.io|__ARGO_/i, cookie: /^argocd\./i, title: /\bargo\s?cd\b/i, markup: /argo-cd/i, sensitive: true },
  { name: 'Harbor', signature: /harbor-app|\/api\/v2\.0\/systeminfo/i, cookie: /^harbor[-_]/i, title: /\bharbor\b/i, sensitive: true },
  { name: 'SonarQube', signature: /sonarqube|\/js\/sonar\./i, title: /\bsonarqube\b/i, sensitive: true },
  { name: 'Nexus Repository', signature: /nexus-ui|\/service\/rest\/v1\//i, title: /\bnexus\s?repository\b/i, sensitive: true },

  // --- Databases and data consoles ---
  { name: 'phpMyAdmin', signature: /phpmyadmin\.css|pmahomme|PMA_/i, cookie: /^phpMyAdmin|^pma_/i, title: /\bphpmyadmin\b/i, sensitive: true },
  { name: 'Adminer', signature: /adminer\.(css|js)|adminer\.org/i, cookie: /^adminer_/i, title: /\badminer\b/i, sensitive: true },
  { name: 'pgAdmin', signature: /pgadmin4|\/pgadmin\/static\//i, cookie: /^pga4_session/i, title: /\bpgadmin\b/i, sensitive: true },
  { name: 'MinIO', signature: /minio-console|\/minio\/health/i, header: /minio/i, title: /\bminio\b/i, sensitive: true },
  { name: 'RabbitMQ Management', signature: /rabbitmq_management|\/api\/overview.*rabbit/i, title: /\brabbitmq\b/i, sensitive: true },

  // --- Observability ---
  { name: 'Grafana', signature: /grafanaBootData|grafana-app|\/public\/build\/grafana/i, cookie: /^grafana_session/i, title: /\bgrafana\b/i, sensitive: true },
  { name: 'Kibana', signature: /kbn-injected-metadata|\/bundles\/kbn-ui/i, header: /kbn-name/i, title: /\bkibana\b/i, sensitive: true },
  { name: 'Prometheus', signature: /\/graph\?g0\.expr|prometheus_build_info/i, title: /\bprometheus\b/i, sensitive: true },
  { name: 'Sentry', signature: /sentry-app|\/_static\/dist\/sentry\//i, cookie: /^sentrysid/i, title: /\bsentry\b/i, sensitive: true },
  { name: 'Redash', signature: /redash-|\/static\/dist\/redash/i, title: /\bredash\b/i, sensitive: true },
  { name: 'Metabase', signature: /metabase-bootstrap|\/app\/dist\/app-main/i, cookie: /^metabase\.SESSION/i, title: /\bmetabase\b/i, sensitive: true },
  { name: 'Apache Airflow', signature: /airflow\/static\/|Airflow_/i, title: /\bairflow\b/i, sensitive: true },

  // --- Infrastructure dashboards ---
  { name: 'Portainer', signature: /portainer\.io\/api|ng-app="portainer"/i, title: /\bportainer\b/i, sensitive: true },
  { name: 'Traefik', signature: /traefik-dashboard|\/dashboard\/#\//i, title: /\btraefik\b/i, sensitive: true },
  { name: 'cPanel', signature: /cpanel_jupiter|\/cpsess\d+\//i, cookie: /^cpsession/i, title: /\bcpanel\b/i, sensitive: true },
  { name: 'Nextcloud', signature: /nextcloud|oc_requesttoken/i, cookie: /^nc_session|^oc_session/i, title: /\bnextcloud\b/i, sensitive: true },

  // --- Collaboration ---
  { name: 'Jira', signature: /jira\.webresources|ajs-remote-user|\/s\/[a-z0-9]+\/_\/jira/i, cookie: /^atlassian\.xsrf\.token/i, header: /x-ausername/i, title: /\bjira\b/i, sensitive: true },
  { name: 'Confluence', signature: /confluence\.web\.resources|ajs-page-id/i, title: /\bconfluence\b/i, sensitive: true },
  { name: 'Outlook Web App', signature: /owa\/auth\/|\/owa\/prem\/|OwaPage/i, title: /\boutlook web\b|\bowa\b/i, sensitive: true },

  // --- API documentation ---
  { name: 'Swagger UI', signature: /swagger-ui(\.css|-bundle)|swagger\.json/i, title: /\bswagger\b/i, sensitive: false },

  // --- Content management, not sensitive on its own ---
  { name: 'WordPress', signature: /\/wp-content\/|\/wp-includes\//i, cookie: /^wordpress_|^wp-settings/i, header: /wordpress/i, sensitive: false },
  { name: 'Drupal', signature: /drupal\.js|Drupal\.settings|drupal-settings-json/i, header: /drupal/i, sensitive: false },
  { name: 'Joomla', signature: /\/media\/jui\/|joomla/i, sensitive: false },
  { name: 'Shopify', signature: /cdn\.shopify\.com/i, header: /shopify/i, sensitive: false },
];

export interface PlatformMatch {
  name: string;
  evidence: string;
  strength: PlatformStrength;
  /** True only when the identification is strong *and* the software is sensitive. */
  sensitive: boolean;
}

/**
 * Identifies software from a probe's observations.
 *
 * Strong signals are checked first and, critically, *all* of them are checked
 * before any weak one — a title mentioning GitLab must never win over a cookie
 * proving Grafana. Within each pass the rule order above applies.
 */
export function detectPlatform(input: {
  title: string | null;
  markup: string;
  cookieNames: string[];
  headerBlob: string;
}): PlatformMatch | null {
  // --- Strong: something only this product emits ---
  for (const rule of PLATFORM_RULES) {
    if (!rule.cookie) continue;
    const hit = input.cookieNames.find((name) => rule.cookie?.test(name));
    if (hit) {
      return { name: rule.name, evidence: `cookie named \`${hit}\``, strength: 'strong', sensitive: rule.sensitive };
    }
  }
  for (const rule of PLATFORM_RULES) {
    if (rule.header && input.headerBlob && rule.header.test(input.headerBlob)) {
      return { name: rule.name, evidence: 'a response header naming the software', strength: 'strong', sensitive: rule.sensitive };
    }
  }
  for (const rule of PLATFORM_RULES) {
    if (rule.signature && input.markup && rule.signature.test(input.markup)) {
      return { name: rule.name, evidence: 'a marker from the product\'s own application shell in the returned markup', strength: 'strong', sensitive: rule.sensitive };
    }
  }

  // --- Weak: the response mentions it, which a vendor's own site also does ---
  for (const rule of PLATFORM_RULES) {
    if (rule.title && input.title && rule.title.test(input.title)) {
      return {
        name: rule.name,
        evidence: `the page title "${input.title.slice(0, 80)}", which names the software but does not demonstrate it is running here`,
        strength: 'weak',
        sensitive: false,
      };
    }
  }
  for (const rule of PLATFORM_RULES) {
    if (rule.markup && input.markup && rule.markup.test(input.markup)) {
      return {
        name: rule.name,
        evidence: 'a loose mention in the returned markup, which does not demonstrate the software is running here',
        strength: 'weak',
        sensitive: false,
      };
    }
  }
  return null;
}

/** Whether a platform name is one of the sensitive ones, for callers holding only the name. */
export function isSensitivePlatform(name: string | null): boolean {
  if (!name) return false;
  return PLATFORM_RULES.some((rule) => rule.name === name && rule.sensitive);
}

/* ------------------------------------------------------------------ *
 * Sign-in detection
 * ------------------------------------------------------------------ */

const LOGIN_TITLE = /\b(sign[\s-]?in|log[\s-]?in|login|authenticat|unauthorized|forbidden)\b/i;
const LOGIN_MARKUP = /type=["']password["']|name=["']password["']|<form[^>]+(login|signin|sign-in)/i;
const LOGIN_REDIRECT = /\/(login|signin|sign-in|auth|sso|oauth2|adfs|saml)(\/|\?|$)/i;

/**
 * Whether the response carries the marks of a sign-in requirement.
 *
 * Deliberately generous: a false positive here downgrades a finding, which is
 * the direction an inference should fail in. Calling something "accessible
 * without authentication" when it merely answered 200 is the failure that
 * matters, and this is what prevents it.
 */
export function looksLikeSignIn(input: {
  status: number | null;
  title: string | null;
  markup: string;
  redirectTarget: string | null;
  authType: string | null;
}): boolean {
  if (input.status === 401 || input.status === 403) return true;
  if (input.authType) return true;
  if (input.redirectTarget && LOGIN_REDIRECT.test(input.redirectTarget)) return true;
  if (input.title && LOGIN_TITLE.test(input.title)) return true;
  if (input.markup && LOGIN_MARKUP.test(input.markup)) return true;
  return false;
}

/* ------------------------------------------------------------------ *
 * The probe
 * ------------------------------------------------------------------ */

/**
 * One GET against `https://<host>/`, redirects left unfollowed.
 *
 * This used to be a HEAD that read nothing but the status line. It is a GET
 * now because a status code alone cannot tell an administrative console from a
 * marketing page, and the report was carrying naming inference where it could
 * have carried an observation. The published scanner disclosure at `/scanner`
 * describes this request, and must keep describing it accurately.
 */
export async function probeHost(
  host: string,
  opts: { maxBytes?: number; timeoutMs?: number } = {},
): Promise<HostProbe> {
  const maxBytes = opts.maxBytes ?? SUBDOMAIN_BODY_BYTES;
  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;

  const empty: HostProbe = {
    host,
    status: null,
    timedOut: false,
    redirectTarget: null,
    server: null,
    poweredBy: null,
    generator: null,
    aspNetVersion: null,
    via: null,
    authType: null,
    cookieNames: [],
    title: null,
    platform: null,
    platformEvidence: null,
    platformStrength: null,
    platformSensitive: false,
    looksLikeLogin: false,
    bodyBytes: 0,
  };

  const started = Date.now();
  const res = await safeFetch(
    `https://${host}/`,
    { method: 'GET', redirect: 'manual', headers: { accept: 'text/html,*/*;q=0.8' } },
    timeoutMs,
  );

  if (!res) {
    // Elapsed time is the only thing distinguishing "slow" from "refused"
    // here, and the 200ms slack absorbs timer imprecision.
    return { ...empty, timedOut: Date.now() - started >= timeoutMs - 200 };
  }

  const status = res.status;
  const redirectTarget =
    status >= 300 && status < 400 ? (res.headers.get('location')?.slice(0, 300) ?? null) : null;

  const server = res.headers.get('server')?.slice(0, 120) ?? null;
  const poweredBy = res.headers.get('x-powered-by')?.slice(0, 120) ?? null;
  const generator = res.headers.get('x-generator')?.slice(0, 120) ?? null;
  const aspNetVersion = res.headers.get('x-aspnet-version')?.slice(0, 40) ?? null;
  const via = res.headers.get('via')?.slice(0, 160) ?? null;
  const authType = authSchemeFrom(res.headers);
  const cookieNames = cookieNamesFrom(res.headers);

  // A redirect has no body worth reading, and reading it would mean holding a
  // connection open for a page the target has already said is elsewhere.
  const markup = redirectTarget ? '' : await readCapped(res, maxBytes, timeoutMs);
  const title = markup ? titleOf(markup) : null;

  const headerBlob = [server, poweredBy, generator].filter(Boolean).join(' | ');
  const platform = detectPlatform({ title, markup, cookieNames, headerBlob });

  return {
    host,
    status,
    timedOut: false,
    redirectTarget,
    server,
    poweredBy,
    generator,
    aspNetVersion,
    via,
    authType,
    cookieNames,
    title,
    platform: platform?.name ?? null,
    platformEvidence: platform?.evidence ?? null,
    platformStrength: platform?.strength ?? null,
    platformSensitive: platform?.sensitive === true,
    looksLikeLogin: looksLikeSignIn({ status, title, markup, redirectTarget, authType }),
    bodyBytes: markup.length,
  };
}
