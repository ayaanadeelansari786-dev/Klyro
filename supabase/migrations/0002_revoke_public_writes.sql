-- 0002 — Revoke public write access.
--
-- The baseline shipped these:
--
--   create policy "Allow public insert" on scan_results        for insert with check (true);
--   create policy "seed insert vendors" on vendors             for insert with check (true);
--   create policy "seed update vendors" on vendors             for update using (true) with check (true);
--   create policy "seed insert ownership" on ownership_assessments for insert with check (true);
--
-- `NEXT_PUBLIC_SUPABASE_ANON_KEY` is in the browser bundle by definition, so
-- those four policies mean anyone who opens devtools can insert scan rows for
-- any domain, at any score, and rewrite any vendor's ownership record. The
-- benchmark is the product's claim to objectivity; a corpus anyone can write to
-- does not support that claim.
--
-- They were written for the seeding phase with a comment saying to remove them
-- before launch. This is that removal. It ships on its own, ahead of the
-- account work, because the exposure exists in any deployed instance today.
--
-- Reads stay public. The benchmark is only useful if it can be read, and
-- nothing in these three tables is private: they hold published scores for
-- public domains. Ownership arrives with `assessments` in 0006, which is a
-- separate table precisely so that private data never lands here.
--
-- After this migration every write to these tables goes through the service
-- role, which bypasses RLS and is only ever held server-side.

-- ---------------------------------------------------------------- --
-- 1. Drop the write policies
-- ---------------------------------------------------------------- --
drop policy if exists "Allow public insert"   on scan_results;
drop policy if exists "seed insert vendors"   on vendors;
drop policy if exists "seed update vendors"   on vendors;
drop policy if exists "seed insert ownership" on ownership_assessments;

-- ---------------------------------------------------------------- --
-- 2. Revoke the underlying grants
--
-- Dropping the policies is already sufficient: RLS denies by default, so a
-- table with row level security on and no INSERT policy refuses every insert.
-- The grants are revoked as well because the two mechanisms fail differently —
-- a future migration that adds a permissive policy by mistake would re-open
-- writes, whereas a missing grant refuses regardless of policy. Defence in
-- depth costs one statement here.
-- ---------------------------------------------------------------- --
revoke insert, update, delete, truncate on scan_results          from anon, authenticated;
revoke insert, update, delete, truncate on vendors               from anon, authenticated;
revoke insert, update, delete, truncate on ownership_assessments from anon, authenticated;

-- Read access is deliberate and stays.
grant select on scan_results          to anon, authenticated;
grant select on vendors               to anon, authenticated;
grant select on ownership_assessments to anon, authenticated;

-- ---------------------------------------------------------------- --
-- 3. Confirm the intended read policies are present
--
-- Re-asserted rather than assumed: this migration is the security boundary for
-- these three tables, so it states the whole boundary rather than half of it.
-- ---------------------------------------------------------------- --
alter table scan_results          enable row level security;
alter table vendors               enable row level security;
alter table ownership_assessments enable row level security;

drop policy if exists "Allow public read"     on scan_results;
create policy "Allow public read"     on scan_results          for select using (true);

drop policy if exists "public read vendors"   on vendors;
create policy "public read vendors"   on vendors               for select using (true);

drop policy if exists "public read ownership" on ownership_assessments;
create policy "public read ownership" on ownership_assessments for select using (true);
