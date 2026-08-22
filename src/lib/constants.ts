import type { CategoryKey } from './types';

export const TOOL_VERSION = '1.8.0';

export const INDUSTRIES = [
  'Banking & Finance',
  'Insurance',
  'Real Estate',
  'Retail & E-commerce',
  'Healthcare',
  'Education',
  'Government',
  'Telecom',
  'Oil & Gas',
  'Logistics & Transport',
  'Hospitality & Tourism',
  'Technology',
  'Construction',
  'Manufacturing',
  'Media & Entertainment',
  'Legal Services',
  'Automotive',
  'Food & Beverage',
] as const;

export const REGIONS = ['UAE', 'Saudi Arabia', 'GCC', 'Middle East', 'Global'] as const;

export type Industry = (typeof INDUSTRIES)[number];
export type Region = (typeof REGIONS)[number];

/**
 * Weights sum to 1. Rebalanced when the technology category was added — every
 * other weight gave up a little rather than the new one being bolted on top,
 * which would have quietly rescaled every historical score by a different
 * factor depending on which modules happened to answer.
 *
 * Scores from before the rebalance are not directly comparable to scores after
 * it. That is stated rather than hidden: `toolVersion` is recorded on every
 * assessment, and the comparison view reads it.
 */
/*
 * The eleven original weights multiplied by 0.92, plus 0.08 for the twelfth.
 * Written out rather than computed so the table can be read and checked; the
 * set sums to 1.0 and `tests/vault-dial.test.ts` asserts that it still does.
 */
export const CATEGORY_WEIGHTS: Record<CategoryKey, number> = {
  dns: 0.092,
  subdomains: 0.1104,
  ssl: 0.1196,
  headers: 0.1104,
  emailSecurity: 0.1196,
  whois: 0.0552,
  exposedPaths: 0.092,
  cookies: 0.046,
  cors: 0.046,
  robotsSecurity: 0.0368,
  technologies: 0.092,
  internetdb: 0.08,
};

export const CATEGORY_LABELS: Record<CategoryKey, string> = {
  dns: 'DNS Configuration',
  subdomains: 'Subdomain Exposure',
  ssl: 'SSL/TLS Certificate',
  headers: 'HTTP Security Headers',
  emailSecurity: 'Email Security',
  whois: 'Domain Registration',
  exposedPaths: 'Exposed Paths',
  cookies: 'Cookie Security',
  cors: 'CORS Policy',
  robotsSecurity: 'Robots & Security.txt',
  technologies: 'Technology Profile',
  internetdb: 'Network Exposure',
};

/**
 * Short, non-technical description of what each module looks at.
 *
 * Written in the third person throughout, and that is deliberate. Klyro is
 * used far more often to assess a supplier than to assess the reader's own
 * estate, and copy that says "your email can be spoofed" about a vendor under
 * evaluation is simply wrong. The one place second person is correct is the
 * buyer-context panel, where "you" means the reader's own organisation because
 * they supplied its domain.
 */
export const CATEGORY_BLURBS: Record<CategoryKey, string> = {
  dns: 'How the domain name is published, and whether its records are protected against tampering.',
  subdomains: 'Public host names attached to the domain, and how much of the estate they reveal.',
  ssl: 'The certificate that encrypts traffic between visitors and the website.',
  headers: 'Browser-level protections the site instructs visitors to enforce.',
  emailSecurity: 'Whether an outsider can send email that appears to come from this domain.',
  whois: 'Who holds the domain, when it expires, and how much of that is public.',
  exposedPaths: 'Administrative and developer paths that answer to anyone on the internet.',
  cookies: 'Whether the cookies the site issues before sign-in carry their protective attributes.',
  cors: 'Which other websites the site permits to read its responses.',
  robotsSecurity: 'Public metadata files that either help researchers report issues or reveal internals.',
  technologies: 'The software the site declares it runs on, and the outside companies whose code it loads.',
  internetdb:
    'What a public internet-wide scanning database already records about the domain’s address.',
};

export const CATEGORY_ORDER: CategoryKey[] = [
  'emailSecurity',
  'ssl',
  'dns',
  'headers',
  'subdomains',
  'exposedPaths',
  'whois',
  'cookies',
  'cors',
  'robotsSecurity',
  // Last in the order deliberately: it reads the homepage that several earlier
  // modules have already fetched, so running it late keeps its request off the
  // front of the scan where the wall-clock budget is tightest.
  'technologies',
  // Last, and the only module that measures nothing: it reads a third party's
  // record rather than the domain. Placing it at the end keeps the reader's
  // path through the report going from what Klyro observed to what somebody
  // else observed, which is the order the two deserve.
  'internetdb',
];

