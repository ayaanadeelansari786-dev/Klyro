import { CATEGORY_WEIGHTS, SEVERITY_ORDER, TOOL_VERSION } from './constants';
import type {
  AssetInventory,
  CategoryKey,
  CategoryResult,
  Confidence,
  Finding,
  PrioritisedFinding,
  RiskLevel,
  ScanResult,
  ScanTarget,
  Severity,
} from './types';

/** Clamp to the 0-100 band every module reports in. */
export function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function riskLevelFor(score: number): RiskLevel {
  if (score >= 80) return 'Low Risk';
  if (score >= 60) return 'Moderate Risk';
  return 'High Risk';
}

export function riskColorFor(score: number): 'good' | 'warn' | 'bad' {
  if (score >= 80) return 'good';
  if (score >= 60) return 'warn';
  return 'bad';
}

export function ratingFor(score: number): string {
  if (score >= 90) return 'Strong';
  if (score >= 80) return 'Good';
  if (score >= 60) return 'Fair';
  if (score >= 40) return 'Weak';
  return 'Critical';
}

export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
    const bySeverity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (bySeverity !== 0) return bySeverity;
    return a.title.localeCompare(b.title);
  });
}

export function countBySeverity(findings: Finding[]): Record<Severity, number> {
  const counts: Record<Severity, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0,
  };
  for (const f of findings) counts[f.severity] += 1;
  return counts;
}

/**
 * Composite score across all assessed categories.
 *
 * Modules that could not be assessed (upstream source down, network failure)
 * are dropped and the remaining weights are renormalised, so one flaky data
 * source never drags a domain's score down. `coverage` records how much of the
 * intended weight actually contributed, and is surfaced in the report.
 */
export function computeComposite(categories: CategoryResult[]): {
  compositeScore: number;
  coverage: number;
} {
  const assessed = categories.filter((c) => c.status === 'assessed');
  const totalWeight = assessed.reduce((sum, c) => sum + (CATEGORY_WEIGHTS[c.key] ?? 0), 0);

  if (totalWeight <= 0) {
    return { compositeScore: 0, coverage: 0 };
  }

  const weighted = assessed.reduce(
    (sum, c) => sum + clampScore(c.score) * (CATEGORY_WEIGHTS[c.key] ?? 0),
    0,
  );

  return {
    compositeScore: clampScore(weighted / totalWeight),
    coverage: Number(totalWeight.toFixed(4)),
  };
}

/* ------------------------------------------------------------------ *
 * Coverage transparency
 * ------------------------------------------------------------------ */

/**
 * Below this share of scoring weight, the score is reported with a warning
 * above it rather than a footnote below it.
 *
 * The number a reader takes away from a 36%-coverage scan is "Moderate Risk",
 * and left unqualified that reads as a statement about the organisation. It is
 * not — it is a statement about how much of the domain Klyro could reach. The
 * two are easy to confuse and expensive to confuse, so under this threshold
 * the caveat is placed where it cannot be missed.
 */
export const LOW_COVERAGE_THRESHOLD = 0.6;

/** How many modules actually produced a score, out of how many were run. */
export function coverageCounts(result: {
  categories: CategoryResult[];
}): { assessed: number; total: number } {
  return {
    assessed: result.categories.filter((c) => c.status === 'assessed').length,
    total: result.categories.length,
  };
}

/**
 * Why so little of this domain could be assessed.
 *
 * Written from `status`, which every category always carries, rather than from
 * `facts`, which the report payload sanitiser drops — an explanation that only
 * appeared on the dashboard and went blank in the PDF would be worse than a
 * generic one in both.
 *
 * Each branch names a specific, checkable cause. A generic "some checks did
 * not complete" tells the reader nothing they could act on and does not
 * distinguish the two cases that matter most: a domain that serves no website
 * at all, and one that serves a website which refused to talk to Klyro.
 */
export function explainLowCoverage(result: { categories: CategoryResult[] }): string {
  const statusOf = (key: CategoryKey) =>
    result.categories.find((c) => c.key === key)?.status ?? null;

  const dnsAssessed = statusOf('dns') === 'assessed';
  const headersReached = statusOf('headers') === 'assessed';

  const dnsFacts = result.categories.find((c) => c.key === 'dns')?.facts as
    | { ipv4?: string[]; ipv6?: string[] }
    | undefined;
  // Undefined when facts were stripped; only used to sharpen the wording, and
  // never to decide which branch applies.
  const apexAddresses = dnsFacts
    ? (dnsFacts.ipv4?.length ?? 0) + (dnsFacts.ipv6?.length ?? 0)
    : null;

  if (!dnsAssessed) {
    return (
      'The DNS records for this domain could not be read, which is what most of the other checks ' +
      'build on. The score reflects only what could be measured, and is not a statement about how ' +
      'this domain is run.'
    );
  }

  if (!headersReached) {
    const noApex = apexAddresses === 0;
    return (
      (noApex
        ? 'This domain publishes DNS records but no address at its apex, so nothing serves a website there. '
        : 'This domain has DNS records, but no web server answered at the address they point to. ') +
      'Checks that need a live site — security headers, cookies, exposed paths, CORS and the ' +
      'technology profile — had nothing to read. This is normal for a domain used only for email, ' +
      'or one that exists to redirect somewhere else. The score reflects only what could be measured.'
    );
  }

  return (
    'A web server answered, but several checks could not complete — commonly a firewall, WAF or ' +
    'bot-protection layer refusing automated requests. That is a fact about what Klyro was allowed ' +
    'to see, not a finding about the domain. The score reflects only what could be measured.'
  );
}

