import type { CategoryKey, ScanResult } from '@/lib/types';

/**
 * The closed set of facts a narration is allowed to draw on.
 *
 * Every value here was produced by this scan's own modules. Nothing is
 * collected for this purpose, nothing is derived that the module did not
 * already assert, and nothing from any other scan or any outside source can
 * reach the model. That is the actual anti-hallucination mechanism — the
 * prompt only asks the model to behave, this decides what it is able to say.
 *
 * A note on where these come from, because the obvious guess is wrong.
 * `ScanResult` has no `dns`, `emailSecurity` or `whois` property; it carries
 * `categories: CategoryResult[]`, and each module's machine-readable output
 * sits on `category.facts`. Reading `result.dns?.mxRecords` compiles to
 * `undefined` and would have produced a grounding set of nothing but nulls —
 * which the model would then have narrated around.
 *
 * The keys below are the ones the modules actually emit. They are re-exposed
 * under their own names rather than renamed, so a value in a prompt can be
 * traced to the line of the module that produced it.
 */

/** Facts are `unknown` on the type; narrow to what is safe to serialise. */
type FactValue = string | number | boolean | null;

function scalar(value: unknown): FactValue | undefined {
  if (value === null) return null;
  if (typeof value === 'string') return value.length > 200 ? `${value.slice(0, 199)}…` : value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'boolean') return value;
  return undefined;
}

/** An array becomes its length and a short sample, never the whole list. */
function summarised(value: unknown, sampleSize = 3): FactValue | undefined {
  if (!Array.isArray(value)) return undefined;
  if (value.length === 0) return 'none';
  const sample = value
    .slice(0, sampleSize)
    .map((v) => (typeof v === 'string' ? v : JSON.stringify(v)))
    .join(', ');
  return value.length > sampleSize ? `${value.length} total, including ${sample}` : sample;
}

/**
 * Which facts each category may ground on, and how each is rendered.
 *
 * Kept to a handful per category on purpose. A prompt carrying every fact a
 * module emits buries the two that matter, and long inputs make the model more
 * likely to pick a detail at random and build a sentence around it.
 */
const SELECTORS: Partial<
  Record<CategoryKey, (facts: Record<string, unknown>) => Record<string, FactValue | undefined>>
> = {
  emailSecurity: (f) => ({
    spfQualifier: scalar(f.spfQualifier),
    spfLookups: scalar(f.spfLookups),
    dmarcPolicy: scalar(f.dmarcPolicy),
    dmarcPercentageApplied: scalar(f.dmarcPct),
    dkimSelectorsFound: summarised(f.dkimSelectors),
  }),

  dns: (f) => ({
    nameservers: summarised(f.nameservers),
    mailHosts: summarised(f.mailHosts),
    ipv4Addresses: summarised(f.ipv4),
    ipv6Addresses: summarised(f.ipv6),
    dnssecValidating: scalar(f.dnssec),
    caaIssuers: summarised(f.caa),
  }),

  whois: (f) => ({
    registrar: scalar(f.registrar),
    isEnterpriseRegistrar: scalar(f.enterpriseRegistrar),
    domainCreatedYear: scalar(f.createdYear),
    expiresAt: scalar(f.expiresAt),
    transferLocked: scalar(f.transferLock),
    privacyEnabled: scalar(f.privacyEnabled),
  }),

  subdomains: (f) => ({
    hostnamesDiscovered: scalar(f.discovered),
    hostnamesResponding: scalar(f.live),
    hostnamesNotResponding: scalar(f.dead),
    wildcardCertificates: scalar(f.wildcardCerts),
    flaggedHostnames: summarised(f.flagged),
  }),

  headers: (f) => ({
    contentSecurityPolicy: scalar(f.csp),
    cspIsReportOnly: scalar(f.cspReportOnly),
    strictTransportSecurity: scalar(f.hsts),
    hstsMaxAgeSeconds: scalar(f.hstsMaxAge),
    framingProtected: scalar(f.framingProtected),
    redirectsToHttps: scalar(f.redirectsToHttps),
    serverHeader: scalar(f.server),
  }),

  ssl: (f) => ({
    certificateIssuer: scalar(f.issuer),
    tlsProtocol: scalar(f.protocol),
    cipher: scalar(f.cipher),
    keyBits: scalar(f.keyBits),
    certificateExpiresAt: scalar(f.validTo),
    hostnamesOnCertificate: scalar(f.altNameCount),
    legacyTlsState: scalar(f.legacyTls),
  }),

  exposedPaths: (f) => ({
    pathsProbed: scalar(f.probed),
    pathsAnsweringOpenly: summarised(f.openPaths),
    pathsBehindAuthentication: summarised(f.authPaths),
    pathsBlocked: summarised(f.blockedPaths),
    graphqlIntrospectionOpen: scalar(f.introspectionOpen),
  }),

  cookies: (f) => ({
    cookiesIssuedBeforeSignIn: scalar(f.cookieCount),
    cookiesWithAllProtectiveAttributes: scalar(f.fullySecured),
    cookieNames: summarised(f.names),
  }),

  cors: (f) => ({
    accessControlAllowOrigin: scalar(f.allowOrigin),
    reflectsRequestOrigin: scalar(f.reflects),
    wildcardOrigin: scalar(f.wildcard),
    allowsCredentials: scalar(f.credentials),
    variesOnOrigin: scalar(f.varyOrigin),
  }),

  robotsSecurity: (f) => ({
    securityTxtPublished: scalar(f.securityTxt),
    robotsDisallowRules: scalar(f.robotsDisallowCount),
    sitemapUrlCount: scalar(f.sitemapUrlCount),
    nonProductionUrlsReferenced: summarised(f.nonProductionUrls),
  }),

  technologies: (f) => ({
    technologiesIdentified: summarised(f.technologies, 5),
    versionsPubliclyDisclosed: summarised(f.versionsDisclosed),
    contentDeliveryNetwork: scalar(f.cdn),
    emailProvider: scalar(f.emailProvider),
    hostingProvider: scalar(f.hostingProvider),
    externalCodeSuppliers: summarised(f.externalHosts, 4),
  }),
};

/**
 * Facts for one category, drawn from this result and nowhere else.
 *
 * Returns `{}` when the module did not run, produced no facts, or produced
 * only empty ones — and an empty set is what stops a narration being
 * attempted at all. See `generateNarration`.
 */
export function groundingFactsFor(
  category: string,
  result: Pick<ScanResult, 'categories'>,
): Record<string, FactValue> {
  const select = SELECTORS[category as CategoryKey];
  if (!select) return {};

  const found = result.categories.find((c) => c.key === category);
  // An unavailable module has no observations, so it has nothing to ground on
  // — narrating one would be narrating a failure to look.
  if (!found || found.status !== 'assessed' || !found.facts) return {};

  const selected = select(found.facts as Record<string, unknown>);

  const grounded: Record<string, FactValue> = {};
  for (const [key, value] of Object.entries(selected)) {
    // `undefined` means the module did not report it. It is dropped rather
    // than passed as null, because a null in the prompt reads to the model as
    // an observed absence when it is really an absence of observation.
    if (value !== undefined) grounded[key] = value;
  }

  return grounded;
}
