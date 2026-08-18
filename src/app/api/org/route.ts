import { NextResponse } from 'next/server';

import { createOrganisation } from '@/lib/auth/organisations';
import { clientKey, consumeRateLimit } from '@/lib/rateLimit';
import { createClientForRequest, getCurrentUser } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The organisations the caller belongs to.
 *
 * Read through the caller's own client, so the policy decides. There is no
 * `where user_id = ...` here and there should not be one — see the note in
 * `recentAssessmentsFor` for why an application-level filter over a
 * policy-protected table is worse than none.
 */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ organisations: [] });

  const supabase = createClientForRequest();
  if (!supabase) return NextResponse.json({ organisations: [] });

  const { data, error } = await supabase
    .from('organisation_members')
    .select('role, organisations(id, name, slug)')
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
