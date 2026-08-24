import { NextResponse } from 'next/server';

import { createOrganisation } from '@/lib/auth/organisations';
import { clientKey, consumeRateLimit } from '@/lib/rateLimit';
import { createClientForRequest, getCurrentUser } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The organisations the caller belongs to.
 *
 * Read through the caller's own client, so the policy decides which
 * organisations are visible at all — and then filtered to the caller's own
 * membership row, because the policy scopes by organisation rather than by
 * member. See the note on the query.
 */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ organisations: [] });

  const supabase = createClientForRequest();
  if (!supabase) return NextResponse.json({ organisations: [] });

  /*
   * Filtered to the caller's own membership row, which is not the same thing
   * as trusting the application to enforce the boundary.
   *
   * The policy on `organisation_members` is `app.is_org_member(org_id)`: it
   * scopes rows to organisations you belong to, not to *your* membership of
   * them. So an unfiltered read returns one row per member of every
   * organisation you are in — org1 with two people came back twice, and the
   * `role` attached to each row was whichever member it described rather than
   * the reader.
   *
   * That produced a duplicated organisation list and, worse, a role read off
   * somebody else's row: a viewer sitting in an organisation with an owner
   * picked up `owner`, so the scan form offered to file under an organisation
   * the database then refused to accept it for.
   *
   * The security boundary is still the policy — this filter narrows a set the
   * policy has already restricted, and removing it would leak nothing. It is
   * here for correctness: it is how a row about *me* is told apart from a row
   * about a colleague.
   */
  const { data, error } = await supabase
    .from('organisation_members')
    .select('role, organisations(id, name, slug)')
    .eq('user_id', user.id)
    .order('joined_at', { ascending: true });

  if (error) return NextResponse.json({ organisations: [] });

  const organisations = (data ?? [])
    .map((row) => {
      const entry = row as unknown as {
        role: string;
        organisations: { id: string; name: string; slug: string } | null;
      };
      if (!entry.organisations) return null;
      return { ...entry.organisations, role: entry.role };
    })
    .filter(Boolean);

  return NextResponse.json({ organisations });
}

/** Creates an organisation, with the caller as its owner. */
export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json(
      { error: 'Sign in to create an organisation.' },
      { status: 401 },
    );
  }

  // Creating organisations is cheap for us and a convenient way to fill a
  // table for someone else, so it is bounded like everything else.
  const limit = await consumeRateLimit(`org-create:${clientKey(request)}`, 10);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: 'Too many organisations created recently. Try again later.' },
      { status: 429, headers: { 'retry-after': String(limit.retryAfterSeconds) } },
    );
  }

  let body: { name?: string };
  try {
    body = (await request.json()) as { name?: string };
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }

  try {
    const organisation = await createOrganisation(user.id, body.name ?? '');
    return NextResponse.json({ organisation }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 });
  }
}
