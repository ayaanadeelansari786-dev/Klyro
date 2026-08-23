import { NextResponse } from 'next/server';

import { clientKey, consumeRateLimit } from '@/lib/rateLimit';
import { createClientForRequest, getCurrentUser } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Organisation settings.
 *
 * Exactly one field is writable here, and adding a second should be a
 * deliberate act rather than a convenience: this is the route that decides
 * whether an organisation's assessments become public data, so the smaller
 * its surface the easier it is to be sure of.
 *
 * Authorisation is the database's. The UPDATE policy on `organisations` is
 * `app.has_org_role(id, 'admin')`, so this runs as the caller and a viewer or
 * analyst simply updates no rows. Re-checking the role here in TypeScript
 * would be a second copy of the rule, free to disagree with the first.
 */

interface Params {
  params: { orgId: string };
}

interface PatchBody {
  benchmarkOptIn?: unknown;
}

interface DeleteBody {
  confirm?: unknown;
}

export async function PATCH(request: Request, { params }: Params) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Sign in first.' }, { status: 401 });

  const limit = await consumeRateLimit(`org-settings:${clientKey(request)}`, 30);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: 'Too many settings changes. Try again later.' },
      { status: 429, headers: { 'retry-after': String(limit.retryAfterSeconds) } },
    );
  }

  const supabase = createClientForRequest();
  if (!supabase) return NextResponse.json({ error: 'Dataset unavailable.' }, { status: 503 });

  let body: PatchBody;
  try {
    body = (await request.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }

  if (typeof body.benchmarkOptIn !== 'boolean') {
    return NextResponse.json(
      { error: 'benchmarkOptIn must be true or false.' },
      { status: 400 },
    );
  }

  const { data, error } = await supabase
    .from('organisations')
    .update({ benchmark_opt_in: body.benchmarkOptIn })
    .eq('id', params.orgId)
    .select('id, benchmark_opt_in');

  if (error) {
    return NextResponse.json({ error: 'Could not update the organisation.' }, { status: 400 });
  }

  /*
   * No rows came back, which means the policy refused. Both "you are not an
   * administrator" and "no such organisation" land here, and both get the same
   * answer — telling a non-member that the organisation exists is a
   * disclosure, and it is the same reasoning the join-code route and the
   * organisation page already follow.
   */
  if (!data || data.length === 0) {
    return NextResponse.json(
      { error: 'Only an administrator or owner can change this setting.' },
      { status: 403 },
    );
  }

  const optedIn = (data[0] as { benchmark_opt_in: boolean }).benchmark_opt_in;

  return NextResponse.json({
    benchmarkOptIn: optedIn,
    message: optedIn
      ? 'This organisation now contributes anonymised scores to the industry benchmarks. Assessments already run are unaffected — contribution starts with the next one.'
      : 'This organisation no longer contributes to the industry benchmarks. Samples already published stay in the corpus; no new ones will be added.',
  });
}

/**
 * Deleting an organisation, which is not only deleting an organisation.
 *
 * `assessments.owner_org_id` is `on delete cascade`, and the table's check
 * constraint requires exactly one of `owner_user_id` / `owner_org_id` to be
 * set — so there is no "orphan them to the person who ran them" option
 * available. Removing the organisation removes every assessment filed under
 * it, for every member, permanently. So do its join codes, its member rows,
 * and its saved vendors. Anonymised rows already published to the shared
 * benchmark corpus are not affected; they carry no organisation reference by
 * design.
 *
 * That is what the caller asked for, and it is irreversible, so this route
 * makes the caller name the thing they are destroying: the request body must
 * carry the organisation's exact name. That check is a guard against a
 * mis-click, not against an attacker — an attacker posting deliberately would
 * simply include the name. The check that matters is the DELETE policy on
 * `organisations`, which is `app.has_org_role(id, 'owner')`; this runs as the
 * caller, so an admin, analyst, or viewer deletes no rows no matter what they
 * post. As everywhere else in this file, the role is not re-tested in
 * TypeScript — a second copy of the rule is a second chance to get it wrong.
 */
export async function DELETE(request: Request, { params }: Params) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Sign in first.' }, { status: 401 });

  const limit = await consumeRateLimit(`org-delete:${clientKey(request)}`, 10);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: 'Too many attempts. Try again later.' },
      { status: 429, headers: { 'retry-after': String(limit.retryAfterSeconds) } },
    );
  }

  const supabase = createClientForRequest();
  if (!supabase) return NextResponse.json({ error: 'Dataset unavailable.' }, { status: 503 });

  let body: DeleteBody;
  try {
    body = (await request.json()) as DeleteBody;
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }

  const confirm = typeof body.confirm === 'string' ? body.confirm.trim() : '';

  /*
   * Read before deleting so the confirmation can be compared against the real
   * name. A non-member reads nothing here and gets the same 403 a viewer gets
   * — the organisation's existence is not confirmed to someone outside it,
   * which is the rule the settings page and the join-code route already
   * follow.
   */
  const { data: org } = await supabase
    .from('organisations')
    .select('id, name')
    .eq('id', params.orgId)
    .maybeSingle();

  if (!org) {
    return NextResponse.json(
      { error: 'Only an owner can delete this organisation.' },
      { status: 403 },
    );
  }

  const name = (org as { name: string }).name;

  if (confirm !== name.trim()) {
    return NextResponse.json(
      { error: `Type the organisation's name exactly — ${name} — to confirm.` },
      { status: 400 },
    );
  }

  const { data, error } = await supabase
    .from('organisations')
    .delete()
    .eq('id', params.orgId)
    .select('id');

  if (error) {
    return NextResponse.json({ error: 'Could not delete the organisation.' }, { status: 400 });
  }

  // No rows came back: the policy refused, so the caller is not an owner.
  if (!data || data.length === 0) {
    return NextResponse.json(
      { error: 'Only an owner can delete this organisation.' },
      { status: 403 },
    );
  }

  return NextResponse.json({
    deleted: true,
    message: `${name} and every assessment filed under it have been deleted.`,
  });
}
