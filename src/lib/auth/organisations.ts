import 'server-only';

import { generateJoinCode, hashJoinCode, looksLikeJoinCode } from './joinCode';
import { roleAtLeast, roleInOrg, type OrgRole } from './context';
import { requireServiceClient } from '../supabase/service';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Organisation operations that need more rights than the caller has.
 *
 * Everything here runs through the service role, which bypasses row level
 * security entirely — so every function in this file is responsible for its
 * own authorisation, and each one does that by first asking the *caller's*
 * client what role they hold. That ordering is the rule: establish who you are
 * dealing with using their credentials, then act with the server's.
 *
 * The alternative — doing the whole operation with the service client and
 * comparing ids in application code — works right up until someone adds a
 * branch that forgets to compare.
 */

const SLUG_MAX = 48;

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX);

  // The check constraint requires a leading alphanumeric; a name of nothing but
  // punctuation would otherwise produce an empty or leading-hyphen slug.
  return base && /^[a-z0-9]/.test(base) ? base : `org-${Math.random().toString(36).slice(2, 8)}`;
}

export interface CreatedOrganisation {
  id: string;
  name: string;
  slug: string;
}

/**
 * Creates an organisation and makes the caller its owner.
 *
 * The membership row is written by a database trigger rather than by a second
 * statement here, so there is no window in which an organisation exists with
 * nobody able to administer it — and no path where a failure between two
 * statements leaves one behind.
 */
export async function createOrganisation(
  userId: string,
  name: string,
): Promise<CreatedOrganisation> {
  const service = requireServiceClient();
  const trimmed = name.trim();

  if (trimmed.length < 1 || trimmed.length > 120) {
    throw new Error('An organisation name must be between 1 and 120 characters.');
  }

  // Slug collisions are resolved by retrying with a suffix rather than by
  // asking the user to pick again: the slug is derived, so a collision is not
  // something they did wrong.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const slug = attempt === 0 ? slugify(trimmed) : `${slugify(trimmed)}-${Math.random().toString(36).slice(2, 6)}`;

    const { data, error } = await service
      .from('organisations')
      .insert({ name: trimmed, slug, created_by: userId })
      .select('id, name, slug')
      .single();

    if (!error && data) return data as CreatedOrganisation;
    // 23505 is unique_violation; anything else is a real failure.
    if (error && error.code !== '23505') {
      throw new Error(`Could not create the organisation: ${error.message}`);
    }
  }

  throw new Error('Could not allocate a unique name for that organisation. Try a different name.');
}

export interface IssuedCode {
  /** Plaintext. Returned exactly once, never stored, never retrievable. */
  code: string;
  hint: string;
  expiresAt: string | null;
}

/**
 * Issues a join code, revoking any existing live ones.
 *
 * Rotation is revoke-then-issue rather than replace, so the previous code stops
 * working the instant this returns — which is the reason to rotate at all. The
 * revoked rows stay: who issued which code and when is the audit trail for how
 * somebody came to be in the organisation.
 */
export async function rotateJoinCode(
  caller: SupabaseClient,
  userId: string,
  orgId: string,
  options: { expiresInDays?: number | null; maxUses?: number | null } = {},
): Promise<IssuedCode> {
  const role = await roleInOrg(caller, orgId, userId);
  if (!roleAtLeast(role, 'admin')) {
    throw new Error('Only an administrator or owner can issue a join code.');
  }

  const service = requireServiceClient();

  await service
    .from('organisation_join_codes')
    .update({ revoked_at: new Date().toISOString() })
    .eq('org_id', orgId)
    .is('revoked_at', null);

  const generated = generateJoinCode();
  const expiresAt =
    options.expiresInDays && options.expiresInDays > 0
      ? new Date(Date.now() + options.expiresInDays * 86_400_000).toISOString()
      : null;

  const { error } = await service.from('organisation_join_codes').insert({
    org_id: orgId,
    code_hash: generated.hash,
    code_hint: generated.hint,
    created_by: userId,
    expires_at: expiresAt,
    max_uses: options.maxUses ?? null,
  });

  if (error) throw new Error(`Could not issue a join code: ${error.message}`);

  return { code: generated.code, hint: generated.hint, expiresAt };
}

