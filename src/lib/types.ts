/**
 * Shared types for Klyro's assessment pipeline.
 *
 * The flow is: check module -> CategoryResult -> scoring engine -> ScanResult
 * -> Supabase (for benchmarking) -> dashboard + PDF report.
 */

export type CategoryKey =
  | 'dns'
  | 'subdomains'
  | 'ssl'
  | 'headers'
  | 'emailSecurity'
  | 'whois'
  | 'exposedPaths'
  | 'cookies'
  | 'cors'
  | 'robotsSecurity'
  | 'technologies';

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export type RiskLevel = 'Low Risk' | 'Moderate Risk' | 'High Risk';

/**
 * How well the evidence supports the finding. Reported separately from
 * severity, because the two are genuinely independent: a critical consequence
 * inferred from a host name is not the same claim as a critical consequence
 * read directly out of a DNS record.
 *
 * high    — directly observed, and corroborated (second resolver, content
 *           signature, protocol-level confirmation).
 * medium  — directly observed, but with a stated limitation on what the
 *           observation covers.
 * low     — inferred from weak signal such as naming convention. Never
 *           carries severe language.
 *
 * There is deliberately no `unknown` level: something that cannot be
 * established does not become a finding at all. It is reported as an
 * information item that says so, and excluded from the score.
 */
export type Confidence = 'high' | 'medium' | 'low';

/**
 * Why Klyro believes a finding. Every field answers a question a technical
 * reader will ask when they disagree with the conclusion.
 */
export interface FindingEvidence {
  /** The test performed, in enough detail to repeat by hand. */
  test: string;
  /** What actually came back. Raw where raw is safe to print. */
  observed: string;
  /** What a correctly configured target would have returned. */
  expected?: string;
  /** How the observation was corroborated, or why it needs no corroboration. */
  verification: string;
  /** What this test cannot establish. Rendered whenever present. */
  limitation?: string;
}

export interface Finding {
  /** Derived from the finding itself, so two scans can be diffed. */
  id: string;
  category: CategoryKey;
  /** Human category label, denormalised so the PDF doesn't need a lookup. */
  categoryLabel: string;
  title: string;
  severity: Severity;
  confidence: Confidence;
  /** The specific thing this is about: a domain, a host name, a URL. */
  asset: string;
  /**
   * OBSERVED. What Klyro measured, with no inference attached. A reader who
   * distrusts everything else should still be able to accept this sentence.
   */
  observed: string;
  /** INTERPRETATION. What the observation reasonably indicates. */
  interpretation: string;
  /**
   * RISK. What could follow if the interpretation holds. Conditional voice —
   * this is the one field that describes something that has not happened.
   */
  risk: string;
  /** RECOMMENDATION. A concrete next step, not a platitude. */
  recommendation: string;
  evidence: FindingEvidence;
  /** Points this finding cost inside its own module, when it cost any. */
  scoreImpact?: number;
  /**
   * A short note written by a language model, grounded in facts this same
   * scan produced. Optional, and deliberately kept apart from the fields
   * above: everything else on this interface is measured, this one is
   * generated, and the interface is where that distinction starts. Absent
   * when the finding was not eligible, when Groq is not configured, and when
   * generation failed — see `src/lib/ai/narrate.ts`.
   */
  aiContext?: FindingAiContext;
}

/** Generated context attached to a finding. Never a source of score. */
export interface FindingAiContext {
  narrative: string | null;
  generated: boolean;
  /** Diagnostic only. Never rendered to a reader. */
  reason?: string;
  generatedAt?: string;
}

/** One line of a category's score, so the number can be taken apart. */
export interface ScoreLine {
  label: string;
  /** Points earned. */
  value: number;
  /** Points available. */
  max: number;
  /** False when the observation could not be made, and the line was dropped. */
  assessed: boolean;
  /** Why it scored what it scored, or why it was dropped. */
  note: string;
}

/** Result of a single check module. */
export interface CategoryResult {
  key: CategoryKey;
  label: string;
  /** 0-100. Meaningless when status is 'unavailable'. */
  score: number;
  status: 'assessed' | 'unavailable';
  /** Present when status is 'unavailable'. */
  error?: string;
  findings: Finding[];
  /** One-line plain-English summary of what this category found. */
  summary: string;
  /** Module-specific structured data, rendered in the expandable card. */
  details: CategoryDetail[];
  /** How this category's score was arrived at, component by component. */
  scoreBreakdown?: ScoreLine[];
  /**
   * Share of this module's own scoring weight that could be assessed (0-1).
   * Below 1 means components were dropped rather than scored as failures.
   */
  moduleCoverage?: number;
  /**
   * Machine-readable observations, as opposed to `details` which is display
   * copy. Used to compare two scans against each other — for example to test
   * whether a subsidiary actually runs on its parent's infrastructure.
   */
  facts?: Record<string, unknown>;
  /**
   * Structured module output the report renders directly, as opposed to
   * `facts` (comparison only) or `details` (display copy).
   *
   * Typed rather than free-form because `facts` is dropped by the report
   * payload sanitiser — anything the PDF needs to render has to survive a
   * round trip through untrusted input, and that means it has to have a shape
   * the sanitiser can rebuild field by field.
   */
  payload?: CategoryPayload;
  durationMs: number;
}

