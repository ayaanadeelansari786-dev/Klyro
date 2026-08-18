/**
 * Validation for the report endpoint.
 *
 * `POST /api/report` takes a scan result from the browser and renders it into
 * a Klyro-branded PDF. The scan lives in browser state and is never stored
 * server-side, so the endpoint has nothing to check the payload against — it
 * has to trust the shape rather than the contents.
 *
 * Untrusted, it is a general-purpose "render my text under Klyro's letterhead"
 * service: post any strings and get back a document that looks like an
 * assessment. That is a document-forgery primitive, and for a product whose
 * entire value is that its reports are trustworthy it is the wrong thing to
 * leave open.
 *
 * This narrows it as far as is possible without server-side scan storage.
 * Every field is checked for type, every string is clamped to a length that
 * fits its role in the layout, every enum is checked against its allowed
 * values, and every collection is capped. What survives still originates with
 * the caller — the honest description is that a forged report can only contain
 * plausible-looking assessment content, not arbitrary prose.
 *
 * Binding a report to a stored scan is the real fix and needs the database.
 */

import { CATEGORY_LABELS } from './constants';
import type {
  CategoryDetail,
  CategoryKey,
  CategoryPayload,
  CategoryResult,
  Confidence,
  Finding,
  RiskTier,
  ScanResult,
  ScoreLine,
  Severity,
  SubdomainResult,
  TechnologyCategory,
  TechnologyProfile,
} from './types';

const SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];
const CONFIDENCES: Confidence[] = ['high', 'medium', 'low'];
const CATEGORY_KEYS = Object.keys(CATEGORY_LABELS) as CategoryKey[];

/** Ceilings sized to the layout each field appears in, not to the data. */
const LIMITS = {
  title: 160,
  prose: 1_200,
  evidenceLine: 2_000,
  label: 120,
  detailValue: 600,
  summary: 600,
  findings: 300,
  details: 40,
  breakdown: 20,
  categories: 20,
  /** The dashboard renders every host; the PDF renders the top tiers only. */
  subdomains: 400,
} as const;

function str(value: unknown, max: number, fallback = ''): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