/** Revokes every live code without issuing a replacement. */
export async function revokeJoinCodes(
  caller: SupabaseClient,
  userId: string,
  orgId: string,
): Promise<void> {
  const role = await roleInOrg(caller, orgId, userId);
  if (!roleAtLeast(role, 'admin')) {
    throw new Error('Only an administrator or owner can revoke a join code.');
  }

  const service = requireServiceClient();
  await service
    .from('organisation_join_codes')
    .update({ revoked_at: new Date().toISOString() })
    .eq('org_id', orgId)
    .is('revoked_at', null);
}

export type JoinOutcome =
  | { ok: true; orgId: string; orgName: string; alreadyMember: boolean }
  | { ok: false; reason: string };

/**
 * Redeems a join code.
 *
 * Every failure returns the same message. That is deliberate: distinguishing
 * "no such code" from "expired" from "already used up" tells someone probing
 * codes which guesses were close, and turns a 49-bit search into a search with
 * feedback. The rate limiter on the route is the primary defence; this removes
 * the oracle.
 */
export async function joinWithCode(userId: string, submitted: string): Promise<JoinOutcome> {
  const refusal = {
    ok: false as const,
    reason: 'That code is not valid. Codes expire and can be revoked — ask for a current one.',
  };

  // Rejected before any database work, so a malformed string costs nothing.
  if (!looksLikeJoinCode(submitted)) return refusal;

  const service = requireServiceClient();

  const { data, error } = await service
    .from('organisation_join_codes')
    .select('id, org_id, expires_at, revoked_at, max_uses, use_count, organisations(name)')
    .eq('code_hash', hashJoinCode(submitted))
    .maybeSingle();

  if (error || !data) return refusal;

  const record = data as unknown as {
    id: string;
    org_id: string;
    expires_at: string | null;
    revoked_at: string | null;
    max_uses: number | null;
    use_count: number;
    organisations: { name: string } | null;
  };

  if (record.revoked_at) return refusal;
  if (record.expires_at && Date.parse(record.expires_at) <= Date.now()) return refusal;
  if (record.max_uses !== null && record.use_count >= record.max_uses) return refusal;

  const { data: existing } = await service
    .from('organisation_members')
    .select('user_id')
    .eq('org_id', record.org_id)
    .eq('user_id', userId)
    .maybeSingle();

  if (existing) {
    // Not an error, and deliberately does not consume a use: re-entering a
    // code you already redeemed should be a no-op, not a way to exhaust it.
    return {
      ok: true,
      orgId: record.org_id,
      orgName: record.organisations?.name ?? 'the organisation',
      alreadyMember: true,
    };
  }

  const { error: joinError } = await service
    .from('organisation_members')
    .insert({ org_id: record.org_id, user_id: userId, role: 'viewer' });

  if (joinError) return refusal;

  /*
   * The use count is incremented after the join, not before.
   *
   * Two calls racing on the same last-use code could both pass the check above
   * and both join. The consequence is one extra member on a code bounded at a
   * small number — a limit overshoot, not a bypass, since both callers held a
   * valid code. Making it airtight needs a transaction, which the REST client
   * cannot express; the correct fix is a database function, and it is not
   * worth one for this.
   */
  await service
    .from('organisation_join_codes')
    .update({ use_count: record.use_count + 1 })
    .eq('id', record.id);

  return {
    ok: true,
    orgId: record.org_id,
    orgName: record.organisations?.name ?? 'the organisation',
    alreadyMember: false,
  };
}

/** Changes a member's role. Authorisation is the database's, not this file's. */
export async function setMemberRole(
  caller: SupabaseClient,
  orgId: string,
  targetUserId: string,
  role: OrgRole,
): Promise<{ ok: boolean; reason?: string }> {
  /*
   * Runs as the caller, not as the service role — the only function here that
   * does. The policy on `organisation_members` already encodes the rules that
   * matter (an admin may not touch an owner, may not promote to owner, and a
   * viewer may not touch anyone), and rewriting them here in TypeScript would
   * be a second copy free to disagree with the first.
   */
  const { data, error } = await caller
    .from('organisation_members')
    .update({ role })
    .eq('org_id', orgId)
    .eq('user_id', targetUserId)
    .select('user_id');

  if (error) return { ok: false, reason: error.message };
  if (!data || data.length === 0) {
    return { ok: false, reason: 'You do not have permission to change that member’s role.' };
  }
  return { ok: true };
}
