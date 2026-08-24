import { NextResponse } from 'next/server';

import type { OrgRole } from '@/lib/auth/context';
import { clientKey, consumeRateLimit } from '@/lib/rateLimit';
import { createClientForRequest, getCurrentUser } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Changing what a member may do, and removing them.
 *
 * Authorisation is entirely the database's, as everywhere else in this
 * directory. The UPDATE policy on `organisation_members` is
 * `app.has_org_role(org_id, 'admin') and (role <> 'owner' or
 * app.has_org_role(org_id, 'owner'))`, in both USING and WITH CHECK, which
 * encodes three rules at once:
 *
 *   - an admin may change anyone who is not an owner,
 *   - an admin may not promote anyone — themselves included — to owner,
 *   - only an owner may create another owner, or change an existing one.
 *
 * Re-testing any of that here would be a second copy of the rule, free to
 * disagree with the first. The route attempts the write and interprets the
 * database's answer instead — which arrives in two different shapes
 * depending on which half of the policy refused, and both have to be
 * handled. See `INSUFFICIENT_PRIVILEGE` below; the difference was found by
 * testing against the real policy rather than reading it.
 *
 * The last-owner rule is not a policy but a constraint trigger
 * (`app.assert_owner_remains`), which fires at commit and raises
 * `check_violation`. Its message is written for a person to read, so it is
 * passed through rather than replaced.
 */

interface Params {
  params: { orgId: string };
}

const ROLES: OrgRole[] = ['viewer', 'analyst', 'admin', 'owner'];

/** Postgres `check_violation`, raised by the owner-remains trigger. */
const CHECK_VIOLATION = '23514';

/**
 * Postgres `insufficient_privilege`, raised when a row-level-security
 * WITH CHECK fails.
 *
 * The two halves of a policy refuse differently and the difference is not
 * obvious: a USING clause *filters*, so a forbidden row is simply not seen
 * and the update reports zero rows; a WITH CHECK clause *raises*, because the
 * row was visible and the new version of it is not allowed. On
 * `organisation_members` both halves carry the same test, so which one fires
 * depends on the direction of the change: an admin demoting an owner is
 * filtered by USING and comes back as zero rows, while an admin promoting
 * anyone to owner passes USING and is rejected by WITH CHECK.
 *
 * Both were verified directly against the database before this constant
 * existed. Without it the second case fell through to "could not change this
 * member's role", which tells the reader nothing about the rule they hit.
 */
const INSUFFICIENT_PRIVILEGE = '42501';

interface Body {
  userId?: unknown;
  role?: unknown;
}

async function authorise(request: Request, budget: number) {
  const user = await getCurrentUser();
  if (!user) {
    return { error: NextResponse.json({ error: 'Sign in first.' }, { status: 401 }) };
  }

  const limit = await consumeRateLimit(`org-members:${clientKey(request)}`, budget);
  if (!limit.allowed) {
    return {
      error: NextResponse.json(
        { error: 'Too many membership changes. Try again later.' },
        { status: 429, headers: { 'retry-after': String(limit.retryAfterSeconds) } },
      ),
    };
  }

  const supabase = createClientForRequest();
  if (!supabase) {
    return { error: NextResponse.json({ error: 'Dataset unavailable.' }, { status: 503 }) };
  }

  return { user, supabase };
}

export async function PATCH(request: Request, { params }: Params) {
  const gate = await authorise(request, 60);
  if (gate.error) return gate.error;
  const { supabase } = gate;

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }

  const userId = typeof body.userId === 'string' ? body.userId : '';
  const role = typeof body.role === 'string' ? (body.role as OrgRole) : null;

  if (!userId) return NextResponse.json({ error: 'Which member?' }, { status: 400 });
  if (!role || !ROLES.includes(role)) {
    return NextResponse.json({ error: 'Not a role this organisation has.' }, { status: 400 });
  }

  const { data, error } = await supabase
    .from('organisation_members')
    .update({ role })
    .eq('org_id', params.orgId)
    .eq('user_id', userId)
    .select('user_id, role');

  if (error) {
    /*
     * The organisation-keeps-an-owner trigger. Its message names the fix —
     * promote somebody else to owner first — and is better than anything
     * this route could write without knowing which of the two ways the
     * caller got here.
     */
    if (error.code === CHECK_VIOLATION) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error.code === INSUFFICIENT_PRIVILEGE) {
      return NextResponse.json(
        {
          error:
            role === 'owner'
              ? 'Only an owner can make someone else an owner.'
              : 'You cannot give this member that role.',
        },
        { status: 403 },
      );
    }
    return NextResponse.json({ error: 'Could not change this member’s role.' }, { status: 400 });
  }

  if (!data || data.length === 0) {
    /*
     * Two refusals land here and they are worth telling apart, because one
     * of them is a rule the reader can act on and the other is not. Naming
     * `owner` explicitly is not a disclosure: the caller is a member looking
     * at a page that already lists every role in the organisation.
     */
    return NextResponse.json(
      {
        error:
          role === 'owner'
            ? 'Only an owner can make someone else an owner.'
            : 'You cannot change this member’s role. Administrators can manage everyone except owners.',
      },
      { status: 403 },
    );
  }

  return NextResponse.json({ userId, role, message: `Role changed to ${role}.` });
}

/**
 * Removing a member, or leaving.
 *
 * The DELETE policy allows `user_id = auth.uid()` unconditionally, so this
 * one route covers both "remove them" and "I am leaving" — they are the same
 * statement, and the database already knows which one it is looking at.
 */
export async function DELETE(request: Request, { params }: Params) {
  const gate = await authorise(request, 60);
  if (gate.error) return gate.error;
  const { supabase, user } = gate;

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }

  const userId = typeof body.userId === 'string' ? body.userId : '';
  if (!userId) return NextResponse.json({ error: 'Which member?' }, { status: 400 });

  const { data, error } = await supabase
    .from('organisation_members')
    .delete()
    .eq('org_id', params.orgId)
    .eq('user_id', userId)
    .select('user_id');

  if (error) {
    if (error.code === CHECK_VIOLATION) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return NextResponse.json({ error: 'Could not remove this member.' }, { status: 400 });
  }

  if (!data || data.length === 0) {
    return NextResponse.json(
      { error: 'You cannot remove this member. Administrators can remove everyone except owners.' },
      { status: 403 },
    );
  }

  return NextResponse.json({
    userId,
    left: userId === user.id,
    message:
      userId === user.id
        ? 'You have left this organisation.'
        : 'That member no longer belongs to this organisation.',
  });
}