/** Shorter labels for the radar chart, which has very little room per axis. */
export const CATEGORY_SHORT_LABELS: Record<CategoryKey, string> = {
  dns: 'DNS',
  subdomains: 'Subdomains',
  ssl: 'SSL/TLS',
  headers: 'Headers',
  emailSecurity: 'Email',
  whois: 'Registration',
  exposedPaths: 'Exposed Paths',
  cookies: 'Cookies',
  cors: 'CORS',
  robotsSecurity: 'Robots',
  technologies: 'Technology',
  internetdb: 'Exposure',
};

/**
 * Screen colours, as references rather than values.
 *
 * These are set on inline styles and on SVG presentation attributes, both of
 * which resolve `var()` — so a component that writes `fill={COLORS.good}` now
 * follows the theme without any of them having to know a theme exists. That is
 * the whole trick behind the light mode: the ~40 inline colour assignments
 * scattered through the dashboard did not need to be rewritten, only
 * redirected.
 *
 * The PDF deliberately does not import any of this. It carries its own fixed
 * palette in `src/pdf/ReportTemplate.tsx`, because a printed artifact has no
 * mode to follow, and `var()` would resolve to nothing in the renderer.
 */
export const COLORS = {
  bg: 'rgb(var(--ground))',
  surface: 'rgb(var(--panel))',
  hairline: 'rgb(var(--line))',
  /** The seal. Formerly cyan, which was the tell of the genre. */
  cyan: 'rgb(var(--seal))',
  good: 'rgb(var(--risk-good))',
  warn: 'rgb(var(--risk-warn))',
  bad: 'rgb(var(--risk-bad))',
  ink: 'rgb(var(--tx))',
  inkMuted: 'rgb(var(--tx-2))',
} as const;

export const SEVERITY_ORDER: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

/**
 * Severity, which is trust-critical and therefore solved rather than chosen.
 *
 * Each value is the least saturated point on its hue that still clears 4.6:1
 * against the lightest surface it is ever set on, computed separately for each
 * theme. Two consequences worth stating: the set leaves the neon register that
 * every tool in this category reaches for, and no severity is below the 4.5:1
 * floor in either mode — which the previous set could not claim, `info` having
 * sat at 3.60.
 */
export const SEVERITY_COLORS: Record<string, string> = {
  critical: COLORS.bad,
  high: 'rgb(var(--risk-high))',
  medium: COLORS.warn,
  low: 'rgb(var(--risk-low))',
  info: 'rgb(var(--risk-info))',
};

/** Per-check network budget. The orchestrator adds its own hard ceiling. */
export const CHECK_TIMEOUT_MS = 10_000;

/**
 * Rate limiting: max scans per IP per rolling window.
 *
 * Raised from ten. Ten was sized against abuse and never against use: a real
 * evaluation session walks a supplier list, and a procurement reader working
 * through eight vendors, re-running two of them, and assessing their own
 * domain for the comparison had already spent the allowance before lunch. The
 * concurrency ceiling is what actually protects the instance from a burst —
 * this number protects it from a slow drip, and thirty is still far below what
 * one address can be doing honestly.
 *
 * Read everywhere it is stated rather than restated: the 429 body and both
 * lines on the scanner disclosure page interpolate it.
 */
export const RATE_LIMIT_MAX = 30;
export const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

/**
 * Minimum peer *domains* before a benchmark pool is considered meaningful.
 *
 * Counted per domain, not per scan: the table keeps every run, so a pool built
 * from raw rows would let one re-seeded vendor stand in for thirty peers.
 *
 * The pool is also self-selected — it contains whichever domains someone chose
 * to assess, not a representative sample of an industry. A percentile computed
 * off a handful of those is misleading, so the threshold is set well above the
 * point where the arithmetic merely becomes possible.
 */
export const MIN_BENCHMARK_SAMPLES = 30;

/**
 * Minimum share of scoring weight that must be assessable on the reader's own
 * domain before a buyer comparison is published.
 *
 * The vendor's own report happily renormalises around a failed module — that is
 * the domain the user asked about, and stating the coverage achieved is honest.
 * A comparison is different: a mostly-unmeasured domain produces a *standard*,
 * and judging the vendor against a standard built from two modules that happened
 * to answer is worse than declining to compare. A domain that does not resolve
 * lands around 0.27 and would otherwise be reported as a real posture.
 */
export const MIN_CONTEXT_COVERAGE = 0.6;
