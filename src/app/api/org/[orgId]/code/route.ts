import { NextResponse } from 'next/server';

import { revokeJoinCodes, rotateJoinCode } from '@/lib/auth/organisations';
import { clientKey, consumeRateLimit } from '@/lib/rateLimit';
import { createClientForRequest, getCurrentUser } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Issuing and revoking an organisation's join code.
 *
 * POST mints a new code and revokes the previous one. The plaintext is in the
 * response and nowhere else — the database holds an HMAC, so this response is
 * the only opportunity anyone will ever have to read it. That is stated in the
 * payload rather than left for the UI to remember.
 *
 * There is no GET returning the current code, deliberately, and adding one
 * later would defeat the design: a code that can be re-read is a code that a
 * compromised admin session can be used to fetch at leisure. Lost codes are
 * replaced, not recovered.
 */

interface Params {
  params: { orgId: string };
}

export async function POST(request: Request, { params }: Params) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Sign in first.' }, { status: 401 });

  const limit = await consumeRateLimit(`org-code:${clientKey(request)}`, 20);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: 'Too many code changes. Try again later.' },
      { status: 429, headers: { 'retry-after': String(limit.retryAfterSeconds) } },
    );
  }

  const supabase = createClientForRequest();
  if (!supabase) return NextResponse.json({ error: 'Dataset unavailable.' }, { status: 503 });

  let body: { expiresInDays?: number | null; maxUses?: number | null } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    /* Both options are optional; an empty body is a valid request. */
  }

  try {
    const issued = await rotateJoinCode(supabase, user.id, params.orgId, {
      expiresInDays: body.expiresInDays ?? null,
      maxUses: body.maxUses ?? null,
    });

    return NextResponse.json({
      code: issued.code,
      hint: issued.hint,
      expiresAt: issued.expiresAt,
      warning:
        'This is the only time this code will be shown. Klyro stores a hash of it, not the code, so it cannot be retrieved later — issue a new one if it is lost. Any previous code stopped working just now.',
    });
  } catch (error) {
    // The authorisation failure and a genuine fault are both 403 here rather
    // than 403 and 500, because distinguishing them tells a non-member that
    // the organisation exists.
    return NextResponse.json({ error: (error as Error).message }, { status: 403 });
  }
}

export async function DELETE(request: Request, { params }: Params) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Sign in first.' }, { status: 401 });

  const supabase = createClientForRequest();
  if (!supabase) return NextResponse.json({ error: 'Dataset unavailable.' }, { status: 503 });

  try {
    await revokeJoinCodes(supabase, user.id, params.orgId);
    return NextResponse.json({
      revoked: true,
      message: 'Every live code for this organisation has been revoked. Nobody new can join until you issue another.',
    });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 403 });
  }
}
