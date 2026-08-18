import { NextResponse } from 'next/server';

import { compareScans } from '@/lib/compare';
import {
  assessmentFromRow,
  attachRecordedHosts,
  hostsForAssessments,
  recentAssessmentsFor,
  type AssessmentRow,
} from '@/lib/dataset/history';
import { parseDomain } from '@/lib/domain';
import { clientKey, consumeRateLimit } from '@/lib/rateLimit';
import { isSupabaseConfigured } from '@/lib/supabase';
import { createClientForRequest, getCurrentUser } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Diffs two stored assessments of one domain.
 *
 * ## The vulnerability this endpoint used to have
 *
 * It took a domain, read every stored scan of it, and returned them. There was
 * no authentication and no ownership — because when it was written, every scan
 * was anonymous and world-readable, so there was nothing to protect. The
 * moment assessments gained owners, that same code became a direct object
 * reference over the most sensitive data in the product, and an unusually easy
 * one to exploit: the identifier was not a UUID to be guessed but a company
 * name to be typed. `?domain=acme.com` would have returned Acme's supplier
 * assessments to anyone who wondered.
 *
 * ## How it is closed
 *
 * The read runs through the caller's own Supabase client, so the policy on
 * `assessments` decides what comes back. An assessment belonging to someone
 * else is not filtered out by code in this file — it never arrives. There is
 * deliberately no `.eq('owner_user_id', ...)` here to make that look safer;
 * see the note in `recentAssessmentsFor`.
 *
 * Two consequences worth stating plainly. Anonymous callers get nothing, since
 * anonymous scans are no longer stored at all. And a signed-in user comparing
 * a domain sees only their own and their organisations' assessments of it,
 * which is the only honest answer — another customer's assessment of the same
 * supplier is not part of their history.
 *
 * Still read-only, still not monitoring: two runs that already exist are
 * diffed on request, and nothing reassesses on a schedule.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);

  const parsed = parseDomain(url.searchParams.get('domain') ?? '');
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  const limit = await consumeRateLimit(`compare:${clientKey(request)}`, 60);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: 'Rate limit exceeded. Try again later.' },
      { status: 429, headers: { 'retry-after': String(limit.retryAfterSeconds) } },
    );
  }

  if (!isSupabaseConfigured) {
    return NextResponse.json(
      {
        error:
          'Comparison reads previously saved assessments, and no dataset is configured for this deployment.',
      },
      { status: 503 },
    );
  }

  /*
   * Authentication is checked explicitly, even though the policy would return
   * nothing to an anonymous caller anyway.
   *
   * Relying on the empty result would be correct and would produce a confusing
   * product: a signed-out visitor would be told "no assessments found", which
   * is true but reads as though their scan was lost. Saying why costs one
   * round trip and is the difference between a dead end and a next step.
   */
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json(
      {
        domain: parsed.domain,
        available: [],
        comparison: null,
        requiresAuth: true,
        error:
          'Comparison works across your saved assessments. Anonymous assessments are not stored, so there is no history to compare — sign in and run two assessments of this domain to see what changed between them.',
      },
      { status: 401 },
    );
  }

  const supabase = createClientForRequest();
  if (!supabase) {
    return NextResponse.json({ error: 'Dataset unavailable.' }, { status: 503 });
  }

  // Row level security scopes this to the caller. Nothing below re-checks
  // ownership, because nothing below could see a row it should not.
  const rows = await recentAssessmentsFor(supabase, parsed.domain);

  const available = rows.map((row) => ({
    id: row.id,
    scannedAt: row.scanned_at,
    compositeScore: row.composite_score,
    coverage: row.coverage ?? 1,
    scope: row.owner_org_id ? 'organisation' : 'personal',
  }));

  if (rows.length < 2) {
    return NextResponse.json({
      domain: parsed.domain,
      available,
      comparison: null,
      error:
        rows.length === 0
          ? `You have no saved assessments of ${parsed.domain}. Every assessment you run while signed in is kept, so the next one can be compared against it.`
          : `You have one saved assessment of ${parsed.domain}. A comparison needs two.`,
    });
  }

  /*
   * Assessments are selected by id, not by timestamp.
   *
   * The previous version matched on `scannedAt`, which worked but made the
   * identifier a value the caller could construct rather than one they had to
   * have been given. Ids are UUIDs, and — more importantly — an id that is not
   * theirs simply does not resolve, because the lookup happens inside the set
   * the policy already returned.
   */
  const pick = (value: string | null, fallback: number): AssessmentRow =>
    (value ? rows.find((row) => row.id === value) : undefined) ?? rows[fallback];

  // rows[0] is the most recent, so the default baseline is the one before it.
  const current = pick(url.searchParams.get('current'), 0);
  const baseline = pick(url.searchParams.get('baseline'), 1);

  if (current.id === baseline.id) {
    return NextResponse.json({
      domain: parsed.domain,
      available,
      comparison: null,
      error: 'Select two different assessments to compare.',
    });
  }

  /*
   * Host names come from `assessment_hosts` rather than from the inventory
   * document, which is what finally makes the asset diff work. The child
   * table's policy defers to the parent assessment's, so this cannot return
   * hosts belonging to an assessment the caller could not read.
   */
  const hosts = await hostsForAssessments(supabase, [current.id, baseline.id]);

  const withHosts = (row: AssessmentRow) =>
    attachRecordedHosts(assessmentFromRow(row), hosts.get(row.id));

  // Order them so the diff always reads forwards in time regardless of which
  // way round the caller named them.
  const [older, newer] =
    Date.parse(baseline.scanned_at) <= Date.parse(current.scanned_at)
      ? [baseline, current]
      : [current, baseline];

  return NextResponse.json({
    domain: parsed.domain,
    available,
    comparison: compareScans(withHosts(older), withHosts(newer)),
  });
}
