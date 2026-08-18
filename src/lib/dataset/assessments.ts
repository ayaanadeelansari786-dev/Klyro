import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import type { OwnerContext } from '../auth/context';
import { riskLevelFor } from '../scoring';
import { createServiceClient } from '../supabase/service';
import type {
  AssetInventory,
  BenchmarkResult,
  CategoryResult,
  Finding,
  ScanResult,
} from '../types';

/**
 * Writing an assessment.
 *
 * Through the service role, because no client role has an INSERT policy on
 * `assessments` — an assessment is the output of a scan Klyro ran, and letting
 * a browser write one would let it invent scores and findings under Klyro's
 * name. The ownership it is written with has already been established by
 * `resolveOwner()`, which verified the caller's membership through their own
 * credentials rather than trusting the request.
 *
 * What gets stored is the whole result. The previous implementation wrote
 * scores and findings and dropped `categories` and `inventory` on the floor,
 * which meant a saved scan could not reproduce its own report and a comparison
 * could never say which host names had appeared or disappeared. Both are
 * stored now — the inventory twice, as a document for reproducing the report
 * and as rows for diffing.
 */

/** How many host rows one assessment may write. */
const MAX_HOST_ROWS = 500;

export interface StoredAssessment {
  id: string;
}

/**
 * Persists a completed scan, or returns null when there is nothing to persist.
 *
 * Null is the normal outcome for an anonymous scan and is not an error: an
 * anonymous assessment has no owner, so no policy could ever match it, and a
 * row nobody can read is a row waiting to be leaked by the next mistake. The
 * result still streams back to the person who asked for it in full.
 */
export async function storeAssessment(
  result: ScanResult,
  benchmark: BenchmarkResult | null,
  owner: OwnerContext,
  /**
   * Whether this run also becomes a benchmark sample. Decided by
   * `shouldContributeToBenchmark` before the insert, so the row records the
   * decision from the moment it exists rather than being updated afterwards.
   */
  contributesToBenchmark = false,
): Promise<StoredAssessment | null> {
  if (!owner.userId && !owner.orgId) return null;

  const supabase = createServiceClient();
  if (!supabase) return null;

  const { data, error } = await supabase
    .from('assessments')
    .insert({
      owner_user_id: owner.userId,
      owner_org_id: owner.orgId,
      created_by: owner.createdBy,
      contributes_to_benchmark: contributesToBenchmark,

      domain: result.domain,
      industry: result.industry,
      region: result.region,

      composite_score: result.compositeScore,
      risk_level: result.riskLevel,
      coverage: result.coverage,
      tool_version: result.toolVersion,
      scanned_at: result.scannedAt,

      category_scores: result.categoryScores,
      // The three the old schema threw away.
      categories: result.categories,
      findings: result.findings,
      inventory: result.inventory ?? null,
      // Frozen at scan time on purpose: the corpus moves, and a report
      // reprinted next year should show the comparison it was written with
      // rather than a different one computed from a larger pool.
      benchmark: benchmark ?? null,
    })
    .select('id')
    .single();

  if (error || !data) return null;

  const id = (data as { id: string }).id;
  await storeHosts(supabase, id, result);

  return { id };
}

/**
 * Host rows, for the asset diff.
 *
 * Duplicates what is already inside `inventory`, and earns it: comparing two
 * assessments means asking which host names are in one and not the other, and
 * that should be an indexed join rather than parsing two JSON documents.
 *
 * A failure here is deliberately swallowed. The assessment is already written
 * and is complete on its own — the host rows are an index over data it already
 * contains, so losing them costs a future comparison some detail rather than
 * costing the user their scan.
 */
async function storeHosts(
  supabase: NonNullable<ReturnType<typeof createServiceClient>>,
  assessmentId: string,
  result: ScanResult,
): Promise<void> {
  const hosts = result.inventory?.hosts ?? [];
  if (hosts.length === 0) return;

  const rows = hosts.slice(0, MAX_HOST_ROWS).map((host) => ({
    assessment_id: assessmentId,
    host: host.host,
    origin: host.origin,
    addresses: host.addresses ?? [],
    reverse_dns: host.reverseDns ?? [],
    asns: host.asns ?? [],
    network_looked_up: host.networkLookedUp ?? false,
    naming_suggests: host.namingSuggests ?? null,
  }));

  try {
    await supabase.from('assessment_hosts').insert(rows);
  } catch {
    /* See above: an index, not the record. */
  }
}

/* ------------------------------------------------------------------ *
 * Reading an assessment back, for the report
 * ------------------------------------------------------------------ */

/** The columns a report needs. Named rather than `select *`. */
const REPORT_COLUMNS =
  'id, domain, industry, region, composite_score, risk_level, coverage, tool_version, ' +
  'scanned_at, category_scores, categories, findings, inventory, benchmark, owner_org_id, ' +
  'contributes_to_benchmark';

interface StoredRow {
  id: string;
  domain: string;
  industry: string;
  region: string;
  composite_score: number;
  risk_level: string | null;
  coverage: number | null;
  tool_version: string | null;
  scanned_at: string;
  category_scores: Record<string, number> | null;
  categories: CategoryResult[] | null;
  findings: Finding[] | null;
  inventory: AssetInventory | null;
  benchmark: BenchmarkResult | null;
  owner_org_id: string | null;
  contributes_to_benchmark: boolean | null;
}

export interface LoadedAssessment {
  result: ScanResult;
  /** What the benchmark said when the assessment was run, not now. */
  benchmark: BenchmarkResult | null;
  /** Null for a personal assessment. */
  orgId: string | null;
  /** Whether this run was also published to the shared corpus. */
  contributesToBenchmark: boolean;
}

