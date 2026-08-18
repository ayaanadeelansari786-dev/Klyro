-- 0003 — Profiles.
--
-- `auth.users` lives in a schema application code cannot read, which is the
-- correct default: it holds email addresses, password hashes and recovery
-- tokens. But an organisation member list has to show *something* about the
-- other members, so there is a public-schema row per user holding only what is
-- safe to show a colleague.
--
-- Deliberately thin. A display name and nothing else. Every additional column
-- here is a column that leaks to everyone sharing an organisation.

create table if not exists profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

alter table profiles enable row level security;

-- ---------------------------------------------------------------- --
-- Creation is automatic and privileged.
--
-- SECURITY DEFINER because the trigger fires inside GoTrue's signup
-- transaction, where the acting role has no rights on `public.profiles`. The
-- fixed `search_path` is not decoration: without it, a schema earlier on the
-- caller's path could shadow `profiles` and capture the insert.
-- ---------------------------------------------------------------- --
create or replace function public.handle_new_user() returns trigger
  language plpgsql security definer set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    -- Supabase puts anything passed to signUp() under raw_user_meta_data.
    coalesce(
      nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''),
      split_part(coalesce(new.email, 'someone@unknown'), '@', 1)
    )
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

-- Created unconditionally. If `auth.users` does not look the way this expects,
-- the migration should fail here rather than silently leave every new account
-- without a profile.
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

/*
 * Backfill.
 *
 * The trigger only fires for accounts created after this migration runs. Any
 * that already exist would have no profile row, and would then be invisible in
 * an organisation's member list — present in `organisation_members`, nameless
 * in the interface, because the join to `profiles` finds nothing.
 *
 * Idempotent, and safe on an empty `auth.users`.
 */
insert into public.profiles (id, display_name)
select
  u.id,
  coalesce(
    nullif(trim(u.raw_user_meta_data ->> 'display_name'), ''),
    split_part(coalesce(u.email, 'someone@unknown'), '@', 1)
  )
from auth.users u
where not exists (select 1 from public.profiles p where p.id = u.id);

-- ---------------------------------------------------------------- --
-- Policies
--
-- Read is self plus anyone sharing an organisation. The co-member half is
-- added in 0004, once membership exists to check against — a policy cannot
-- reference a table that has not been created yet.
-- ---------------------------------------------------------------- --
drop policy if exists "profiles: read own" on profiles;
create policy "profiles: read own" on profiles
  for select to authenticated
  using (id = auth.uid());

drop policy if exists "profiles: update own" on profiles;
create policy "profiles: update own" on profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- No insert policy: rows arrive through the trigger above. No delete policy:
-- profiles disappear with their `auth.users` row, by cascade.
revoke insert, delete on profiles from anon, authenticated;