function num(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function oneOf<T extends string>(value: unknown, allowed: T[], fallback: T): T {
  return typeof value === 'string' && (allowed as string[]).includes(value) ? (value as T) : fallback;
}

function arr(value: unknown, cap: number): unknown[] {
  return Array.isArray(value) ? value.slice(0, cap) : [];
}

function cleanFinding(raw: unknown, index: number): Finding {
  const f = (raw ?? {}) as Record<string, unknown>;
  const category = oneOf(f.category, CATEGORY_KEYS, 'dns');
  const evidence = (f.evidence ?? {}) as Record<string, unknown>;

  return {
    // Ids reach React keys and the PDF; keep them to a safe character set.
    id: str(f.id, 80, `finding-${index}`).replace(/[^\w.:-]/g, '') || `finding-${index}`,
    category,
    categoryLabel: str(f.categoryLabel, LIMITS.label, CATEGORY_LABELS[category]),
    title: str(f.title, LIMITS.title, 'Untitled finding'),
    severity: oneOf(f.severity, SEVERITIES, 'info'),
    confidence: oneOf(f.confidence, CONFIDENCES, 'low'),
    asset: str(f.asset, LIMITS.label),
    observed: str(f.observed, LIMITS.prose),
    interpretation: str(f.interpretation, LIMITS.prose),
    risk: str(f.risk, LIMITS.prose),
    recommendation: str(f.recommendation, LIMITS.prose),
    evidence: {
      test: str(evidence.test, LIMITS.evidenceLine),
      observed: str(evidence.observed, LIMITS.evidenceLine),
      expected: evidence.expected === undefined ? undefined : str(evidence.expected, LIMITS.evidenceLine),
      verification: str(evidence.verification, LIMITS.evidenceLine),
      limitation:
        evidence.limitation === undefined ? undefined : str(evidence.limitation, LIMITS.evidenceLine),
    },
    scoreImpact: typeof f.scoreImpact === 'number' ? num(f.scoreImpact, 0, 100, 0) : undefined,
  };
}

function cleanDetail(raw: unknown): CategoryDetail {
  const d = (raw ?? {}) as Record<string, unknown>;
  return {
    label: str(d.label, LIMITS.label),
    value: str(d.value, LIMITS.detailValue),
    mono: d.mono === true,
    tone: oneOf(d.tone, ['good', 'warn', 'bad', 'neutral'] as const, 'neutral'),
  };
}

function cleanScoreLine(raw: unknown): ScoreLine {
  const l = (raw ?? {}) as Record<string, unknown>;
  return {
    label: str(l.label, LIMITS.label),
    value: num(l.value, -100, 100, 0),
    max: num(l.max, 0, 100, 0),
    assessed: l.assessed !== false,
    note: str(l.note, LIMITS.prose),
  };
}

function cleanCategory(raw: unknown): CategoryResult | null {
  const c = (raw ?? {}) as Record<string, unknown>;
  if (typeof c.key !== 'string' || !(CATEGORY_KEYS as string[]).includes(c.key)) return null;
  const key = c.key as CategoryKey;

  return {
    key,
    label: str(c.label, LIMITS.label, CATEGORY_LABELS[key]),
    score: num(c.score, 0, 100, 0),
    status: c.status === 'unavailable' ? 'unavailable' : 'assessed',
    error: c.error === undefined ? undefined : str(c.error, LIMITS.prose),
    findings: arr(c.findings, LIMITS.findings).map(cleanFinding),
    summary: str(c.summary, LIMITS.summary),
    details: arr(c.details, LIMITS.details).map(cleanDetail),
    scoreBreakdown: Array.isArray(c.scoreBreakdown)
      ? arr(c.scoreBreakdown, LIMITS.breakdown).map(cleanScoreLine)
      : undefined,
    moduleCoverage:
      typeof c.moduleCoverage === 'number' ? num(c.moduleCoverage, 0, 1, 1) : undefined,
    payload: cleanPayload(c.payload),
    durationMs: num(c.durationMs, 0, 600_000, 0),
  };
}

/* ------------------------------------------------------------------ *
 * Structured module output
 *
 * Rebuilt field by field like everything else here. `facts` is deliberately
 * *not* carried across — it exists for cross-scan comparison and nothing
 * renders it, so admitting it would widen the payload for no reader.
 * ------------------------------------------------------------------ */

const RISK_TIERS: RiskTier[] = ['critical', 'high', 'medium', 'low', 'info'];
const TECH_CATEGORIES: TechnologyCategory[] = [
  'infrastructure',
  'frontend',
  'analytics',
  'marketing',
  'payment',
  'support',
  'security',
  'email',
  'other',
];

function cleanSubdomain(raw: unknown): SubdomainResult {
  const s = (raw ?? {}) as Record<string, unknown>;
  return {
    hostname: str(s.hostname, 253),
    ip: typeof s.ip === 'string' ? str(s.ip, 45) : null,
    statusCode: typeof s.statusCode === 'number' ? num(s.statusCode, 0, 599, 0) : null,
    unreachableReason:
      typeof s.unreachableReason === 'string'
        ? oneOf(s.unreachableReason, ['timed-out', 'no-response', 'not-probed'] as const, 'no-response')
        : null,
    redirectTarget: typeof s.redirectTarget === 'string' ? str(s.redirectTarget, 300) : null,
    serverHeader: typeof s.serverHeader === 'string' ? str(s.serverHeader, 120) : null,
    poweredBy: typeof s.poweredBy === 'string' ? str(s.poweredBy, 120) : null,
    detectedPlatform: typeof s.detectedPlatform === 'string' ? str(s.detectedPlatform, 60) : null,
    platformEvidence: str(s.platformEvidence, 300),
    platformConfirmed: s.platformConfirmed === true,
    authType: typeof s.authType === 'string' ? str(s.authType, 24) : null,
    cookieNames: arr(s.cookieNames, 12).map((n) => str(n, 64)),
    looksLikeLogin: s.looksLikeLogin === true,
    namingSuggests: typeof s.namingSuggests === 'string' ? str(s.namingSuggests, 60) : null,
    riskTier: oneOf(s.riskTier, RISK_TIERS, 'info'),
    riskReason: str(s.riskReason, LIMITS.prose),
  };
}

function cleanTechnologyProfile(raw: unknown): TechnologyProfile {
  const t = (raw ?? {}) as Record<string, unknown>;
  const nullableStr = (value: unknown, max: number) =>
    typeof value === 'string' && value.trim() ? str(value, max) : null;
  const list = (value: unknown, cap: number, max: number) =>
    arr(value, cap).map((v) => str(v, max)).filter(Boolean);

  return {
    domain: str(t.domain, 253),
    webServer: nullableStr(t.webServer, 120),
    cdn: nullableStr(t.cdn, 120),
    applicationFramework: nullableStr(t.applicationFramework, 120),
    jsFramework: nullableStr(t.jsFramework, 120),
    cssFramework: nullableStr(t.cssFramework, 120),
    analytics: list(t.analytics, 30, 80),
    marketing: list(t.marketing, 30, 80),
    payment: list(t.payment, 20, 80),
    customerSupport: list(t.customerSupport, 20, 80),
    security: list(t.security, 20, 80),
    emailProvider: nullableStr(t.emailProvider, 80),
    hostingProvider: nullableStr(t.hostingProvider, 80),
    otherServices: list(t.otherServices, 40, 80),
    thirdPartyScriptHosts: list(t.thirdPartyScriptHosts, 100, 253),
    versionsDisclosed: arr(t.versionsDisclosed, 20).map((raw) => {
      const v = (raw ?? {}) as Record<string, unknown>;
      return { name: str(v.name, 80), version: str(v.version, 40), evidence: str(v.evidence, 200) };
    }),
    allDetected: arr(t.allDetected, 80).map((raw) => {
      const d = (raw ?? {}) as Record<string, unknown>;
      return {
        name: str(d.name, 80),
        category: oneOf(d.category, TECH_CATEGORIES, 'other'),
        version: typeof d.version === 'string' ? str(d.version, 40) : null,
        evidence: str(d.evidence, 300),
        confidence: oneOf(d.confidence, CONFIDENCES, 'low'),
        note: d.note === undefined ? undefined : str(d.note, LIMITS.prose),
      };
    }),
    limits: arr(t.limits, 12).map((l) => str(l, LIMITS.prose)),
  };
}

function cleanPayload(raw: unknown): CategoryPayload | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const p = raw as Record<string, unknown>;

  const payload: CategoryPayload = {};
  if (Array.isArray(p.subdomains)) {
    payload.subdomains = arr(p.subdomains, LIMITS.subdomains)
      .map(cleanSubdomain)
      .filter((s) => s.hostname.length > 0);
  }
  if (p.technologyProfile && typeof p.technologyProfile === 'object') {
    payload.technologyProfile = cleanTechnologyProfile(p.technologyProfile);
  }

  return payload.subdomains || payload.technologyProfile ? payload : undefined;
}

