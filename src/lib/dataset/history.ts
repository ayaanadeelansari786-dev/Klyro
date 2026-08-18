/**
 * Reading saved assessments back out.
 *
 * This module used to be an exercise in reconstruction. `scan_results` stored
 * a summary — scores and findings, but not the category detail and not the
 * inventory — so a stored scan had to be rebuilt into something the
 * comparison could read, and the rebuild had to guess: a category absent from
 * `category_scores` was inferred to have been unavailable, coverage was
 * derived by re-summing weights, and the host list was simply gone, which is
 * why comparisons could never report which assets had appeared or vanished.
 *
 * `assessments` stores the whole result, so almost all of that is deleted. The
 * categories come back as they went in. What remains here is the reverse of
 * the write: mapping snake_case columns onto the `ScanResult` shape the rest
 * of the application already speaks.
 *
 * Every function takes a client rather than choosing one. These read private
 * data, and the caller is the only place that knows whose rights it should be
 * read with — passing a service client here would silently disable row level
 * security on the most sensitive table in the schema.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import type {
  AssetInventory,
  BenchmarkResult,
  CategoryResult,
  Finding,
  ScanResult,
} from '../types';

export interface AssessmentRow {
  id: string;
  owner_user_id: string | null;
  owner_org_id: string | null;
  domain: string;
  industry: string;
  region: string;
  composite_score: number;
  risk_level: string | null;
  coverage: number | null;
  tool_version: string | null;
  scanned_at: string;
  category_scores: Record<string, number> | null;
  categories: unknown;
  findings: unknown;
  inventory: unknown;
  benchmark: unknown;
}

const COLUMNS =
  'id, owner_user_id, owner_org_id, domain, industry, region, composite_score, risk_level, ' +
  'coverage, tool_version, scanned_at, category_scores, categories, findings, inventory, benchmark';

/**
 * True when a stored finding predates the observation/interpretation/risk
 * model.
 *
 * Retained because the dashboard renders it, and because a report exported
 * from an old assessment should say that its findings carry less structure
 * rather than showing empty fields. Nothing in `assessments` can be in this
 * shape today — the table was created after the evidence model — so this is a
 * guard against imported or migrated data, not a live code path.
 */