export function buildScanResult(
  target: ScanTarget,
  categories: CategoryResult[],
  inventory?: AssetInventory | null,
): ScanResult {
  const { compositeScore, coverage } = computeComposite(categories);

  const categoryScores: Record<string, number> = {};
  for (const category of categories) {
    if (category.status === 'assessed') {
      categoryScores[category.key] = clampScore(category.score);
    }
  }

  const findings = sortFindings(categories.flatMap((c) => c.findings));

  return {
    ...target,
    compositeScore,
    riskLevel: riskLevelFor(compositeScore),
    categoryScores,
    categories,
    findings,
    coverage,
    ...(inventory ? { inventory } : {}),
    scannedAt: new Date().toISOString(),
    toolVersion: TOOL_VERSION,
    persisted: false,
  };
}

/* ------------------------------------------------------------------ *
 * Prioritisation
 *
 * "What matters most" has to be reproducible and inspectable, so it is
 * arithmetic over three published factors rather than a judgement. The two
 * things this buys: a finding inferred from a host name can never outrank one
 * read out of a DNS record at the same severity, and the reader can see why
 * anything sits where it does.
 * ------------------------------------------------------------------ */

/** How much of the stated consequence follows if the interpretation holds. */
const SEVERITY_WEIGHT: Record<Severity, number> = {
  critical: 100,
  high: 70,
  medium: 45,
  low: 20,
  info: 0,
};

/** How well the evidence supports the interpretation in the first place. */
const CONFIDENCE_FACTOR: Record<Confidence, number> = {
  high: 1,
  medium: 0.75,
  low: 0.5,
};

/**
 * How directly an outsider can act on the weakness, by category.
 *
 * Email spoofing and an open admin path need nothing but an internet
 * connection. A missing Referrer-Policy needs a visitor to click an external
 * link first, and a robots.txt disclosure needs everything else to already
 * have gone wrong. The factor encodes that distance, and nothing else.
 */
const EXPOSURE_FACTOR: Record<CategoryKey, number> = {
  emailSecurity: 1,
  exposedPaths: 1,
  ssl: 0.9,
  dns: 0.8,
  subdomains: 0.8,
  whois: 0.7,
  cors: 0.7,
  headers: 0.6,
  cookies: 0.6,
  // Knowing what software a site runs is reconnaissance, not a way in. It
  // ranks low for the same reason robots.txt does: everything else has to go
  // wrong first before a technology listing helps anyone.
  technologies: 0.45,
  robotsSecurity: 0.4,
};

const CONFIDENCE_PHRASE: Record<Confidence, string> = {
  high: 'directly observed and corroborated',
  medium: 'directly observed, with a stated limitation',
  low: 'inferred from indirect signal',
};

/**
 * Ranks findings by severity × confidence × exposure, and states the
 * arithmetic. `info` findings score zero and are excluded — they describe
 * scope and context rather than anything to act on.
 */
export function prioritise(findings: Finding[], limit = 10): PrioritisedFinding[] {
  const scored = findings
    .filter((f) => f.severity !== 'info')
    .map((finding) => {
      const severity = SEVERITY_WEIGHT[finding.severity];
      const confidence = CONFIDENCE_FACTOR[finding.confidence];
      const exposure = EXPOSURE_FACTOR[finding.category] ?? 0.5;
      const priority = Math.round(severity * confidence * exposure);

      return {
        finding,
        priority,
        factors: { severity, confidence, exposure },
        rationale:
          `${finding.severity} severity (${severity}) × ${finding.confidence} confidence (×${confidence}) × ` +
          `exposure of ${finding.categoryLabel.toLowerCase()} (×${exposure}) = ${priority}. ` +
          `The evidence is ${CONFIDENCE_PHRASE[finding.confidence]}.`,
      };
    })
    .sort(
      (a, b) =>
        b.priority - a.priority ||
        SEVERITY_ORDER[a.finding.severity] - SEVERITY_ORDER[b.finding.severity] ||
        a.finding.title.localeCompare(b.finding.title),
    );

  return scored.slice(0, limit).map((entry, index) => ({ ...entry, rank: index + 1 }));
}

/**
 * Three plain-English headlines for the executive summary. Prefers the
 * highest-priority findings, then falls back to positive statements so the
 * summary is never empty on a clean domain.
 */
export function executiveHighlights(result: ScanResult): string[] {
  const ranked = prioritise(result.findings, 3);
  const lines = ranked.map((p) => `${p.finding.title} — ${p.finding.interpretation}`);

  if (lines.length < 3) {
    const strong = [...result.categories]
      .filter((c) => c.status === 'assessed' && c.score >= 80)
      .sort((a, b) => b.score - a.score);
    for (const category of strong) {
      if (lines.length >= 3) break;
      lines.push(`${category.label} is in good shape — ${category.summary}`);
    }
  }

  if (lines.length === 0) {
    lines.push(
      'No material exposure was identified from public sources during this assessment.',
    );
  }

  return lines;
}

export function categoryByKey(
  result: ScanResult,
  key: CategoryKey,
): CategoryResult | undefined {
  return result.categories.find((c) => c.key === key);
}

/** Weight of a category expressed as a percentage, for the methodology page. */
export function weightPercent(key: CategoryKey): string {
  return `${Math.round((CATEGORY_WEIGHTS[key] ?? 0) * 100)}%`;
}
