import type { CategoryDetail, Finding } from '../types';
import { makeFinding, type ModuleOutput, penaltyBreakdown, plural, safeFetch, truncate } from './util';

const KEY = 'exposedPaths' as const;

type PathSeverity = 'critical' | 'medium';

/**
 * How a 200 response is confirmed to be the real resource rather than a page
 * that merely happens to live at that address. Many sites route unknown paths
 * to real content — github.com/backup is a user profile, not a backup
 * directory — so a status code alone is never treated as evidence.
 */
type Signature =
  | { kind: 'pattern'; test: RegExp }
  /** Any interface asking for a password, or a directory listing. */
  | { kind: 'admin-interface' }
  /** Confirmed separately by a protocol-level probe. */
  | { kind: 'graphql' };

interface PathSpec {
  path: string;
  label: string;
  severity: PathSeverity;
  signature: Signature;
  /** What a confirmed match at this path is. */
  whatItIs: string;
  /** What could follow. Conditional voice. */
  whyItMatters: string;
  recommendation: string;
  /** What a correctly configured server would return here. */
  expected: string;
}

const ADMIN_INTERFACE =
  /(type=["']?password|name=["']?password|<title>[^<]*index of |<h1>index of |directory listing for)/i;

/**
 * Standard HTTP requests to well-known paths — the same requests a search
 * engine crawler or vulnerability scanner would make. Nothing is brute forced,
 * no credentials are attempted, and no payloads are sent.
 */
const PATHS: PathSpec[] = [
  {
    path: '/.env',
    label: 'Environment configuration file',
    severity: 'critical',
    signature: { kind: 'pattern', test: /^\s*(?:[A-Z0-9_]+\s*=|#)/m },
    whatItIs:
      'The response body has the shape of a dotenv file — uppercase keys with values, one per line. Files with this name conventionally hold database credentials, API keys and payment secrets.',
    whyItMatters:
      'If the file contains live credentials, anyone who fetched it holds them, and there is no way to know from outside whether anyone already has. Credential material obtained this way requires no exploitation of any kind.',
    recommendation:
      'Remove the file from the web root, block dotfiles at the web server or CDN, then rotate every credential the file contains on the assumption it is already compromised.',
    expected: '404, or 403 if the path is blocked by rule',
  },
  {
    path: '/.git/HEAD',
    label: 'Git repository metadata',
    severity: 'critical',
    signature: { kind: 'pattern', test: /^(ref:\s*refs\/|[0-9a-f]{40})/m },
    whatItIs:
      'The response is a Git HEAD file — either a symbolic ref or a 40-character commit hash. Its presence indicates the .git directory was deployed alongside the application.',
    whyItMatters:
      'Where the whole directory is readable, the full commit history can be reconstructed, including any secret that was ever committed and later removed. Klyro fetched only this one file and did not attempt to reconstruct anything.',
    recommendation:
      'Block .git at the web server or CDN, exclude it from the deployment artefact, and rotate any secret that appears anywhere in the repository history.',
    expected: '404, or 403 if the path is blocked by rule',
  },
  {
    path: '/.git/config',
    label: 'Git repository configuration',
    severity: 'critical',
    signature: { kind: 'pattern', test: /\[(core|remote|branch)[\s\]]/i },
    whatItIs:
      'The response is a Git config file, containing at least one of the core, remote or branch sections.',
    whyItMatters:
      'Git config files name internal repository URLs and occasionally embed access tokens in the remote URL. As with the HEAD file, its readability suggests the rest of the directory is readable too.',
    recommendation: 'Block .git at the web server and exclude version control directories from deployments.',
    expected: '404, or 403 if the path is blocked by rule',
  },
  {
    path: '/wp-admin/',
    label: 'WordPress administration',
    severity: 'critical',
    signature: { kind: 'pattern', test: /(wp-login|wp-includes|wp-content|wordpress)/i },
    whatItIs: 'The response references WordPress internals, so a WordPress administration area is reachable at this path.',
    whyItMatters:
      'WordPress login pages receive continuous automated credential-guessing traffic regardless of the site. Reachability is expected for a WordPress site; what matters is whether rate limiting and multi-factor authentication are in place, neither of which is visible from outside.',
    recommendation:
      'Restrict the admin path by IP or VPN where practical, enforce two-factor authentication, and put a rate limiter in front of the login endpoint.',
    expected: 'A restricted path, or 403 from an edge rule',
  },
  {
    path: '/administrator/',
    label: 'Administrator console',
    severity: 'critical',
    signature: { kind: 'admin-interface' },
    whatItIs: 'The response contains a password field or a directory listing at a path conventionally used for an administrative console.',
    whyItMatters:
      'A publicly reachable administrative login is a fixed target for credential stuffing using passwords leaked elsewhere. Klyro attempted no credentials and cannot say whether the login is rate limited or protected by a second factor.',
    recommendation: 'Move administrative interfaces behind a VPN or IP allow-list and require two-factor authentication.',
    expected: '404, 403, or a login behind network restriction',
  },
  {
    path: '/admin',
    label: 'Admin interface',
    severity: 'critical',
    signature: { kind: 'admin-interface' },
    whatItIs: 'The response contains a password field or a directory listing at /admin.',
    whyItMatters:
      'The same considerations as any exposed administrative login: it is a fixed target, and the controls that make it safe are not observable from outside.',
    recommendation: 'Restrict by network where practical, enforce two-factor authentication, and alert on repeated failed logins.',
    expected: '404, 403, or a login behind network restriction',
  },
  {
    path: '/phpmyadmin/',
    label: 'phpMyAdmin database console',
    severity: 'critical',
    signature: { kind: 'pattern', test: /phpmyadmin/i },
    whatItIs: 'The response identifies itself as phpMyAdmin, a browser-based database administration tool.',
    whyItMatters:
      'Database tooling reachable from the internet is a direct path to the data if credentials are guessed, defaults remain, or a vulnerability in the tool is found. Historic phpMyAdmin vulnerabilities are among the most heavily scanned for on the web.',
    recommendation: 'Remove the tool from public hosting or restrict it to a management network. Database tooling should not be internet-facing.',
    expected: '404, or reachable only from a management network',
  },
  {
    path: '/adminer.php',
    label: 'Adminer database console',
    severity: 'critical',
    signature: { kind: 'pattern', test: /adminer/i },
    whatItIs: 'The response identifies itself as Adminer, a single-file database management tool.',
    whyItMatters:
      'Adminer is normally uploaded temporarily during a migration and forgotten. It accepts arbitrary database hosts, so it can be used against internal databases from the outside if it is reachable.',
    recommendation: 'Delete the file from the server. It is a deployment convenience that should never reach production.',
    expected: '404',
  },
  {
    path: '/cpanel',
    label: 'Hosting control panel',
    severity: 'critical',
    signature: { kind: 'pattern', test: /cpanel/i },
    whatItIs: 'The response identifies a cPanel hosting control panel at this address.',
    whyItMatters:
      'A hosting control panel administers every site, mailbox and backup on the server. A compromise of it is a compromise of everything hosted alongside.',
    recommendation: 'Restrict control panel access to known addresses and enable two-factor authentication with the hosting provider.',
    expected: '404, or reachable only from known addresses',
  },
  {
    path: '/backup',
    label: 'Backup directory',
    severity: 'critical',
    signature: { kind: 'admin-interface' },
    whatItIs: 'The response is a directory listing at a path conventionally used for backups.',
    whyItMatters:
      'Backup archives typically contain a full copy of the database and configuration, credentials included. A browsable listing removes the need to guess file names. Klyro listed the directory only and downloaded nothing.',
    recommendation: 'Remove backups from anywhere reachable by a browser and store them in access-controlled object storage.',
    expected: '404 or 403',
  },
  {
    path: '/dump.sql',
    label: 'Database export',
    severity: 'critical',
    signature: { kind: 'pattern', test: /(CREATE TABLE|INSERT INTO|DROP TABLE|mysqldump)/i },
    whatItIs: 'The response body contains SQL data definition or insertion statements, consistent with a database export.',
    whyItMatters:
      'A database export served over HTTP hands over the records it contains in a single request, with no authentication and no exploitation.',
    recommendation: 'Delete the file from the web root and check access logs to establish whether it has already been retrieved.',
    expected: '404',
  },
  {
    path: '/web.config',
    label: 'IIS configuration file',
    severity: 'critical',
    signature: { kind: 'pattern', test: /<configuration[\s>]|<system\.webServer/i },
    whatItIs: 'The response is an IIS web.config XML document.',
    whyItMatters:
      'web.config commonly contains connection strings, machine keys and application settings. IIS normally refuses to serve it, so a readable copy suggests it is being served by something other than the IIS handler pipeline.',
    recommendation: 'Block the file at the web server, and rotate any connection string or machine key it contains.',
    expected: '404 or 403 — IIS refuses this by default',
  },
  {
    path: '/actuator',
    label: 'Spring Boot Actuator',
    severity: 'medium',
    signature: { kind: 'pattern', test: /"_links"\s*:|"(health|metrics|env|beans|mappings)"\s*:/i },
    whatItIs:
      'The response is a Spring Boot Actuator endpoint index, listing the management endpoints the application exposes.',
    whyItMatters:
      'The index names which management endpoints are enabled. Where /env or /heapdump are among them, configuration values and memory contents can be readable; Klyro requested neither and is not claiming they are exposed.',
    recommendation:
      'Restrict the Actuator base path to a management port or an internal network, and expose only the health endpoint publicly.',
    expected: '404, or Actuator bound to a management port',
  },
  {
    path: '/server-status',
    label: 'Apache status page',
    severity: 'medium',
    signature: { kind: 'pattern', test: /(apache server status|server uptime|requests currently being processed)/i },
    whatItIs: 'The response is an Apache mod_status page showing live request activity.',
    whyItMatters:
      'The page lists URLs being requested in real time, including internal paths and any identifiers carried in query strings. It exposes traffic rather than data, but does so continuously.',
    recommendation: 'Restrict /server-status to localhost in the Apache configuration.',
    expected: '404, or restricted to localhost',
  },
  {
    path: '/server-info',
    label: 'Apache configuration page',
    severity: 'medium',
    signature: { kind: 'pattern', test: /(apache server information|server settings|loaded modules)/i },
    whatItIs: 'The response is an Apache mod_info page describing the server configuration and loaded modules.',
    whyItMatters:
      'It publishes the exact module set and configuration, which shortens the work of identifying which known issues apply to this server. It does not itself grant access to anything.',
    recommendation: 'Disable mod_info, or restrict /server-info to localhost.',
    expected: '404, or restricted to localhost',
  },
  {
    path: '/swagger.json',
    label: 'OpenAPI specification',
    severity: 'medium',
    signature: { kind: 'pattern', test: /"(swagger|openapi)"\s*:/i },
    whatItIs: 'The response is a JSON document declaring a swagger or openapi version field.',
    whyItMatters:
      'The specification documents every endpoint, parameter and operation, including any not linked from the product. For a deliberately public API this is the intended behaviour; for an internal one it removes the reconnaissance step entirely.',
    recommendation: 'Require authentication for the specification of a non-public API, or publish it only on an internal developer portal.',
    expected: '404 for a non-public API',
  },
  {
    path: '/openapi.yaml',
    label: 'OpenAPI specification',
    severity: 'medium',
    signature: { kind: 'pattern', test: /^\s*(openapi|swagger)\s*:/im },
    whatItIs: 'The response is a YAML document beginning with an openapi or swagger key.',
    whyItMatters:
      'As above: a complete machine-readable description of the API surface, including endpoints not referenced anywhere in the product.',
    recommendation: 'Restrict the specification to authenticated developers or an internal portal.',
    expected: '404 for a non-public API',
  },
  {
    path: '/api-docs',
    label: 'API documentation portal',
    severity: 'medium',
    signature: { kind: 'pattern', test: /(swagger-ui|redoc|openapi|graphiql|api documentation)/i },
    whatItIs: 'The response is an interactive API documentation portal — Swagger UI, ReDoc or GraphiQL.',
    whyItMatters:
      'These portals usually include a console that issues requests against the live API from the browser. Where the API requires authentication, the console is only as useful as the credentials the reader has.',
    recommendation: 'Place documentation portals behind authentication in production.',
    expected: '404 in production for a non-public API',
  },
  {
    path: '/graphql',
    label: 'GraphQL endpoint',
    severity: 'medium',
    signature: { kind: 'graphql' },
    whatItIs: 'A POST carrying a GraphQL query returned a JSON response with a data or errors field, which is how a GraphQL server responds.',
    whyItMatters:
      'GraphQL endpoints frequently permit broader queries than the product interface issues, because authorisation is enforced per resolver and gaps are easy to leave. Klyro sent one introspection query and no data query.',
    recommendation:
      'Disable introspection in production, enforce query depth and cost limits, and confirm per-field authorisation rather than relying on schema obscurity.',
    expected: 'A GraphQL endpoint is fine to expose; introspection is what should be disabled',
  },
  {
    path: '/debug',
    label: 'Debug interface',
    severity: 'medium',
    signature: {
      kind: 'pattern',
      test: /(debug (console|toolbar|mode)|stack trace|traceback \(most recent|whoops|werkzeug)/i,
    },
    whatItIs: 'The response contains a debug console, a stack trace, or the signature of a development error handler.',
    whyItMatters:
      'Debug handlers reveal file paths, configuration and framework versions, and some — the Werkzeug console in particular — expose an interactive evaluator. Klyro identified the handler and did not interact with it.',
    recommendation: 'Disable debug mode in production builds and confirm the production configuration flag is actually being read.',
    expected: '404, and debug mode off in production',
  },
  {
    path: '/elmah.axd',
    label: 'ELMAH error log viewer',
    severity: 'medium',
    signature: { kind: 'pattern', test: /(elmah|error log for)/i },
    whatItIs: 'The response is an ELMAH error log viewer.',
    whyItMatters:
      'Application error logs routinely contain internal URLs, database queries and, where an error occurred mid-session, tokens belonging to real users.',
    recommendation: 'Restrict the handler to administrators or remove it from production deployments.',
    expected: '404 or 403',
  },
];

/**
 * The probe list, for the disclosure page at /scanner.
 *
 * Derived from `PATHS` rather than retyped, so an operator reading the
 * published list is reading the list the scanner actually requests. A path
 * added to the check appears on the page in the same commit.
 */
export const PROBE_MANIFEST: ReadonlyArray<{ path: string; label: string; expected: string }> =
  PATHS.map(({ path, label, expected }) => ({ path, label, expected }));

/** Statuses that indicate the resource might exist. */
function candidateStatus(status: number): boolean {
  return status === 200 || status === 401 || status === 403 || status === 301 || status === 302;
}

/** Reads a bounded amount of the body; returns '' for anything oversized. */
async function readBody(res: Response): Promise<string> {
  const length = Number(res.headers.get('content-length') ?? '0');
  if (length > 2_000_000) return '';
  try {
    const text = await res.text();
    return text.slice(0, 200_000);
  } catch {
    return '';
  }
}

export async function checkExposedPaths(domain: string): Promise<ModuleOutput> {
  const findings: Finding[] = [];
  const details: CategoryDetail[] = [];

  const base = `https://${domain}`;

  // Calibration: some sites answer 200 for every path (SPA catch-all routing or
  // a soft-404 page). Probe two random paths first so we do not report the
  // entire list as exposed on those sites.
  const nonce = Math.random().toString(36).slice(2, 10);
  const [calibrationA, calibrationB] = await Promise.all([
    safeFetch(`${base}/klyro-probe-${nonce}`, { method: 'HEAD', redirect: 'manual' }, 8_000),
    safeFetch(`${base}/klyro-probe-${nonce}/deep/path`, { method: 'HEAD', redirect: 'manual' }, 8_000),
  ]);

  if (!calibrationA && !calibrationB) {
    throw new Error('The site did not respond to HTTP requests.');
  }

  const catchAllStatuses = new Set(
    [calibrationA?.status, calibrationB?.status].filter(
      (s): s is number => typeof s === 'number' && candidateStatus(s),
    ),
  );
  const isCatchAll = catchAllStatuses.size > 0;

  /* -------- Pass 1: cheap HEAD probe of every path -------- */

  const probes = await Promise.all(
    PATHS.map(async (spec) => {
      const res = await safeFetch(`${base}${spec.path}`, { method: 'HEAD', redirect: 'manual' }, 8_000);
      return { spec, status: res?.status ?? 0 };
    }),
  );

  const statusCounts = new Map<number, number>();
  for (const { status } of probes) {
    statusCounts.set(status, (statusCounts.get(status) ?? 0) + 1);
  }

  const candidates = probes.filter(
    ({ status }) => candidateStatus(status) && !(isCatchAll && catchAllStatuses.has(status)),
  );

  /**
   * When a large share of these paths answer, the site is almost certainly
   * serving user-controlled names from its root namespace — a code host, a
   * wiki, a social platform. github.com/phpmyadmin is the phpMyAdmin project's
   * profile page, not a database console, and it will match a content
   * signature honestly. Findings are still reported, but at reduced severity
   * and confidence, with the ambiguity stated.
   */
  const contentPlatform = candidates.length >= 7;

  /* -------- Pass 2: confirm each candidate is genuinely that resource -------- */

  interface Confirmed {
    spec: PathSpec;
    status: number;
    /**
     * open          — served to anyone, content signature matched
     * auth-required — exists behind credentials (401)
     * blocked       — access denied (403), which is the desired configuration
     */
    kind: 'open' | 'auth-required' | 'blocked';
    /** A short, safe excerpt of what confirmed it. */
    excerpt?: string;
  }

  const confirmed: Confirmed[] = [];
  let introspectionOpen = false;
  let discountedRedirects = 0;
  let discountedContent = 0;

  await Promise.all(
    candidates.map(async ({ spec, status }) => {
      // 401 and 403 both prove something exists, but they mean opposite things.
      // 401 is a login prompt an attacker can attack; 403 is the server
      // refusing outright, which is exactly how a blocked .env should behave.
      if (status === 401 || status === 403) {
        confirmed.push({
          spec,
          status,
          kind: status === 401 ? 'auth-required' : 'blocked',
        });
        return;
      }

      if (spec.signature.kind === 'graphql') {
        const res = await safeFetch(
          `${base}${spec.path}`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ query: '{__schema{types{name}}}' }),
            redirect: 'follow',
          },
          8_000,
        );
        if (!res) return;

        const contentType = res.headers.get('content-type') ?? '';
        if (!contentType.includes('json')) return;

        try {
          const payload = (await res.json()) as {
            data?: { __schema?: { types?: unknown[] } };
            errors?: unknown[];
          };
          const isGraphql = 'data' in payload || Array.isArray(payload.errors);
          if (!isGraphql) return;

          introspectionOpen = Array.isArray(payload.data?.__schema?.types);
          confirmed.push({
            spec,
            status,
            kind: 'open',
            excerpt: introspectionOpen
              ? `introspection returned ${payload.data?.__schema?.types?.length ?? 0} types`
              : 'responded in GraphQL format; introspection disabled',
          });
        } catch {
          /* not a GraphQL endpoint */
        }
        return;
      }

      const res = await safeFetch(`${base}${spec.path}`, { method: 'GET', redirect: 'follow' }, 8_000);
      if (!res || !res.ok) return;

      /*
       * Where the redirect landed decides whether the body is evidence.
       *
       * `/admin` → `/admin/login` is the resource; `/admin` → `/` is the site
       * bouncing an unknown path to the homepage, and if that homepage carries
       * a sign-in form it matches the admin-interface signature and reports a
       * console that does not exist. Same for a hop to another host, where the
       * body belongs to somebody else entirely.
       */
      const landing = (() => {
        try {
          return new URL(res.url);
        } catch {
          return null;
        }
      })();

      if (landing) {
        const bouncedToRoot = landing.pathname === '/' || landing.pathname === '';
        const bouncedOffHost = landing.hostname !== domain && landing.hostname !== `www.${domain}`;
        if (bouncedToRoot || bouncedOffHost) {
          discountedRedirects += 1;
          return;
        }
      }

      const body = await readBody(res);
      if (!body) {
        discountedContent += 1;
        return;
      }

      const matched =
        spec.signature.kind === 'admin-interface'
          ? ADMIN_INTERFACE.test(body)
          : spec.signature.test.test(body);

      if (matched) {
        const excerpt =
          spec.signature.kind === 'admin-interface'
            ? 'response contains a password input or a directory listing header'
            : truncate((spec.signature.test.exec(body)?.[0] ?? '').replace(/\s+/g, ' ').trim(), 80);
        confirmed.push({ spec, status, kind: 'open', excerpt });
      } else {
        discountedContent += 1;
      }
    }),
  );

  /* -------- Findings -------- */

  const openPaths = confirmed.filter((c) => c.kind === 'open');
  const authPaths = confirmed.filter((c) => c.kind === 'auth-required');
  const blockedPaths = confirmed.filter((c) => c.kind === 'blocked');

  for (const { spec, status, excerpt } of openPaths) {
    const severity: Finding['severity'] = contentPlatform
      ? spec.severity === 'critical'
        ? 'medium'
        : 'low'
      : spec.severity === 'critical'
        ? 'high'
        : 'medium';

    findings.push(
      makeFinding(KEY, {
        title: `${spec.label} responds at ${spec.path}`,
        severity,
        confidence: contentPlatform ? 'low' : 'high',
        asset: `${base}${spec.path}`,
        observed: `GET ${base}${spec.path} returned ${status} and the body matched the content signature for ${spec.label.toLowerCase()}${excerpt ? ` (\`${excerpt}\`)` : ''}.`,
        interpretation: contentPlatform
          ? `${spec.whatItIs} This site also answers for randomly chosen root-level paths, which means it serves content under names its users choose. The match may therefore be a page or profile that happens to contain matching text rather than the resource itself.`
          : spec.whatItIs,
        risk: contentPlatform
          ? `${spec.whyItMatters} Confirm what this address actually serves before acting on any of that.`
          : spec.whyItMatters,
        recommendation: contentPlatform
          ? `Open ${spec.path} and confirm what it serves. If it is genuinely ${spec.label.toLowerCase()}: ${spec.recommendation.charAt(0).toLowerCase()}${spec.recommendation.slice(1)}`
          : spec.recommendation,
        evidence: {
          test: `HEAD ${base}${spec.path}, then GET on a candidate status, with the body matched against a content signature`,
          observed: `${status}${excerpt ? `; matched: ${excerpt}` : ''}`,
          expected: spec.expected,
          verification: `Two randomly generated paths were probed first to calibrate against catch-all routing (result: ${isCatchAll ? `site answers ${[...catchAllStatuses].join('/')} for unknown paths` : 'site returns 404 for unknown paths'}). A redirect landing on the site root or another host discounts the body as evidence.`,
          limitation:
            'Klyro read the response only. It sent no credentials, attempted no bypass, and did not download or enumerate anything beyond this single path.',
        },
        scoreImpact: contentPlatform ? (spec.severity === 'critical' ? 7 : 4) : spec.severity === 'critical' ? 15 : 10,
      }),
    );
  }

  for (const { spec, status } of authPaths) {
    findings.push(
      makeFinding(KEY, {
        title: `${spec.label} exists behind authentication at ${spec.path}`,
        severity: 'low',
        confidence: 'high',
        asset: `${base}${spec.path}`,
        observed: `A request to ${base}${spec.path} returned ${status}, which requires credentials rather than denying the request outright.`,
        interpretation:
          'The resource exists and the server is enforcing authentication on it. That is the intended configuration — the observation here is that its existence is confirmed to anyone who asks.',
        risk:
          'A 401 confirms the endpoint is there and is worth trying credentials against, which is what distinguishes it from a 403 or 404. The practical exposure depends on whether the login is rate limited and whether a second factor is required, neither of which Klyro tested.',
        recommendation: spec.recommendation,
        evidence: {
          test: `HEAD ${base}${spec.path}`,
          observed: `${status} — credentials required`,
          expected: '403 or 404, where the endpoint does not need to be publicly discoverable',
          verification: 'The status code alone establishes this; no body was read and no credentials were sent.',
          limitation: 'Klyro attempted no authentication, so nothing is known about the strength of the controls behind it.',
        },
        scoreImpact: 4,
      }),
    );
  }

  // A 403 means the server refused the request outright. For paths like /.env
  // and /.git that is precisely the configuration you want, so it is recorded
  // as a positive observation rather than counted as exposure.
  if (blockedPaths.length > 0) {
    findings.push(
      makeFinding(KEY, {
        title: 'Sensitive paths are refused by the server',
        severity: 'info',
        confidence: 'high',
        asset: domain,
        observed: `${plural(blockedPaths.length, 'path')} returned 403: ${blockedPaths.map((c) => c.spec.path).join(', ')}.`,
        interpretation:
          'The server or its edge refuses these requests outright rather than serving them or returning a generic 404. For dotfiles and version control directories this is the recommended configuration.',
        risk: 'None. This is recorded as a positive observation.',
        recommendation:
          'No action required. Confirm these rules are part of the standard server configuration so new deployments inherit them rather than being added case by case.',
        evidence: {
          test: 'HEAD against each path in the list',
          observed: blockedPaths.map((c) => `${c.spec.path} → 403`).join(', '),
          expected: '403 or 404',
          verification: 'Status codes read directly; no body was requested.',
        },
      }),
    );
  }

  if (contentPlatform) {
    findings.push(
      makeFinding(KEY, {
        title: 'Site serves content under arbitrary root-level names',
        severity: 'info',
        confidence: 'high',
        asset: domain,
        observed: `${candidates.length} of ${PATHS.length} probed paths returned a status suggesting the resource might exist, after discounting the site's catch-all behaviour.`,
        interpretation:
          'That proportion is the signature of a platform where users or editors choose their own URLs — a code host, a wiki, a social network — rather than a server with many exposed tools.',
        risk:
          'None from this observation. It is recorded because it materially changes how the findings above should be read, and it is why they are reported at reduced severity and low confidence.',
        recommendation:
          'No action for this observation itself. Review the individual paths above to establish which, if any, are real administrative interfaces.',
        evidence: {
          test: `HEAD against ${PATHS.length} well-known paths`,
          observed: `${candidates.length} responded`,
          verification: 'Two randomly generated paths were probed first; their statuses were excluded from the candidate set.',
        },
      }),
    );
  }

  if (introspectionOpen) {
    findings.push(
      makeFinding(KEY, {
        title: 'GraphQL introspection is enabled',
        severity: 'medium',
        confidence: 'high',
        asset: `${base}/graphql`,
        observed: `A POST of \`{__schema{types{name}}}\` to ${base}/graphql returned a populated __schema object.`,
        interpretation:
          'The endpoint will describe its own schema to an unauthenticated caller: every type, field and operation it supports, including any the product interface never calls.',
        risk:
          'Introspection removes the need to guess at the API surface, so any authorisation gap in a resolver is found faster. It is not itself an authorisation flaw — a correctly authorised API is not compromised by publishing its schema, and several major public APIs enable introspection deliberately.',
        recommendation:
          'Disable introspection in production if the API is not intended to be public, and pair that with per-field authorisation so schema obscurity is not the control being relied on.',
        evidence: {
          test: `POST ${base}/graphql with a minimal introspection query`,
          observed: 'A JSON response containing a populated __schema.types array',
          expected: 'An error response, for a non-public API in production',
          verification: 'The response content type was confirmed as JSON and parsed before this was reported.',
          limitation:
            'Klyro issued no data query and did not test whether any field is inadequately authorised.',
        },
        scoreImpact: 10,
      }),
    );
  }

  /* -------- Details -------- */

  const criticalCount = openPaths.filter((c) => c.spec.severity === 'critical').length;
  const mediumCount = openPaths.length - criticalCount;
  const exposedCount = openPaths.length + authPaths.length;

  const statusSummary = [...statusCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([status, count]) => `${status === 0 ? 'no response' : status} × ${count}`)
    .join(', ');

  details.push(
    { label: 'Paths probed', value: String(PATHS.length), mono: true },
    { label: 'Status codes returned', value: statusSummary, mono: true },
    {
      label: 'Candidates after calibration',
      value: candidates.length ? plural(candidates.length, 'path') : 'None',
      mono: true,
    },
    {
      label: 'Content-confirmed as open',
      value: openPaths.length
        ? openPaths.map((c) => `${c.spec.path} (${c.status})`).join(', ')
        : 'None',
      mono: true,
      tone: openPaths.length ? 'bad' : 'good',
    },
    {
      label: 'Behind authentication (401)',
      value: authPaths.length ? authPaths.map((c) => c.spec.path).join(', ') : 'None',
      mono: true,
      tone: authPaths.length ? 'warn' : 'good',
    },
    {
      label: 'Refused by the server (403)',
      value: blockedPaths.length ? blockedPaths.map((c) => c.spec.path).join(', ') : 'None',
      mono: true,
      tone: blockedPaths.length ? 'good' : 'neutral',
    },
    {
      label: 'Discounted after verification',
      value:
        discountedRedirects + discountedContent > 0
          ? `${discountedRedirects} redirected away from the requested path, ${discountedContent} did not match the content signature`
          : 'None — every responding path was content-verified',
      tone: 'neutral',
    },
    {
      label: 'GraphQL introspection',
      value: introspectionOpen
        ? 'Enabled — the schema is readable without authentication'
        : openPaths.some((c) => c.spec.signature.kind === 'graphql')
          ? 'Endpoint present, introspection disabled'
          : 'No GraphQL endpoint found at /graphql',
      tone: introspectionOpen ? 'warn' : 'good',
    },
    {
      label: 'Unknown-path calibration',
      value: isCatchAll
        ? `Site answers ${[...catchAllStatuses].join('/')} for randomly generated paths — those statuses were excluded from the candidate set`
        : 'Site returns 404 for randomly generated paths',
      tone: isCatchAll ? 'neutral' : 'good',
    },
    {
      label: 'Namespace',
      value: contentPlatform
        ? 'Serves user-named content from the root — findings reported at reduced severity and low confidence'
        : 'Standard application namespace',
      tone: contentPlatform ? 'neutral' : 'good',
    },
    {
      label: 'Scope of this check',
      value: `${PATHS.length} well-known paths on the apex host only. No enumeration, no credentials, no payloads, and no state-changing requests. Subdomains were not probed.`,
      tone: 'neutral',
    },
  );

  /* -------- Score -------- */

  const criticalPenalty = contentPlatform ? 7 : 15;
  const mediumPenalty = contentPlatform ? 4 : 10;

  const penalties: { label: string; points: number; note: string }[] = [];
  if (criticalCount > 0) {
    penalties.push({
      label: 'High-impact paths content-confirmed as open',
      points: criticalCount * criticalPenalty,
      note: `${criticalCount} × ${criticalPenalty} points${contentPlatform ? ' (reduced rate — this site serves user-named content from its root)' : ''}.`,
    });
  }
  if (mediumCount > 0) {
    penalties.push({
      label: 'Informational endpoints content-confirmed as open',
      points: mediumCount * mediumPenalty,
      note: `${mediumCount} × ${mediumPenalty} points${contentPlatform ? ' (reduced rate)' : ''}.`,
    });
  }
  if (authPaths.length > 0) {
    penalties.push({
      label: 'Endpoints confirmed to exist behind authentication',
      points: authPaths.length * 4,
      note: `${authPaths.length} × 4 points. Charged lightly: a 401 confirms existence but the control is working.`,
    });
  }
  if (introspectionOpen) {
    penalties.push({
      label: 'GraphQL introspection enabled',
      points: 10,
      note: 'The schema is readable without authentication.',
    });
  }

  const totalPenalty = penalties.reduce((sum, p) => sum + p.points, 0);
  const score = Math.max(0, 100 - totalPenalty);

  const summary =
    exposedCount === 0
      ? blockedPaths.length > 0
        ? `No sensitive paths were content-confirmed as reachable, and ${plural(blockedPaths.length, 'sensitive address is', 'sensitive addresses are')} actively refused by the server.`
        : 'No sensitive administrative or developer paths were content-confirmed as reachable on the apex host.'
      : contentPlatform
        ? `${plural(exposedCount, 'address', 'addresses')} matched an administrative tool signature, but this site serves user-named content from its root, so each needs manual confirmation.`
        : `${plural(openPaths.length, 'path')} content-confirmed as openly served${authPaths.length ? `, and ${authPaths.length} confirmed to exist behind authentication` : ''}.`;

  const facts = {
    probed: PATHS.length,
    openPaths: openPaths.map((c) => c.spec.path),
    authPaths: authPaths.map((c) => c.spec.path),
    blockedPaths: blockedPaths.map((c) => c.spec.path),
    introspectionOpen,
    contentPlatform,
  };

  return {
    score,
    summary,
    findings,
    details,
    scoreBreakdown: penaltyBreakdown(100, penalties),
    facts,
  };
}