/**
 * Loads a stored assessment for rendering.
 *
 * Read through the *caller's own* client, not the service role, and that is
 * the whole point of the function. The SELECT policy on `assessments` already
 * says exactly who may read a row — its owner, or a member of the owning
 * organisation — so passing a caller-supplied id to a policy-protected table
 * means an id belonging to somebody else simply returns nothing. The
 * alternative shape, a service-role fetch followed by comparing ids in
 * TypeScript, is the same authorisation written a second time in a place free
 * to disagree with the first, and it is an IDOR the moment somebody adds a
 * branch that forgets to compare.
 *
 * A row that does not exist and a row the caller may not read are therefore
 * indistinguishable here, and both surface as 404. That is deliberate: a 403
 * on somebody else's assessment confirms that an assessment with that id
 * exists, which is a disclosure about a domain the caller was never shown.
 */
export async function loadAssessmentForReport(
  caller: SupabaseClient,
  assessmentId: string,
): Promise<LoadedAssessment | null> {
  const { data, error } = await caller
    .from('assessments')
    .select(REPORT_COLUMNS)
    .eq('id', assessmentId)
    .maybeSingle();

  if (error || !data) return null;

  const row = data as unknown as StoredRow;

  /*
   * Rebuilt rather than sanitised.
   *
   * `sanitiseScanResult` exists because the anonymous path has to render a
   * document out of whatever the browser posts. This data was written by
   * Klyro's own scan through the service role, and the append-only trigger on
   * `assessments` refuses any update that would alter a score, a finding or a
   * category. There is nothing here for a sanitiser to defend against, so the
   * fields are read straight across and the ones the schema allows to be null
   * are given the same defaults the scan would have produced.
   */
  const result: ScanResult = {
    domain: row.domain,
    industry: row.industry,
    region: row.region,
    id: row.id,
    compositeScore: row.composite_score,
    riskLevel: (row.risk_level as ScanResult['riskLevel']) ?? riskLevelFor(row.composite_score),
    categoryScores: row.category_scores ?? {},
    categories: row.categories ?? [],
    findings: row.findings ?? [],
    coverage: row.coverage ?? 0,
    ...(row.inventory ? { inventory: row.inventory } : {}),
    scannedAt: row.scanned_at,
    toolVersion: row.tool_version ?? '',
    persisted: true,
  };

  return {
    result,
    benchmark: row.benchmark,
    orgId: row.owner_org_id,
    contributesToBenchmark: row.contributes_to_benchmark === true,
  };
}

/* ------------------------------------------------------------------ *
 * Benchmark contribution
 * ------------------------------------------------------------------ */

/**
 * Whether this scan should also become a benchmark sample.
 *
 * Two conditions, both required.
 *
 * **The organisation has opted in.** `benchmark_opt_in` is false by default
 * and always has been. An organisation assessing a supplier privately has not
 * agreed to publish "we assessed acme.com, it scored 61" to a shared corpus,
 * and inferring consent from the fact that they have an account would be
 * exactly the wrong reading. Personal assessments never contribute: there is
 * no per-user equivalent of this switch, and one person's browsing history is
 * not a corpus.
 *
 * **It is the first contribution for this domain today.** Klyro is used to
 * watch a domain change, so the same domain gets scanned repeatedly, and a
 * corpus that counted every run would let one attentive organisation stand in
 * for thirty peers — the same failure `MIN_BENCHMARK_SAMPLES` exists to
 * prevent, arriving by a different route. One sample per organisation per
 * domain per day is enough to track movement and not enough to skew an
 * average.
 *
 * The day boundary is UTC, deliberately: a boundary that moved with the
 * caller's timezone would let the same organisation contribute twice by
 * scanning either side of their local midnight.
 */
export async function shouldContributeToBenchmark(
  orgId: string | null,
  domain: string,
): Promise<boolean> {
  if (!orgId) return false;

  const supabase = createServiceClient();
  if (!supabase) return false;

  const { data: org, error: orgError } = await supabase
    .from('organisations')
    .select('benchmark_opt_in')
    .eq('id', orgId)
    .maybeSingle();

  if (orgError || !org) return false;
  if ((org as { benchmark_opt_in: boolean }).benchmark_opt_in !== true) return false;

  const startOfDay = `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;

  const { data: existing } = await supabase
    .from('assessments')
    .select('id')
    .eq('owner_org_id', orgId)
    .eq('domain', domain)
    .eq('contributes_to_benchmark', true)
    .gte('scanned_at', startOfDay)
    .limit(1)
    .maybeSingle();

  return !existing;
}

/**
 * Contributing an assessment to the public benchmark corpus.
 *
 * What a contribution consists of is written down here rather than left to a
 * caller: a domain, a score, an industry, a date. No findings, no inventory,
 * and no organisation. The row carries `assessment_id` and nothing else that
 * points anywhere, and that column is `on delete set null` so a member
 * deleting their own history does not silently rewrite an industry average
 * that has already been published.
 */
export async function contributeToBenchmark(
  assessmentId: string,
  result: ScanResult,
): Promise<void> {
  const supabase = createServiceClient();
  if (!supabase) return;

  await supabase.from('benchmark_samples').insert({
    assessment_id: assessmentId,
    domain: result.domain,
    industry: result.industry,
    region: result.region,
    composite_score: result.compositeScore,
    risk_level: result.riskLevel,
    coverage: result.coverage,
    category_scores: result.categoryScores,
    tool_version: result.toolVersion,
    scanned_at: result.scannedAt,
  });
}
