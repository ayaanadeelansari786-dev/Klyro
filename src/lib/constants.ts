import type { CategoryKey } from './types';

export const TOOL_VERSION = '1.1.0';

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
export const CATEGORY_WEIGHTS: Record<CategoryKey, number> = {
  dns: 0.1,
  subdomains: 0.12,
  ssl: 0.13,
  headers: 0.12,
  emailSecurity: 0.13,
  whois: 0.06,
  exposedPaths: 0.1,
  cookies: 0.05,
  cors: 0.05,
  robotsSecurity: 0.04,
  technologies: 0.1,
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
};

export const COLORS = {
  bg: '#0A0E1A',
  surface: '#131825',
  hairline: '#1F2637',
  cyan: '#00E5FF',
  good: '#00E676',
  warn: '#FFB300',
  bad: '#FF3D3D',
  ink: '#E8EDF7',
  inkMuted: '#8A94AD',
} as const;

export const SEVERITY_ORDER: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

export const SEVERITY_COLORS: Record<string, string> = {
  critical: COLORS.bad,
  high: '#FF7043',
  medium: COLORS.warn,
  low: '#4FC3F7',
  info: COLORS.inkMuted,
};

/** Per-check network budget. The orchestrator adds its own hard ceiling. */
export const CHECK_TIMEOUT_MS = 10_000;

/** Rate limiting: max scans per IP per rolling window. */
export const RATE_LIMIT_MAX = 10;
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
