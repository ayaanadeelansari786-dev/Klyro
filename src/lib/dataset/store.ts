import { createServiceClient } from '../supabase/service';
import type { ScanResult } from '../types';
import type { OwnershipRecord } from '../intel/ownership';
import type { ParentInfluenceAssessment } from '../intel/linkage';
import type { VendorSeed } from './vendors';

/** Upserts the canonical vendor row and returns its id. */
export async function upsertVendor(
  seed: VendorSeed,
  ownership: OwnershipRecord | null,
): Promise<string | null> {
  const supabase = createServiceClient();
  if (!supabase) return null;

  const row = {
    domain: seed.domain,
    display_name: seed.displayName,
    legal_name: ownership?.legalName ?? seed.ownership?.legalName ?? null,
    industry: seed.industry,
    region: seed.region,
    hq_country: ownership?.hqCountry ?? seed.ownership?.hqCountry ?? null,
    ownership_type: ownership?.ownershipType ?? seed.ownership?.ownershipType ?? 'unknown',
    parent_name: ownership?.parentName ?? seed.ownership?.parentName ?? null,
    parent_domain: ownership?.parentDomain ?? seed.ownership?.parentDomain ?? null,
    ultimate_parent_name: ownership?.ultimateParentName ?? null,
    ownership_source: ownership?.sources.map((s) => s.name).join('; ') || null,
    ownership_source_url: seed.ownership?.sourceUrl ?? ownership?.sources[0]?.url ?? null,
    ownership_confidence: ownership?.confidence ?? 'unknown',
    ownership_note:
      [
        ...(ownership?.sources.map((s) => `${s.name}: ${s.detail}`) ?? []),
        ...(ownership?.conflicts.map((c) => `CONFLICT — ${c}`) ?? []),
      ].join(' | ') || null,
    lei: ownership?.lei ?? null,
    is_parent_entity: seed.isParentEntity ?? false,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from('vendors')
    .upsert(row, { onConflict: 'domain' })
    .select('id')
    .single();

  if (error) throw new Error(`vendor upsert failed: ${error.message}`);
  return (data?.id as string) ?? null;
}

/** Inserts one historical scan row. Every run is kept — nothing is replaced. */
export async function insertScan(
  result: ScanResult,
  vendorId: string | null,
  runLabel: string,
): Promise<string | null> {
  const supabase = createServiceClient();
  if (!supabase) return null;

  const { data, error } = await supabase
    .from('scan_results')
    .insert({
      vendor_id: vendorId,
      domain: result.domain,
      industry: result.industry,
      region: result.region,
      composite_score: result.compositeScore,
      risk_level: result.riskLevel,
      coverage: result.coverage,
      tool_version: result.toolVersion,
      run_label: runLabel,
      category_scores: result.categoryScores,
      findings: result.findings,
      scan_metadata: {
        categorySummaries: Object.fromEntries(
          result.categories.map((c) => [c.key, { status: c.status, summary: c.summary }]),
        ),
        facts: Object.fromEntries(
          result.categories.filter((c) => c.facts).map((c) => [c.key, c.facts]),
        ),
      },
    })
    .select('id')
    .single();

  if (error) throw new Error(`scan insert failed: ${error.message}`);
  return (data?.id as string) ?? null;
}

/**
 * Inserts one benchmark sample from a seeded run.
 *
 * Separate from `insertScan` because the two tables are now separate things.
 * Migration 0007 split the corpus out of `scan_results` and every read path —
 * percentiles, industry averages, the rankings page — moved to
 * `benchmark_samples`; the seeding path did not move with it, so seeded
 * vendors were being written to a table nothing reads any more. This is what
 * puts them back in the pool.
 *
 * `assessment_id` is null and correctly so. A seeded run has no assessment
 * behind it: nobody's organisation ran it, and there is no private row for it
 * to point at.
 */
export async function insertBenchmarkSample(
  result: ScanResult,
  runLabel: string,
): Promise<string | null> {
  const supabase = createServiceClient();
  if (!supabase) return null;

  const { data, error } = await supabase
    .from('benchmark_samples')
    .insert({
      assessment_id: null,
      domain: result.domain,
      industry: result.industry,
      region: result.region,
      composite_score: result.compositeScore,
      risk_level: result.riskLevel,
      coverage: result.coverage,
      category_scores: result.categoryScores,
      tool_version: result.toolVersion,
      run_label: runLabel,
      scanned_at: result.scannedAt,
    })
    .select('id')
    .single();

  if (error) throw new Error(`benchmark sample insert failed: ${error.message}`);
  return (data?.id as string) ?? null;
}

export async function insertOwnershipAssessment(
  vendorId: string,
  assessment: ParentInfluenceAssessment,
): Promise<void> {
  const supabase = createServiceClient();
  if (!supabase) return;

  const signal = (label: string) =>
    assessment.signals.find((s) => s.label === label)?.shared ?? null;

  const { error } = await supabase.from('ownership_assessments').insert({
    vendor_id: vendorId,
    vendor_domain: assessment.vendorDomain,
    parent_domain: assessment.parentDomain,
    parent_name: assessment.parentName,
    shares_nameservers: signal('DNS hosting'),
    shares_mail_provider: signal('Email platform'),
    shares_tls_issuer: signal('Certificate authority'),
    shares_registrar: signal('Domain registrar'),
    linkage_signals: assessment.signalsShared,
    linkage_verdict: assessment.verdict,
    vendor_score: assessment.vendorScore,
    parent_score: assessment.parentScore,
    score_delta: assessment.scoreDelta,
    narrative: assessment.narrative,
    evidence: { signals: assessment.signals, signalsTested: assessment.signalsTested },
  });

  if (error) throw new Error(`ownership assessment insert failed: ${error.message}`);
}

/** Most recent scan for a domain, used to compare a subsidiary to its parent. */
export async function latestScanFor(domain: string): Promise<{
  composite_score: number;
  scan_metadata: { facts?: Record<string, Record<string, unknown>> } | null;
} | null> {
  const supabase = createServiceClient();
  if (!supabase) return null;

  const { data, error } = await supabase
    .from('scan_results')
    .select('composite_score, scan_metadata')
    .eq('domain', domain)
    .order('scanned_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) return null;
  return data as { composite_score: number; scan_metadata: { facts?: Record<string, Record<string, unknown>> } | null };
}
