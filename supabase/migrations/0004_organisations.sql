-- 0004 — Organisations, membership and roles.
--
-- The whole access model rests on one question: "is this user a member of that
-- organisation, and with what role?" Answering it inside a policy is where
-- Supabase schemas usually break, because the obvious policy
--
--   create policy on organisation_members using (
--     org_id in (select org_id from organisation_members where user_id = auth.uid()))
--
-- reads `organisation_members` to decide whether you may read
-- `organisation_members`, and Postgres refuses with infinite recursion. The
-- fix is the helper functions below: SECURITY DEFINER, so they run with the
-- definer's rights and are not themselves subject to the policy they are being
-- consulted by.

create schema if not exists app;
grant usage on schema app to anon, authenticated, service_role;

-- ---------------------------------------------------------------- --
-- 1. Roles
--
-- Declared in ascending order of privilege, deliberately: Postgres compares
-- enum values by declaration order, so `role >= 'admin'` is a native
-- comparison and the policies below read as English rather than as a lookup
-- table of role names.
-- ---------------------------------------------------------------- --
do $$ begin
  create type org_role as enum ('viewer', 'analyst', 'admin', 'owner');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------- --
-- 2. Tables
-- ---------------------------------------------------------------- --
create table if not exists organisations (
  id                uuid primary key default gen_random_uuid(),
  name              text not null check (length(trim(name)) between 1 and 120),
  slug              text not null check (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),

  -- Off by default, and the default is the point. An organisation assessing a
  -- supplier privately has not agreed to publish "we assessed acme.com, it
  -- scored 61" to a shared corpus. Nothing reads this yet; it exists so that
  -- contribution can be switched on deliberately rather than retrofitted.
  benchmark_opt_in  boolean not null default false,

  created_by        uuid references auth.users(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- citext is not available in every Postgres build Klyro is tested against, so
-- case-insensitive uniqueness is an expression index rather than a column type.
create unique index if not exists idx_organisations_slug on organisations (lower(slug));

create table if not exists organisation_members (
  org_id      uuid not null references organisations(id) on delete cascade,
  user_id     uuid not null references auth.users(id)    on delete cascade,
  role        org_role not null default 'viewer',
  invited_by  uuid references auth.users(id) on delete set null,
  joined_at   timestamptz not null default now(),
  primary key (org_id, user_id)
);

-- "Which organisations am I in?" is the most frequent query in the product and
-- the primary key is the wrong way round for it.
create index if not exists idx_org_members_user on organisation_members (user_id);
create index if not exists idx_org_members_role on organisation_members (org_id, role);

-- ---------------------------------------------------------------- --
-- 3. Membership helpers
--
-- `stable` rather than `volatile` so the planner may cache the result within a
-- statement instead of re-running it per row. The empty `search_path` guards
-- against a caller-controlled path resolving these names somewhere else.
-- ---------------------------------------------------------------- --
create or replace function app.is_org_member(org uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp
as $$
  select exists (
    select 1 from organisation_members
    where org_id = org and user_id = auth.uid()
  );
$$;

create or replace function app.org_role_of(org uuid) returns org_role
  language sql stable security definer set search_path = public, pg_temp
as $$
  select role from organisation_members
  where org_id = org and user_id = auth.uid();
$$;

create or replace function app.has_org_role(org uuid, minimum org_role) returns boolean
  language sql stable security definer set search_path = public, pg_temp
as $$
  select exists (
    select 1 from organisation_members
    where org_id = org and user_id = auth.uid() and role >= minimum
  );
$$;

/**
 * Whether the caller shares any organisation with another user.
 *
 * Used only by the profile read policy. Without it, a member list can show
 * names; with the naive alternative — making profiles world-readable — every
 * account's display name is enumerable by anyone with the anon key.
 */
create or replace function app.shares_org_with(other_user uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from organisation_members mine
    join organisation_members theirs on theirs.org_id = mine.org_id
    where mine.user_id = auth.uid() and theirs.user_id = other_user
  );
$$;

revoke execute on function app.is_org_member(uuid)      from anon;
revoke execute on function app.has_org_role(uuid, org_role) from anon;
revoke execute on function app.org_role_of(uuid)        from anon;
revoke execute on function app.shares_org_with(uuid)    from anon;

-- ---------------------------------------------------------------- --
-- 4. Creating an organisation makes you its owner
--
-- SECURITY DEFINER because the membership row has no INSERT policy — joining
-- is not something a client does directly, it is something the server does on
-- your behalf. This trigger is the one exception, and it can only ever write a
-- row naming the caller as owner of the organisation they just created.
-- ---------------------------------------------------------------- --
create or replace function app.claim_new_organisation() returns trigger
  language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if new.created_by is not null then
    insert into organisation_members (org_id, user_id, role)
    values (new.id, new.created_by, 'owner')
    on conflict (org_id, user_id) do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists on_organisation_created on organisations;
create trigger on_organisation_created
  after insert on organisations
  for each row execute function app.claim_new_organisation();

-- ---------------------------------------------------------------- --
-- 5. An organisation always has an owner
--
-- Without this, the last owner can demote or remove themselves and leave an
-- organisation nobody can administer — no way to rotate the join code, manage
-- members, or delete it. Recovery would mean manual intervention in the
-- database, which is not a thing a product should require.
-- ---------------------------------------------------------------- --
create or replace function app.assert_owner_remains() returns trigger
  language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  target_org uuid := coalesce(old.org_id, new.org_id);
  owners_left integer;
begin
  -- The organisation being deleted outright takes its members with it.
  if not exists (select 1 from organisations where id = target_org) then
    return coalesce(new, old);
  end if;

  select count(*) into owners_left
  from organisation_members
  where org_id = target_org and role = 'owner';

  if owners_left = 0 then
    raise exception
      'An organisation must keep at least one owner. Promote another member to owner first.'
      using errcode = 'check_violation';
  end if;

  return coalesce(new, old);
end;
$$;

drop trigger if exists on_member_change_assert_owner on organisation_members;
create constraint trigger on_member_change_assert_owner
  after update or delete on organisation_members
  deferrable initially deferred
  for each row execute function app.assert_owner_remains();

-- ---------------------------------------------------------------- --
-- 6. Policies
-- ---------------------------------------------------------------- --
alter table organisations        enable row level security;
alter table organisation_members enable row level security;

-- Organisations are visible to their members and to nobody else. There is no
-- public directory of organisations, by design.
drop policy if exists "orgs: read as member" on organisations;
create policy "orgs: read as member" on organisations
  for select to authenticated
  using (app.is_org_member(id));

/*
 * Creation is a server-side operation, like joining.
 *
 * The obvious alternative — let `authenticated` insert with
 * `with check (created_by = auth.uid())` — does not work, and the reason is
 * worth recording because it looks like a bug in Postgres until you see it.
 * An `insert ... returning id` also needs a SELECT policy to satisfy the
 * RETURNING clause, and the SELECT policy here is membership-based. At the
 * moment RETURNING is evaluated the ownership trigger has not fired, so the
 * creator is not yet a member and their own insert is refused.
 *
 * The fixes that keep client-side creation all make the SELECT policy weaker:
 * `using (... or created_by = auth.uid())` would let someone removed from an
 * organisation keep reading it forever, on the strength of having created it.
 * Routing creation through the server instead keeps the read policy saying
 * exactly what it means — members, and nobody else — and puts every mutation
 * of membership in one privileged place that can be audited.
 */
revoke insert on organisations from anon, authenticated;

drop policy if exists "orgs: admins update" on organisations;
create policy "orgs: admins update" on organisations
  for update to authenticated
  using (app.has_org_role(id, 'admin'))
  with check (app.has_org_role(id, 'admin'));

drop policy if exists "orgs: owners delete" on organisations;
create policy "orgs: owners delete" on organisations
  for delete to authenticated
  using (app.has_org_role(id, 'owner'));

-- Members can see who else is in their organisation.
drop policy if exists "members: read within org" on organisation_members;
create policy "members: read within org" on organisation_members
  for select to authenticated
  using (app.is_org_member(org_id));

/*
 * Admins manage members, but not owners.
 *
 * The `role <> 'owner'` in the USING clause is what stops an admin demoting
 * the owner and taking the organisation; the same test in WITH CHECK stops
 * them promoting anyone — including themselves — to owner. Ownership moves
 * only by an owner's own action.
 */
drop policy if exists "members: admins manage" on organisation_members;
create policy "members: admins manage" on organisation_members
  for update to authenticated
  using (
    app.has_org_role(org_id, 'admin')
    and (role <> 'owner' or app.has_org_role(org_id, 'owner'))
  )
  with check (
    app.has_org_role(org_id, 'admin')
    and (role <> 'owner' or app.has_org_role(org_id, 'owner'))
  );

drop policy if exists "members: admins remove" on organisation_members;
create policy "members: admins remove" on organisation_members
  for delete to authenticated
  using (
    -- Leaving on your own account is always allowed; the owner-remains
    -- trigger is what stops the last owner walking out.
    user_id = auth.uid()
    or (
      app.has_org_role(org_id, 'admin')
      and (role <> 'owner' or app.has_org_role(org_id, 'owner'))
    )
  );

-- Joining is a server-side operation: it requires checking a code the client
-- must not be able to read. There is deliberately no INSERT policy here.
revoke insert on organisation_members from anon, authenticated;

-- ---------------------------------------------------------------- --
-- 7. Profiles gain their co-member read path, now that membership exists
-- ---------------------------------------------------------------- --
drop policy if exists "profiles: read own" on profiles;
create policy "profiles: read own or shared" on profiles
  for select to authenticated
  using (id = auth.uid() or app.shares_org_with(id));