export interface PayloadVerdict {
  ok: boolean;
  error?: string;
  result?: ScanResult;
}

/**
 * Rebuilds a `ScanResult` field by field from untrusted input.
 *
 * Deliberately a rebuild rather than a validation pass: anything not named
 * here is dropped rather than carried through, so a property the renderer
 * might one day read cannot be smuggled in ahead of the code that reads it.
 */
export function sanitiseScanResult(raw: unknown, domain: string): PayloadVerdict {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: 'A completed scan result is required.' };
  }

  const r = raw as Record<string, unknown>;

  const categories = arr(r.categories, LIMITS.categories)
    .map(cleanCategory)
    .filter((c): c is CategoryResult => c !== null);

  if (categories.length === 0) {
    return { ok: false, error: 'The scan result contains no recognisable check categories.' };
  }

  const categoryScores: Record<string, number> = {};
  for (const category of categories) {
    if (category.status === 'assessed') categoryScores[category.key] = category.score;
  }

  const scannedAt = typeof r.scannedAt === 'string' && !Number.isNaN(Date.parse(r.scannedAt))
    ? r.scannedAt
    : new Date().toISOString();

  return {
    ok: true,
    result: {
      domain,
      industry: str(r.industry, LIMITS.label, 'Not specified'),
      region: str(r.region, LIMITS.label, 'Not specified'),
      compositeScore: num(r.compositeScore, 0, 100, 0),
      riskLevel:
        r.riskLevel === 'Low Risk' || r.riskLevel === 'High Risk' ? r.riskLevel : 'Moderate Risk',
      categoryScores,
      categories,
      findings: arr(r.findings, LIMITS.findings).map(cleanFinding),
      coverage: num(r.coverage, 0, 1, 0),
      inventory: sanitiseInventory(r.inventory),
      scannedAt,
      toolVersion: str(r.toolVersion, 24),
      persisted: r.persisted === true,
    },
  };
}

function sanitiseInventory(raw: unknown): ScanResult['inventory'] {
  if (!raw || typeof raw !== 'object') return undefined;
  const i = raw as Record<string, unknown>;

  return {
    domain: str(i.domain, LIMITS.label),
    hosts: arr(i.hosts, 200).map((raw) => {
      const h = (raw ?? {}) as Record<string, unknown>;
      return {
        host: str(h.host, 253),
        origin: h.origin === 'apex' ? 'apex' : 'certificate-transparency',
        addresses: arr(h.addresses, 12).map((a) => str(a, 45)),
        reverseDns: arr(h.reverseDns, 12).map((a) => str(a, 253)),
        asns: arr(h.asns, 12).map((a) => str(a, 12)),
        networkLookedUp: h.networkLookedUp === true,
        namingSuggests: typeof h.namingSuggests === 'string' ? str(h.namingSuggests, 40) : null,
      };
    }),
    networks: arr(i.networks, 40).map((raw) => {
      const n = (raw ?? {}) as Record<string, unknown>;
      return {
        asn: str(n.asn, 12),
        asName: str(n.asName, 120),
        prefix: str(n.prefix, 45),
        countryCode: str(n.countryCode, 8),
        registry: str(n.registry, 24),
        address: str(n.address, 45),
      };
    }),
    technologies: arr(i.technologies, 60).map((raw) => {
      const t = (raw ?? {}) as Record<string, unknown>;
      return {
        name: str(t.name, 80),
        category: oneOf(
          t.category,
          ['server', 'framework', 'cms', 'cdn', 'language', 'analytics', 'security'] as const,
          'server',
        ),
        version: typeof t.version === 'string' ? str(t.version, 40) : null,
        confidence: oneOf(t.confidence, CONFIDENCES, 'low'),
        evidence: str(t.evidence, 300),
      };
    }),
    unresolvedHosts: num(i.unresolvedHosts, 0, 10_000, 0),
    limits: arr(i.limits, 20).map((l) => str(l, LIMITS.prose)),
    collectedAt: typeof i.collectedAt === 'string' ? i.collectedAt : new Date().toISOString(),
  };
}