/** Structured output a module hands to the dashboard and the report. */
export interface CategoryPayload {
  /** Every discovered host, fingerprinted and tiered. From the subdomain module. */
  subdomains?: SubdomainResult[];
  /** The technology profile of the primary domain. From the technologies module. */
  technologyProfile?: TechnologyProfile;
}

/** A label/value pair rendered inside a category card's detail panel. */
export interface CategoryDetail {
  label: string;
  value: string;
  /** Renders the value in JetBrains Mono when true. */
  mono?: boolean;
  tone?: 'good' | 'warn' | 'bad' | 'neutral';
}

/* ------------------------------------------------------------------ *
 * Subdomain exposure
 *
 * One record per discovered host, carrying what the response said about
 * itself. Tiering is a function of the name *and* the response together: a
 * host called `admin` that answers nothing is a different observation from one
 * that answers 200 with a Grafana page, and the previous grouping — by name
 * alone — could not tell them apart.
 * ------------------------------------------------------------------ */

/**
 * How much attention a host warrants.
 *
 * Separate from `Severity` on purpose. Severity describes a finding; a tier
 * describes a host, and a host can sit in a tier without any finding being
 * raised about it.
 */
export type RiskTier = 'critical' | 'high' | 'medium' | 'low' | 'info';

export interface SubdomainResult {
  hostname: string;
  /** First resolved address, when the liveness probe recorded one. */
  ip: string | null;
  /** Null when nothing answered — see `unreachableReason`. */
  statusCode: number | null;
  /**
   * Why there is no status. Null when the host answered.
   *
   * `not-probed` is the important one: a host beyond the scan's HTTP budget
   * never had a request made to it, which is not the same observation as a
   * host that refused one. Collapsing the two would report a budget limit as a
   * fact about the target.
   */
  unreachableReason: 'timed-out' | 'no-response' | 'not-probed' | null;
  /** `Location` on a 3xx. Klyro does not follow it. */
  redirectTarget: string | null;
  serverHeader: string | null;
  poweredBy: string | null;
  /** Software the response named, e.g. "Jenkins", "WordPress". */
  detectedPlatform: string | null;
  /** Which signal identified it — a title, a cookie name, a markup marker. */
  platformEvidence: string;
  /**
   * True when the identification rests on something only that product emits,
   * rather than on the response merely mentioning its name. Only a confirmed
   * identification is allowed to raise a host's tier.
   */
  platformConfirmed: boolean;
  /** Scheme from `WWW-Authenticate`, when one was offered. */
  authType: string | null;
  /** Names only. Values are never captured. */
  cookieNames: string[];
  /** The response carries the marks of a sign-in page. */
  looksLikeLogin: boolean;
  /** What the name suggests, when it suggests anything. A name, not a fact. */
  namingSuggests: string | null;
  riskTier: RiskTier;
  /** One plain sentence, stating only what was observed. */
  riskReason: string;
}

/* ------------------------------------------------------------------ *
 * Technology profile
 * ------------------------------------------------------------------ */

export type TechnologyCategory =
  | 'infrastructure'
  | 'frontend'
  | 'analytics'
  | 'marketing'
  | 'payment'
  | 'support'
  | 'security'
  | 'email'
  | 'other';

export interface DetectedTechnology {
  name: string;
  category: TechnologyCategory;
  /** Only ever present where the target stated it. Never inferred. */
  version: string | null;
  /** The exact header, script host, cookie name or record it rests on. */
  evidence: string;
  confidence: Confidence;
  /**
   * Set when the identification itself is worth a second look — a version
   * number published in a header, for instance. Never a vulnerability claim.
   */
  note?: string;
}

export interface TechnologyProfile {
  domain: string;
  webServer: string | null;
  cdn: string | null;
  applicationFramework: string | null;
  jsFramework: string | null;
  cssFramework: string | null;
  analytics: string[];
  marketing: string[];
  payment: string[];
  customerSupport: string[];
  security: string[];
  emailProvider: string | null;
  hostingProvider: string | null;
  /** Services named by TXT verification records. */
  otherServices: string[];
  /** Distinct external hosts the homepage loads script from. */
  thirdPartyScriptHosts: string[];
  /** Versions the target published about itself, in headers or a generator tag. */
  versionsDisclosed: { name: string; version: string; evidence: string }[];
  allDetected: DetectedTechnology[];
  /** What this pass could not see. Always rendered. */
  limits: string[];
}

