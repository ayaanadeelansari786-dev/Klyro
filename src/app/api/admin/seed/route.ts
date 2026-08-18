import { NextResponse } from 'next/server';

import { CHECKS, CHECK_ORDER, timeoutFor } from '@/lib/checks';
import { runModule } from '@/lib/checks/util';
import { buildScanResult } from '@/lib/scoring';
import { parseDomain } from '@/lib/domain';
import { findSeed, VENDOR_SEEDS, type VendorSeed } from '@/lib/dataset/vendors';
import { resolveOwnership } from '@/lib/intel/ownership';
import { assessParentInfluence } from '@/lib/intel/linkage';
import {
  insertBenchmarkSample,
  insertOwnershipAssessment,
  insertScan,
  latestScanFor,
  upsertVendor,
} from '@/lib/dataset/store';
import { isSupabaseConfigured } from '@/lib/supabase';
import type { CategoryResult, ScanResult } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/**
 * Dataset seeding endpoint — one vendor per request.
 *
 * Deliberately not part of the public scan flow: it writes to the benchmark
 * dataset, so it is token-guarded and skips the per-IP rate limiter that
 * protects the public endpoint.
 */

const CONCURRENCY = 4;

async function runScan(seed: VendorSeed): Promise<ScanResult> {
  const queue = [...CHECK_ORDER];
  const results: CategoryResult[] = [];

  async function worker() {
    for (;;) {
      const key = queue.shift();
      if (!key) return;
      results.push(await runModule(key, CHECKS[key], seed.domain, timeoutFor(key)));
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  const ordered = CHECK_ORDER.map((k) => results.find((r) => r.key === k)).filter(
    (r): r is CategoryResult => Boolean(r),
  );

  return buildScanResult(
    { domain: seed.domain, industry: seed.industry, region: seed.region },
    ordered,
  );
}

/** Rebuilds a minimal ScanResult from a stored row, for parent comparison. */
function scanFromStored(
  domain: string,
  stored: { composite_score: number; scan_metadata: { facts?: Record<string, Record<string, unknown>> } | null },
): ScanResult {
  const facts = stored.scan_metadata?.facts ?? {};
  return {
    domain,
    industry: '',
    region: '',
    compositeScore: stored.composite_score,
    riskLevel: 'Moderate Risk',
    categoryScores: {},
    categories: Object.entries(facts).map(([key, f]) => ({
      key: key as CategoryResult['key'],
      label: key,
      score: 0,
      status: 'assessed' as const,
      findings: [],
      summary: '',
      details: [],
      facts: f,
      durationMs: 0,
    })),
    findings: [],
    coverage: 1,
    scannedAt: new Date().toISOString(),
    toolVersion: '',
    persisted: true,
  };
}

export async function POST(request: Request) {
  const token = process.env.KLYRO_ADMIN_TOKEN;
  if (!token || request.headers.get('x-klyro-admin-token') !== token) {
    return NextResponse.json({ error: 'Unauthorised.' }, { status: 401 });
  }

  if (!isSupabaseConfigured) {
    return NextResponse.json(
      { error: 'Supabase is not configured; nothing would be persisted.' },
      { status: 503 },
    );
  }

  let body: { domain?: string; runLabel?: string };
  try {
    body = (await request.json()) as { domain?: string; runLabel?: string };
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }

  const parsed = parseDomain(body.domain ?? '');
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  const seed = findSeed(parsed.domain);
  if (!seed) {
    return NextResponse.json(
      { error: `${parsed.domain} is not in the curated dataset.` },
      { status: 404 },
    );
  }

  const runLabel = body.runLabel ?? `run-${new Date().toISOString().slice(0, 10)}`;
  const started = Date.now();

  try {
    const result = await runScan(seed);

    const ownership = await resolveOwnership(seed.domain, seed.displayName, seed.ownership ?? {});
    // Curated parent domain is the linkage target; the resolver may not know it.
    ownership.parentDomain = ownership.parentDomain ?? seed.ownership?.parentDomain ?? null;

    const vendorId = await upsertVendor(seed, ownership);
    const scanId = await insertScan(result, vendorId, runLabel);
    // The row the benchmark actually reads. `insertScan` writes the historical
    // table, which nothing has read since migration 0007 split the corpus out.
    const sampleId = await insertBenchmarkSample(result, runLabel);

    let linkageVerdict: string | null = null;
    if (vendorId && ownership.parentName) {
      const parentStored = ownership.parentDomain
        ? await latestScanFor(ownership.parentDomain)
        : null;

      const assessment = assessParentInfluence(
        result,
        parentStored && ownership.parentDomain
          ? scanFromStored(ownership.parentDomain, parentStored)
          : null,
        ownership,
      );
      await insertOwnershipAssessment(vendorId, assessment);
      linkageVerdict = assessment.verdict;
    }

    return NextResponse.json({
      domain: seed.domain,
      displayName: seed.displayName,
      industry: seed.industry,
      region: seed.region,
      compositeScore: result.compositeScore,
      riskLevel: result.riskLevel,
      coverage: result.coverage,
      findings: result.findings.length,
      ownership: {
        type: ownership.ownershipType,
        parent: ownership.parentName,
        parentDomain: ownership.parentDomain,
        confidence: ownership.confidence,
        sources: ownership.sources.map((s) => s.name),
        conflicts: ownership.conflicts,
      },
      linkageVerdict,
      vendorId,
      scanId,
      sampleId,
      runLabel,
      durationMs: Date.now() - started,
    });
  } catch (err) {
    return NextResponse.json(
      {
        domain: seed.domain,
        error: err instanceof Error ? err.message : 'Seeding failed.',
        durationMs: Date.now() - started,
      },
      { status: 500 },
    );
  }
}

/** Lists the dataset so a driver script knows what to seed, and in what order. */
export async function GET(request: Request) {
  const token = process.env.KLYRO_ADMIN_TOKEN;
  if (!token || request.headers.get('x-klyro-admin-token') !== token) {
    return NextResponse.json({ error: 'Unauthorised.' }, { status: 401 });
  }

  // Parents first: a subsidiary's linkage assessment compares against the
  // parent's stored scan, so the parent must already be in the database.
  const ordered = [...VENDOR_SEEDS].sort((a, b) => {
    const aParent = a.isParentEntity ? 0 : 1;
    const bParent = b.isParentEntity ? 0 : 1;
    return aParent - bParent;
  });

  return NextResponse.json({
    total: ordered.length,
    parentsFirst: ordered.filter((s) => s.isParentEntity).length,
    vendors: ordered.map((s) => ({
      domain: s.domain,
      displayName: s.displayName,
      industry: s.industry,
      region: s.region,
      isParentEntity: s.isParentEntity ?? false,
      hasCuratedParent: Boolean(s.ownership?.parentName),
    })),
  });
}