export function isLegacyFinding(finding: Finding): boolean {
  return !finding.observed && !finding.interpretation;
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/**
 * Reads a Postgres `numeric` column.
 *
 * Drivers return `numeric` as a *string*, not a number — the type is arbitrary
 * precision and JavaScript's number is not, so handing back a float would lose
 * data silently. Coverage is stored as numeric, and a naive
 * `typeof value === 'number'` check therefore always failed and fell through
 * to the default of 1. Every saved assessment would have reported 100%
 * coverage regardless of how many modules actually reached a source, which is
 * precisely the kind of quiet overclaim the coverage figure exists to prevent.
 */
function asNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

/** Maps one stored row onto the shape the dashboard, PDF and diff all read. */
export function assessmentFromRow(row: AssessmentRow): ScanResult {
  const categories = asArray<CategoryResult>(row.categories);

  return {
    id: row.id,
    domain: row.domain,
    industry: row.industry,
    region: row.region,
    compositeScore: asNumber(row.composite_score, 0),
    riskLevel: (row.risk_level as ScanResult['riskLevel']) ?? 'Moderate Risk',
    categoryScores: row.category_scores ?? {},
    categories,
    findings: asArray<Finding>(row.findings),
    coverage: asNumber(row.coverage, 1),
    inventory: (row.inventory as AssetInventory | null) ?? undefined,
    scannedAt: row.scanned_at,
    toolVersion: row.tool_version ?? '',
    persisted: true,
  };
}

/** The benchmark as it stood when the assessment was run, if one was stored. */
export function storedBenchmark(row: AssessmentRow): BenchmarkResult | null {
  return (row.benchmark as BenchmarkResult | null) ?? null;
}

/**
 * Recent assessments of one domain, newest first, within whatever the caller
 * is allowed to see.
 *
 * There is no ownership filter in this query, and that is deliberate rather
 * than an omission: the policy on `assessments` restricts the result to the
 * caller's own and their organisations'. Adding a `.eq('owner_user_id', ...)`
 * here would look safer and would in fact be less safe, because it would
 * suggest the filtering happens in application code and invite someone to
 * "optimise" the policy away later.
 */
export async function recentAssessmentsFor(
  supabase: SupabaseClient,
  domain: string,
  limit = 20,
): Promise<AssessmentRow[]> {
  try {
    const { data, error } = await supabase
      .from('assessments')
      .select(COLUMNS)
      .eq('domain', domain.toLowerCase())
      .order('scanned_at', { ascending: false })
      .limit(limit);

    if (error || !data) return [];
    return data as unknown as AssessmentRow[];
  } catch {
    return [];
  }
}

/** One assessment by id, or null when it does not exist *for this caller*. */
export async function assessmentById(
  supabase: SupabaseClient,
  id: string,
): Promise<AssessmentRow | null> {
  try {
    const { data, error } = await supabase
      .from('assessments')
      .select(COLUMNS)
      .eq('id', id)
      .maybeSingle();

    if (error || !data) return null;
    return data as unknown as AssessmentRow;
  } catch {
    return null;
  }
}

/**
 * Host names recorded for an assessment.
 *
 * Read from `assessment_hosts` rather than out of the inventory JSON, because
 * this is what makes an asset diff a join instead of two document parses. The
 * child table inherits the parent's visibility through its own policy, so an
 * assessment the caller cannot see returns no hosts rather than an error.
 */
export async function hostsForAssessments(
  supabase: SupabaseClient,
  assessmentIds: string[],
): Promise<Map<string, string[]>> {
  const byAssessment = new Map<string, string[]>();
  if (assessmentIds.length === 0) return byAssessment;

  try {
    const { data, error } = await supabase
      .from('assessment_hosts')
      .select('assessment_id, host')
      .in('assessment_id', assessmentIds);

    if (error || !data) return byAssessment;

    for (const row of data as unknown as { assessment_id: string; host: string }[]) {
      const list = byAssessment.get(row.assessment_id) ?? [];
      list.push(row.host);
      byAssessment.set(row.assessment_id, list);
    }
  } catch {
    /* An unreadable host table degrades the diff; it does not break it. */
  }

  return byAssessment;
}

/**
 * Puts recorded host names back onto a scan for the purpose of diffing.
 *
 * An assessment stored with a full inventory already has its hosts and is
 * returned unchanged. This covers the other case: a row whose inventory
 * document is missing or empty but whose host rows survive — an assessment
 * written when the inventory pass failed, or one imported from elsewhere. The
 * host rows are the authority for *which names existed*, so a diff can still
 * report new and removed assets even when the richer document is gone.
 *
 * Kept here rather than inline in the compare route so that the test for asset
 * diffing exercises the code the route runs, not a copy of it.
 */
export function attachRecordedHosts(scan: ScanResult, hosts: string[] | undefined): ScanResult {
  if (!hosts || hosts.length === 0) return scan;
  if (scan.inventory && scan.inventory.hosts.length > 0) return scan;

  return {
    ...scan,
    inventory: {
      domain: scan.domain,
      hosts: hosts.map((host) => ({
        host,
        origin: 'certificate-transparency' as const,
        addresses: [],
        reverseDns: [],
        asns: [],
        networkLookedUp: false,
        namingSuggests: null,
      })),
      networks: [],
      technologies: [],
      unresolvedHosts: 0,
      limits: [
        'Host names for this assessment were read from the stored host index rather than from a full inventory, so addresses and network attribution are not shown.',
      ],
      collectedAt: scan.scannedAt,
    },
  };
}

/**
 * The assessments a caller can see, newest first, for their history page.
 *
 * `scope` narrows to personal or a single organisation. Omitted, it returns
 * everything the policy allows, which is the union of both.
 */
export async function recentAssessments(
  supabase: SupabaseClient,
  options: { userId?: string; orgId?: string; limit?: number } = {},
): Promise<AssessmentRow[]> {
  try {
    let query = supabase
      .from('assessments')
      .select(COLUMNS)
      .order('scanned_at', { ascending: false })
      .limit(options.limit ?? 50);

    if (options.orgId) query = query.eq('owner_org_id', options.orgId);
    else if (options.userId) query = query.eq('owner_user_id', options.userId);

    const { data, error } = await query;
    if (error || !data) return [];
    return data as unknown as AssessmentRow[];
  } catch {
    return [];
  }
}