export interface ScanTarget {
  domain: string;
  industry: string;
  region: string;
}

export interface ScanResult extends ScanTarget {
  /** Supabase row id, absent when persistence is not configured. */
  id?: string;
  compositeScore: number;
  riskLevel: RiskLevel;
  categoryScores: Record<string, number>;
  categories: CategoryResult[];
  findings: Finding[];
  /** Fraction of total weight that could actually be assessed (0-1). */
  coverage: number;
  /** Unscored. Present when the inventory pass completed. */
  inventory?: AssetInventory;
  scannedAt: string;
  toolVersion: string;
  persisted: boolean;
}

/* ------------------------------------------------------------------ *
 * Asset inventory
 *
 * Deliberately unscored. It records what exists and how it connects —
 * organisation → host → address → network — so a reader can see the estate
 * being described rather than take the findings on trust. Turning any of it
 * into points would mean scoring companies for being large, which is the same
 * objection that keeps estate size and news volume out of the composite.
 * ------------------------------------------------------------------ */

/** Where an address sits on the internet, per the routing table. */
export interface NetworkAssignment {
  /** Autonomous system number, without the "AS" prefix. */
  asn: string;
  /** Operator name as published by the registry. */
  asName: string;
  /** The announced prefix this address falls inside. */
  prefix: string;
  countryCode: string;
  registry: string;
  /** The address this assignment was looked up for. */
  address: string;
}

export interface HostAsset {
  host: string;
  /** How Klyro came to know about this name. */
  origin: 'apex' | 'certificate-transparency';
  addresses: string[];
  /** Reverse DNS for those addresses. Often empty; absence means nothing. */
  reverseDns: string[];
  /** Networks the addresses belong to, deduplicated. */
  asns: string[];
  /**
   * Whether any of this host's addresses were submitted for a network lookup.
   * False means the lookup budget ran out before reaching it — which is not
   * the same as "no network could be found", and must not be presented as if
   * it were.
   */
  networkLookedUp: boolean;
  /**
   * Naming suggests non-production or internal use. A *name*, not a fact about
   * the system — always reported as such.
   */
  namingSuggests: string | null;
}

export interface TechnologySignal {
  name: string;
  category: 'server' | 'framework' | 'cms' | 'cdn' | 'language' | 'analytics' | 'security';
  /** Only ever set when the target stated it. Never inferred from behaviour. */
  version: string | null;
  confidence: Confidence;
  /** The exact header, cookie or markup this rests on. */
  evidence: string;
}

export interface AssetInventory {
  domain: string;
  hosts: HostAsset[];
  networks: NetworkAssignment[];
  technologies: TechnologySignal[];
  /** Discovered host names that could not be resolved during this pass. */
  unresolvedHosts: number;
  /** What this inventory cannot see. Always rendered. */
  limits: string[];
  collectedAt: string;
}

/* ------------------------------------------------------------------ *
 * Prioritisation
 * ------------------------------------------------------------------ */

export interface PrioritisedFinding {
  finding: Finding;
  /** 1-based position in the ranking. */
  rank: number;
  /** The computed priority, 0-100. Deterministic. */
  priority: number;
  factors: {
    severity: number;
    confidence: number;
    exposure: number;
  };
  /** Why Klyro placed it here, in one sentence, naming the multipliers. */
  rationale: string;
}

/* ------------------------------------------------------------------ *
 * Scan comparison
 *
 * Manual, between two completed scans. Not monitoring: nothing reassesses on a
 * schedule, and no claim is made about what happened between the two runs.
 * ------------------------------------------------------------------ */

export interface ScanSnapshotRef {
  domain: string;
  scannedAt: string;
  compositeScore: number;
  coverage: number;
  /** Null for runs stored before the version was recorded. */
  toolVersion: string | null;
}

export interface SeverityChange {
  finding: Finding;
  from: Severity;
  to: Severity;
}

export interface CategoryDelta {
  key: CategoryKey;
  label: string;
  from: number | null;
  to: number | null;
  delta: number | null;
}

export interface ScanComparison {
  baseline: ScanSnapshotRef;
  current: ScanSnapshotRef;
  scoreDelta: number;
  newFindings: Finding[];
  resolvedFindings: Finding[];
  severityChanges: SeverityChange[];
  unchangedCount: number;
  categoryDeltas: CategoryDelta[];
  /** Host names present in one scan and not the other. */
  newAssets: string[];
  removedAssets: string[];
  /** What a comparison of two point-in-time scans cannot tell you. */
  limits: string[];
}

