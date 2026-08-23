-- 0010 — The missing link between organisation_members and profiles.
--
-- `organisation_members.user_id` and `profiles.id` both reference
-- `auth.users(id)` separately; there was no direct FK between the two
-- tables. PostgREST's embed syntax (`profiles(display_name)`, used by both
-- /org/[orgId] and /org/[orgId]/activity) requires a direct foreign key to
-- discover a relationship — a shared reference to a third table is invisible
-- to it. Every such request returned PGRST200 ("could not find a
-- relationship"), which the app's `?? []` fallback turned into a silently
-- empty member list — so every reader, owner included, resolved to "not a
-- member" and lost every permission gated on role, including seeing their
-- own organisation's join code.
--
-- Safe to add unconditionally: migration 0003's trigger creates a `profiles`
-- row for every `auth.users` row (and backfilled every existing one), so
-- every `user_id` already in `organisation_members` is guaranteed to exist
-- in `profiles`.

alter table organisation_members
  add constraint organisation_members_user_id_profiles_fkey
  foreign key (user_id) references profiles(id) on delete cascade;

notify pgrst, 'reload schema';
