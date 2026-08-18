import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Who a scan belongs to, resolved server-side.
 *
 * The client says which organisation it wants a scan filed under. That claim
 * is worth nothing on its own — it arrives in a request body — so it is
 * checked here before it becomes ownership.
 *
 * The check runs through the *caller's own* Supabase client rather than the
 * service client, deliberately. Row level security on `organisation_members`
 * only lets a user see organisations they belong to, so a membership row that
 * comes back is itself the proof: there is no way to read a row for an
 * organisation you are not in, which means there is no way for this function
 * to be fooled by a forged id. Doing the same check with the service client
 * would work too, and would rely on this function remembering to compare the
 * user id — one more place for the authorisation to be written correctly, and
 * therefore one more place for it to be written incorrectly.
 */

export type OrgRole = 'viewer' | 'analyst' | 'admin' | 'owner';

const RANK: Record<OrgRole, number> = { viewer: 0, analyst: 1, admin: 2, owner: 3 };

export function roleAtLeast(role: OrgRole | null, minimum: OrgRole): boolean {
  if (!role) return false;
  return RANK[role] >= RANK[minimum];
}

export interface OwnerContext {
  /** Set for a personal assessment. */
  userId: string | null;
  /** Set for an organisation assessment. Never both. */
  orgId: string | null;
  /** Who ran it, in either case. Null only for anonymous scans. */
  createdBy: string | null;
  /** Why the request did not get the ownership it asked for, if it did not. */
  notice?: string;
}

/** An anonymous scan. Runs in full, persists nothing. */
export const ANONYMOUS: OwnerContext = { userId: null, orgId: null, createdBy: null };

/** The caller's role in an organisation, or null if they are not a member. */
export async function roleInOrg(
  supabase: SupabaseClient,
  orgId: string,
  userId: string,
): Promise<OrgRole | null> {
  const { data, error } = await supabase
    .from('organisation_members')
    .select('role')
    .eq('org_id', orgId)
    .eq('user_id', userId)
    .maybeSingle();

  if (error || !data) return null;
  return (data as { role: OrgRole }).role;
}

/**
 * Decides what a scan will be filed as.
 *
 * Falls back rather than failing: a signed-in user who names an organisation
 * they cannot write to still gets their scan, saved personally, with a notice
 * explaining what happened. Refusing the whole assessment over a
 * mis-selected dropdown would throw away twenty seconds of network work to
 * make a point.
 */
export async function resolveOwner(
  supabase: SupabaseClient | null,
  user: { id: string } | null,
  requestedOrgId: string | null | undefined,
): Promise<OwnerContext> {
  if (!user) return ANONYMOUS;

  const personal: OwnerContext = { userId: user.id, orgId: null, createdBy: user.id };

  if (!requestedOrgId) return personal;
  if (!supabase) return personal;

  const role = await roleInOrg(supabase, requestedOrgId, user.id);

  if (!role) {
    // Includes both "not a member" and "no such organisation" — the caller is
    // told the same thing either way, because distinguishing them would
    // confirm that an organisation with that id exists.
    return {
      ...personal,
      notice:
        'This assessment was saved to your personal history: the organisation you selected is not one you belong to.',
    };
  }

  if (!roleAtLeast(role, 'analyst')) {
    return {
      ...personal,
      notice:
        'This assessment was saved to your personal history: viewers can read an organisation’s assessments but not add to them.',
    };
  }

  return { userId: null, orgId: requestedOrgId, createdBy: user.id };
}