export interface BenchmarkResult {
  industry: string;
  region: string;
  industryAverage: number;
  industryMedian: number;
  industryBest: number;
  /** Null until a score is supplied to rank against the pool. */
  percentileRank: number | null;
  categoryAverages: Record<string, number>;
  totalScans: number;
  insufficientData: boolean;
  /** Which pool the numbers came from once fallbacks are applied. */
  scope: 'industry-region' | 'industry' | 'global' | 'none';
}

/* ------------------------------------------------------------------ *
 * Buyer context
 *
 * Optional. When the person running the assessment also supplies their own
 * organisation's domain, Klyro assesses both and reports what the vendor's
 * posture means *for them specifically* — where the vendor falls behind their
 * own standard, and which upstream providers the two of them would lose at the
 * same moment. None of it moves the vendor's score: this is a second party's
 * evidence, and the score belongs to the domain it was measured on.
 * ------------------------------------------------------------------ */

/** How pressing a concern is. `note` is the reader's own homework, not the vendor's. */
export type ConcernLevel = 'high' | 'medium' | 'low' | 'note';

export type ConcernKind =
  /** Both parties depend on the same upstream provider. */
  | 'concentration'
  /** The vendor is materially behind the reader on an assessed check. */
  | 'standards-gap'
  /** Mail claiming to come from the vendor can be forged. */
  | 'impersonation'
  /** The reader is behind the vendor — reported so the comparison stays honest. */
  | 'reciprocal';

export interface RelationshipConcern {
  id: string;
  kind: ConcernKind;
  level: ConcernLevel;
  title: string;
  /** What it means for the reader's organisation, in plain English. */
  detail: string;
  /** A concrete thing to do or ask, not a platitude. */
  watchFor: string;
  evidence?: string;
}

/** An upstream provider both organisations depend on. */
export interface SharedDependency {
  key: 'dns' | 'mail' | 'ca' | 'registrar';
  label: string;
  provider: string;
}

/** One check where the two domains diverge materially. */
export interface CategoryGap {
  key: CategoryKey;
  label: string;
  yourScore: number;
  vendorScore: number;
  /** yourScore − vendorScore. Positive means the vendor is behind. */
  delta: number;
}

export interface RelationshipAssessment {
  yourDomain: string;
  vendorDomain: string;
  yourScore: number;
  vendorScore: number;
  /** yourScore − vendorScore. */
  scoreDelta: number;
  /** Fraction of scoring weight that could be assessed on the reader's domain. */
  yourCoverage: number;
  sharedDependencies: SharedDependency[];
  gaps: CategoryGap[];
  concerns: RelationshipConcern[];
  /** One sentence, set large. */
  headline: string;
  /** The paragraph a procurement reader actually takes away. */
  narrative: string;
  /** What this comparison cannot see. Always rendered, never optional. */
  limits: string[];
  assessedAt: string;
}

/** Streamed progress events emitted by POST /api/scan. */
export type ScanEvent =
  | { type: 'start'; domain: string; modules: { key: CategoryKey; label: string }[] }
  | { type: 'module:running'; key: CategoryKey }
  | { type: 'module:done'; key: CategoryKey; result: CategoryResult }
  | {
      type: 'complete';
      result: ScanResult;
      benchmark: BenchmarkResult | null;
      /**
       * Set when the assessment was saved somewhere other than the caller
       * asked — filed personally because they named an organisation they are
       * not a member of, or are only a viewer in. Shown, not swallowed: a
       * scan quietly landing in the wrong place is worse than one that says so.
       */
      notice?: string;
    }
  // The reader's own domain is assessed alongside the vendor's, so these land
  // independently of the ten module events above.
  | { type: 'context:running'; domain: string }
  | { type: 'context:done'; assessment: RelationshipAssessment | null; error?: string }
  // Generated context for the top findings. It runs after scoring and before
  // the result is stored, and it is bounded — see `src/lib/ai/narrate.ts`.
  // Reported so the progress screen can say what it is waiting on rather than
  // appearing to stall between the last module and the result.
  | { type: 'ai:running' }
  | { type: 'ai:done' }
  // The inventory is built from what the check modules already resolved, so it
  // lands after them rather than alongside.
  | { type: 'inventory:running' }
  | { type: 'inventory:done'; inventory: AssetInventory | null }
  | { type: 'error'; message: string };

export type ModuleStatus = 'pending' | 'running' | 'complete' | 'failed';
