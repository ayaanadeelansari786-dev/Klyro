import { NextResponse } from 'next/server';

import { joinWithCode } from '@/lib/auth/organisations';
import { clientKey, consumeRateLimit } from '@/lib/rateLimit';
import { getCurrentUser } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Redeems an organisation join code.
 *
 * This is the one endpoint in the product where an attacker has something
 * specific to guess. A join code is worth roughly 49 bits, which makes offline
 * search hopeless, but online guessing is only as hard as the rate limit makes
 * it — so the limit here is far tighter than elsewhere, and it is keyed on the
 * caller rather than on the code, since keying on the code would let an
 * attacker spread attempts across many candidates for free.
 *
 * `joinWithCode` returns one message for every kind of failure. Telling the
 * difference between "no such code", "expired" and "used up" would confirm
 * which guesses were codes, and a search with feedback is a different problem
 * from a search without it.
 */
export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json(
      { error: 'Sign in first, then enter your join code.' },
      { status: 401 },
    );
  }

  // Ten attempts an hour. A person typing a code they were given needs two or
  // three; anyone needing more than ten is not typing.
  const limit = await consumeRateLimit(`org-join:${clientKey(request)}`, 10);
  if (!limit.allowed) {
    return NextResponse.json(
      {
        error: 'Too many join attempts. Try again later.',
      },
      { status: 429, headers: { 'retry-after': String(limit.retryAfterSeconds) } },
    );
  }

  let body: { code?: string };
  try {
    body = (await request.json()) as { code?: string };
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }

  try {
    const outcome = await joinWithCode(user.id, body.code ?? '');

    if (!outcome.ok) {
      return NextResponse.json({ error: outcome.reason }, { status: 400 });
    }

    return NextResponse.json({
      organisation: { id: outcome.orgId, name: outcome.orgName },
      alreadyMember: outcome.alreadyMember,
      message: outcome.alreadyMember
        ? `You are already a member of ${outcome.orgName}.`
        : `You have joined ${outcome.orgName} as a viewer. An administrator can change your role.`,
    });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
