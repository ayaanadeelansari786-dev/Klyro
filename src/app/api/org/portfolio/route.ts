import { NextResponse } from 'next/server';

import { organisationPortfolio } from '@/lib/dataset/portfolio';
import { parseDomain } from '@/lib/domain';
import { INDUSTRIES } from '@/lib/constants';
import { createClientForRequest, getCurrentUser } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * How a vendor sits against the others this organisation has assessed.
 *
 * Read through the caller's own client, so the policy on `assessments`
 * decides what is in the pool. A caller who is not a member of the
 * organisation they name gets an empty portfolio rather than a refusal —
 * the same shape a member with nothing assessed yet gets, which is what
 * keeps the endpoint from confirming that an organisation with that id
 * exists.
 *
 * Every failure returns `{ portfolio: null }` with a 200. This panel is
 * enrichment beside an assessment that has already been produced; a 500 here
 * would turn a missing comparison into an error banner on a report that is
 * otherwise complete.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const orgId = url.searchParams.get('org') ?? '';
  const industry = url.searchParams.get('industry') ?? '';
  const domainRaw = url.searchParams.get('domain') ?? '';
  const scoreRaw = url.searchParams.get('score') ?? '';

  const none = NextResponse.json({ portfolio: null });

  if (!orgId) return none;

  // Checked against the fixed list rather than trusted, so the equality filter
  // downstream is matching a known value and not arbitrary caller text.
  if (!(INDUSTRIES as readonly string[]).includes(industry)) return none;

  const parsed = parseDomain(domainRaw);
  if (!parsed.ok) return none;

  const score = Number(scoreRaw);
  if (!Number.isFinite(score) || score < 0 || score > 100) return none;

  const user = await getCurrentUser();
  if (!user) return none;

  const supabase = createClientForRequest();
  if (!supabase) return none;

  const portfolio = await organisationPortfolio(supabase, {
    orgId,
    industry,
    domain: parsed.domain,
    score: Math.round(score),
  });

  return NextResponse.json({ portfolio });
}
