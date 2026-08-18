-- 0005 — Organisation join codes.
--
-- A join code is a credential. Anyone holding one can put themselves inside an
-- organisation and read its assessments, so it gets the treatment a credential
-- gets: it is never stored in a form that can be read back.
--
-- The hash is computed in the application, not here. Two reasons:
--
--   1. It is an HMAC, and the pepper it needs must live somewhere the database
--      does not. Storing the pepper in Postgres alongside the hashes would
--      mean one compromise yields both halves, which is the entire thing a
--      pepper exists to prevent.
--   2. `pgcrypto` is not available in every Postgres build Klyro is tested
--      against, and a security control that only exists in production is a
--      security control that is never tested.
--
-- The code is high-entropy and randomly generated, so a fast keyed hash is the
-- right choice — bcrypt would buy nothing against a 50-bit random string and
-- would cost the ability to index the column, forcing a full scan of every
-- code in the table on each join attempt.
--
-- What is stored: the HMAC, and the last four characters as a hint so an admin
-- looking at a list of codes can tell which is which. Never the code.

create table if not exists organisation_join_codes (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organisations(id) on delete cascade,

  -- HMAC-SHA256(code, server pepper), hex. Unique so a lookup is an index hit
  -- and so two organisations cannot collide on one code.
  code_hash    text not null unique,
  -- Last four characters of the code. Enough to identify, not enough to use.
  code_hint    text not null check (length(code_hint) <= 8),

  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz,
  revoked_at   timestamptz,
  -- Null means unlimited. A bounded code is the safer default for a shared
  -- secret, but forcing it would break the "paste it in the team channel" case
  -- this is meant to serve.
  max_uses     integer check (max_uses is null or max_uses > 0),
  use_count    integer not null default 0
);

create index if not exists idx_join_codes_org on organisation_join_codes (org_id, created_at desc);

-- Partial index over live codes only: the join path looks up exactly one hash
-- and should never scan revoked history.
create index if not exists idx_join_codes_live
  on organisation_join_codes (code_hash)
  where revoked_at is null;

-- ---------------------------------------------------------------- --
-- Validity, in one place
--
-- Expressed as a generated predicate rather than duplicated across the join
-- route, the admin list and the tests, so "is this code usable" cannot drift
-- between them.
-- ---------------------------------------------------------------- --
create or replace function app.join_code_is_live(code organisation_join_codes) returns boolean
  language sql immutable
as $$
  select code.revoked_at is null
     and (code.expires_at is null or code.expires_at > now())
     and (code.max_uses is null or code.use_count < code.max_uses);
$$;

alter table organisation_join_codes enable row level security;

/*
 * Admins can see that codes exist, when they were made, and whether they are
 * live — but the hash column is revoked below, so "read the codes table" never
 * yields anything usable even for the people allowed to manage it.
 */
drop policy if exists "join codes: admins read" on organisation_join_codes;
create policy "join codes: admins read" on organisation_join_codes
  for select to authenticated
  using (app.has_org_role(org_id, 'admin'));

-- Generating, rotating, revoking and consuming a code are all server-side
-- operations. No write policy exists for any client role.
revoke insert, update, delete on organisation_join_codes from anon, authenticated;

/*
 * Column-level grants, on top of the policy.
 *
 * The policy above lets an admin select from this table, and without the
 * grants below that select returns the hash. A hash is not the code, but it is
 * the verifier: an attacker holding one can test candidate codes offline at
 * whatever rate their hardware allows, never touching Klyro and never meeting
 * the rate limiter. Two independent controls, because a future migration that
 * widens the read policy should not silently widen this as well.
 *
 * Written as revoke-then-grant rather than `revoke select (code_hash)`, which
 * looks like it should work and does nothing. Postgres treats table-level and
 * column-level privileges as separate grants, and a table-level SELECT — which
 * Supabase's default privileges hand out — satisfies a read of any column
 * regardless of what has been revoked at column level. The table-level grant
 * has to go first, and then the readable columns are named explicitly.
 */
revoke select on organisation_join_codes from anon, authenticated;

grant select (
  id, org_id, code_hint, created_by, created_at, expires_at, revoked_at, max_uses, use_count
) on organisation_join_codes to authenticated;
