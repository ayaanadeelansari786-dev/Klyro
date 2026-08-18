import { NextResponse } from 'next/server';

import { createPublicClient } from '@/lib/supabase/public';
import { parseDomain } from '@/lib/domain';
import { clientKey, consumeRateLimit } from '@/lib/rateLimit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Ownership context for a scanned domain, if it exists in the benchmark
 * dataset. Returns `known: false` rather than guessing — an unknown owner is
 * reported as unknown.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = parseDomain(url.searchParams.get('domain') ?? '');
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const limit = await consumeRateLimit(`ownership:${clientKey(request)}`, 120);
  if (!limit.allowed) return NextResponse.json({ error: 'Rate limit exceeded.' }, { status: 429 });

  const supabase = createPublicClient();
  if (!supabase) return NextResponse.json({ known: false, reason: 'dataset unavailable' });

  const { data: vendor } = await supabase
    .from('vendors')
    .select(
      'domain, display_name, legal_name, industry, region, hq_country, ownership_type, parent_name, parent_domain, ultimate_parent_name, ownership_source, ownership_source_url, ownership_confidence, ownership_note, lei',
    )
    .eq('domain', parsed.domain)
    .maybeSingle();

  if (!vendor) return NextResponse.json({ known: false, reason: 'not in dataset' });

  const { data: assessment } = await supabase
    .from('ownership_assessments')
    .select(
      'parent_name, parent_domain, linkage_verdict, linkage_signals, vendor_score, parent_score, score_delta, narrative, evidence, assessed_at',
    )
    .eq('vendor_domain', parsed.domain)
    .order('assessed_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  return NextResponse.json({ known: true, vendor, assessment: assessment ?? null });
}
