# Deploying the migrations

Every SQL statement below has been executed against a real Postgres with these
migrations applied — see `tests/db/verification-queries.test.ts`, which runs the
whole checklist and asserts each expected result. A checklist should not be
first executed against production.

---

## Two corrections before you start

**There is no 0009 or 0010.** The range is **0002–0008**, seven migrations. The
original plan had policies in a separate 0009 and a `scan_results` rename in
0010. Policies were folded into the migration that creates each table, so no
table is ever briefly readable between its creation and its protection; the
rename was dropped because it destroys nothing useful and risks breaking a
rollback. If you were expecting ten files, nothing is missing.

**0001 changed today.** It used to re-create the four permissive write policies
that 0002 removes. Replaying the folder — after a restore, on a new
environment, or by anyone running the files in order twice — would therefore
undo the security fix silently. The statements are now recorded as comments
rather than SQL. A test asserts the baseline grants no write access.

---

## Risk summary

| Migration | Destructive? | Downtime | Data loss risk | Reversible |
|---|---|---|---|---|
| **0002** revoke public writes | Drops 4 policies, revokes grants. **No data touched.** | None | None | Yes — but reverting reopens the hole |
| **0003** profiles | Additive. Creates a trigger on `auth.users` | None | None | Yes, cleanly |
| **0004** organisations | Additive | None | None | Yes, cleanly |
| **0005** join codes | Additive | None | None | Yes, cleanly |
| **0006** assessments | Additive | None | None | Yes, cleanly |
| **0007** benchmark corpus | **Drops and recreates 4 views.** Copies rows into a new table | Seconds, unless wrapped in a transaction — then none | None. `scan_results` is untouched and keeps every row | Yes — script below |
| **0008** vendor portfolio | Additive. Adds one nullable column to `assessments` | None | None | Yes, cleanly |

**Nothing deletes a row.** No `DROP TABLE`, no `DELETE`, no `TRUNCATE`, no
`ALTER COLUMN TYPE`. The only dropped objects in the entire set are four
policies (0002) and four views (0007), and views hold no data.

**0007 is the only one that needs care**, and only because
`create or replace view` cannot change a view's column list — so the four
rankings views must be dropped and rebuilt against the new table. Wrap it in a
transaction and that window does not exist.

---

## The sequencing trap

**0002 must land at roughly the same time as the new application code, and the
order matters in one direction only.**

The old code writes to the database with the **anon** key: `persist()` in the
scan route, and the seeding path in `store.ts`. 0002 removes exactly that
access. So:

| Order | Consequence |
|---|---|
| **0002 first, then deploy code** | Between the two: anonymous scans still run and return full results, but silently stop being saved (`persist()` swallows the error by design). Seeding fails until the deploy lands. **Recoverable, no data lost.** |
| **Deploy code first, then 0002** | The new code writes with the service role, which 0002 does not touch. **No gap at all** — but the vulnerability stays open until you run 0002. |
| Neither | The hole stays open. |

Deploying the code first is cleaner if you can do it within the hour. If there
will be a gap of days, run 0002 now and accept that new scans are not saved
until the deploy — which is nearly the end state anyway, since anonymous scans
are not saved under the new design either.

**Set the two new environment variables before deploying the code**, not after:

```
SUPABASE_SERVICE_ROLE_KEY=...     # Supabase dashboard → Project Settings → API
KLYRO_JOIN_CODE_PEPPER=...        # openssl rand -base64 48
```

Without the service key the new code cannot save anything and organisations do
not work. Without the pepper, join codes throw when generated — deliberately,
rather than falling back to a default that would make codes portable between
deployments.

---

## Procedure

### Before anything

```sql
-- Record the starting state. Keep this output; the 0007 check compares to it.
select
  (select count(*) from scan_results)          as scan_rows,
  (select count(*) from vendors)               as vendor_rows,
  (select count(*) from ownership_assessments) as ownership_rows,
  (select count(distinct domain) from scan_results) as distinct_domains;
```

Take a backup. Supabase Pro keeps daily backups automatically; on Free, use
`supabase db dump -f pre-migration.sql` or the dashboard's backup option. None
of these migrations destroy data, but "none of them should" is not a backup.

### Step 1 — 0002, on its own

Run `0002_revoke_public_writes.sql`. Then run **checkpoint A** below and do not
continue until it passes.

This one is worth applying even if you go no further today.

### Step 2 — 0003 through 0006

Run in order. They are additive and independent of your existing data. Run
**checkpoints B, C, D** as you go.

### Step 3 — 0007, wrapped in a transaction

Paste the file between `begin;` and `commit;` so the view drop and recreate are
atomic:

```sql
begin;
-- paste the entire contents of 0007_benchmark_samples.sql here
commit;
```

If anything errors, the transaction rolls back and you are exactly where you
started. Run **checkpoint E** immediately after — it is the only checkpoint
that can detect data not arriving.

`supabase db push` already wraps each migration in a transaction, so this is
only necessary when pasting into the SQL editor manually.

### Step 4 — 0008

Additive. Run **checkpoint F**.

### Step 5 — deploy the application, then checkpoint G

---

## Verification checklist

Each block is copy-pasteable into the SQL editor. The expected result is stated
above it. Every one of these is executed by the test suite.

### Checkpoint A — after 0002

```sql
-- EXPECT: zero rows. Any row here is a write policy that survived.
select c.relname as table_name, p.polname as policy, p.polcmd as command
from pg_policy p
join pg_class c on c.oid = p.polrelid
where c.relname in ('scan_results', 'vendors', 'ownership_assessments')
  and p.polcmd <> 'r';
```

```sql
-- EXPECT: every value false.
-- has_table_privilege, not information_schema: the information_schema views
-- only report privileges for currently enabled roles, so they can return
-- nothing whether or not the grant exists.
select
  has_table_privilege('anon',          'scan_results',          'INSERT') as anon_insert_scans,
  has_table_privilege('anon',          'scan_results',          'UPDATE') as anon_update_scans,
  has_table_privilege('anon',          'scan_results',          'DELETE') as anon_delete_scans,
  has_table_privilege('authenticated', 'scan_results',          'INSERT') as auth_insert_scans,
  has_table_privilege('anon',          'vendors',               'INSERT') as anon_insert_vendors,
  has_table_privilege('anon',          'vendors',               'UPDATE') as anon_update_vendors,
  has_table_privilege('authenticated', 'vendors',               'UPDATE') as auth_update_vendors,
  has_table_privilege('anon',          'ownership_assessments', 'INSERT') as anon_insert_ownership;
```

```sql
-- EXPECT: both true. The control — without it, the check above would also
-- pass against a database where the tables did not exist.
select
  has_table_privilege('anon',          'scan_results', 'SELECT') as anon_read_scans,
  has_table_privilege('authenticated', 'vendors',      'SELECT') as auth_read_vendors;
```

**The one that actually matters — test from outside the database**, with your
real anon key, against your real project. This is the attack, performed:

```bash
# EXPECT: 401 or 403, and no row created.
curl -i -X POST "https://<project-ref>.supabase.co/rest/v1/scan_results" \
  -H "apikey: $NEXT_PUBLIC_SUPABASE_ANON_KEY" \
  -H "Authorization: Bearer $NEXT_PUBLIC_SUPABASE_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"domain":"deployment-check.invalid","industry":"Technology","region":"Global","composite_score":100}'
```

```bash
# EXPECT: 200 with rows. Reads must still work — the benchmark depends on it.
curl -s "https://<project-ref>.supabase.co/rest/v1/scan_results?select=domain&limit=1" \
  -H "apikey: $NEXT_PUBLIC_SUPABASE_ANON_KEY"
```

```sql
-- EXPECT: zero rows. Belt and braces on the curl above.
select * from scan_results where domain = 'deployment-check.invalid';
```

### Checkpoint B — after 0003

```sql
-- EXPECT: orphans = 0. Every account has a profile, including any that
-- existed before the trigger.
select count(*)::int as orphans
from auth.users u
where not exists (select 1 from public.profiles p where p.id = u.id);
```

```sql
-- EXPECT: one row.
select tgname from pg_trigger
where tgname = 'on_auth_user_created' and not tgisinternal;
```

### Checkpoint C — after 0004

```sql
-- EXPECT exactly, in this order: viewer, analyst, admin, owner.
-- The order is not cosmetic — `role >= 'admin'` in a policy depends on it.
select enumlabel from pg_enum
join pg_type on pg_type.oid = pg_enum.enumtypid
where pg_type.typname = 'org_role'
order by enumsortorder;
```

```sql
-- EXPECT: four rows, prosecdef = true on every one.
-- Without SECURITY DEFINER these recurse and every membership query fails.
select p.proname, p.prosecdef
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'app'
  and p.proname in ('is_org_member', 'has_org_role', 'org_role_of', 'shares_org_with')
order by p.proname;
```

```sql
-- EXPECT: first three false, auth_read true.
select
  has_table_privilege('authenticated', 'organisation_members', 'INSERT') as auth_join,
  has_table_privilege('anon',          'organisation_members', 'INSERT') as anon_join,
  has_table_privilege('authenticated', 'organisations',        'INSERT') as auth_create,
  has_table_privilege('authenticated', 'organisation_members', 'SELECT') as auth_read;
```

### Checkpoint D — after 0005 and 0006

```sql
-- EXPECT: auth_hash false, anon_hash false, auth_hint true, auth_expiry true.
-- Both halves matter. A readable hash is an offline verifier for brute-forcing
-- codes; an unreadable hint means administrators cannot manage codes at all.
select
  has_column_privilege('authenticated', 'organisation_join_codes', 'code_hash',  'SELECT') as auth_hash,
  has_column_privilege('anon',          'organisation_join_codes', 'code_hash',  'SELECT') as anon_hash,
  has_column_privilege('authenticated', 'organisation_join_codes', 'code_hint',  'SELECT') as auth_hint,
  has_column_privilege('authenticated', 'organisation_join_codes', 'expires_at', 'SELECT') as auth_expiry;
```

```sql
-- EXPECT: one row.
select conname from pg_constraint where conname = 'assessments_one_owner';
```

```sql
-- EXPECT: inserts false, read and delete true.
select
  has_table_privilege('authenticated', 'assessments',      'INSERT') as auth_insert,
  has_table_privilege('anon',          'assessments',      'INSERT') as anon_insert,
  has_table_privilege('authenticated', 'assessment_hosts', 'INSERT') as auth_hosts,
  has_table_privilege('authenticated', 'assessments',      'SELECT') as auth_read,
  has_table_privilege('authenticated', 'assessments',      'DELETE') as auth_delete;
```

### Checkpoint E — after 0007 · **the critical one**

```sql
-- EXPECT: zero rows. Any row is a scan left behind by the backfill, and every
-- industry average is now computed from a smaller pool than it should be.
select s.id, s.domain
from scan_results s
where not exists (select 1 from benchmark_samples b where b.id = s.id);
```

```sql
-- EXPECT: samples >= scans, and scans equal to the number you recorded before
-- you began. scan_results must not have changed at all.
select
  (select count(*) from scan_results)      as scans,
  (select count(*) from benchmark_samples) as samples;
```

```sql
-- EXPECT: four rows.
select viewname from pg_views
where viewname in ('latest_scans', 'score_trend', 'vendor_leaderboard', 'industry_summary')
order by viewname;
```

```sql
-- EXPECT: four rows, each with security_invoker=on in reloptions.
-- Without it a view runs with its definer's rights, and any future join to a
-- private table becomes a way around row level security.
select c.relname, c.reloptions
from pg_class c
where c.relkind = 'v'
  and c.relname in ('latest_scans', 'score_trend', 'vendor_leaderboard', 'industry_summary')
order by c.relname;
```

```sql
-- EXPECT: all four return rows without error. These drive the public rankings
-- page; a view that errors here is a blank page in production.
select count(*) from latest_scans;
select count(*) from score_trend;
select count(*) from vendor_leaderboard;
select count(*) from industry_summary;
```

```sql
-- EXPECT: reads true, writes false.
select
  has_table_privilege('anon',          'benchmark_samples', 'SELECT') as anon_read,
  has_table_privilege('authenticated', 'benchmark_samples', 'INSERT') as auth_write,
  has_table_privilege('authenticated', 'benchmark_samples', 'UPDATE') as auth_update,
  has_table_privilege('authenticated', 'benchmark_samples', 'DELETE') as auth_delete;
```

Then load `/rankings` in a browser. It should look exactly as it did before —
same vendors, same scores, same ordering. That page is the end-to-end proof
that the corpus moved intact.

### Checkpoint F — after 0008

```sql
-- EXPECT: one row.
select column_name from information_schema.columns
where table_name = 'assessments' and column_name = 'org_vendor_id';
```

```sql
-- EXPECT: security_invoker=on. This view joins two member-scoped tables, so
-- with definer rights it would hand every caller every organisation's
-- portfolio.
select reloptions from pg_class
where relname = 'organisation_vendor_latest' and relkind = 'v';
```

### Checkpoint G — whole-boundary sweep, after everything

```sql
-- EXPECT: zero rows. Every table in `public` is reachable through PostgREST
-- with the anon key; one without row level security has no access control.
select c.relname
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
order by c.relname;
```

```sql
-- EXPECT: zero rows. A table with RLS on and no policy is unreadable by every
-- client. Correct for nothing in this schema at present.
select c.relname
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
  and not exists (select 1 from pg_policy p where p.polrelid = c.oid)
order by c.relname;
```

### Checkpoint H — application, after deploying

1. **Anonymous scan.** Run one signed out. Expect a full result, and no
   "Compare" button — instead "Sign in to save".
2. `select count(*) from assessments;` — **expect 0.** An anonymous scan must
   leave nothing behind.
3. **Compare while signed out.** `GET /api/compare?domain=<anything>` must
   return **401**, not data. This is the IDOR; it is the single most important
   application check.
4. **Sign up**, then `select count(*) from profiles;` — expect 1.
5. **Signed-in scan.** Expect it in `/app`, and `assessments` to have one row
   with your `owner_user_id` and `owner_org_id` null.
6. **Two scans of one domain**, then `/compare?domain=…` — expect a diff, and
   an asset section rather than the "host names were never recorded" limit.
7. **Create an organisation**, issue a join code, and confirm it is shown once.
   Reload the page: the code must not reappear.
8. **A second account** must see none of the first account's assessments —
   `/app` empty, and `/api/compare?domain=<their domain>` returning nothing.

---

## Rollback

### 0002

Reverting restores the vulnerability. The only reason to do it is if something
you did not expect writes with the anon key:

```sql
create policy "Allow public insert" on scan_results for insert with check (true);
grant insert on scan_results to anon, authenticated;
```

Prefer fixing the writer to use the service role.

### 0003–0006, 0008

Drop what they created, newest first:

```sql
drop view  if exists organisation_vendor_latest;
alter table assessments drop column if exists org_vendor_id;
drop table if exists organisation_vendors;
drop table if exists assessment_hosts;
drop table if exists assessments cascade;
drop table if exists organisation_join_codes;
drop table if exists organisation_members;
drop table if exists organisations;
drop type  if exists org_role;
drop function if exists app.is_org_member(uuid), app.has_org_role(uuid, org_role),
                        app.org_role_of(uuid), app.shares_org_with(uuid);
drop trigger if exists on_auth_user_created on auth.users;
drop function if exists public.handle_new_user();
drop table if exists profiles;
drop schema if exists app cascade;
```

Nothing above holds data that existed before the migrations.

### 0007

Points the views back at `scan_results` and removes the corpus table. Safe
because `scan_results` was never modified:

```sql
begin;

drop view if exists industry_summary;
drop view if exists vendor_leaderboard;
drop view if exists score_trend;
drop view if exists latest_scans;

create view latest_scans with (security_invoker = on) as
select distinct on (domain) * from scan_results order by domain, scanned_at desc;

create view score_trend with (security_invoker = on) as
select
  domain, industry,
  composite_score                                                     as current_score,
  lag(composite_score) over (partition by domain order by scanned_at) as previous_score,
  composite_score - lag(composite_score) over (partition by domain order by scanned_at) as delta,
  scanned_at,
  lag(scanned_at) over (partition by domain order by scanned_at)      as previous_scanned_at
from scan_results;

-- vendor_leaderboard and industry_summary: copy their definitions from
-- 0001_baseline.sql, which still holds the scan_results versions verbatim.

drop table if exists benchmark_samples;

commit;
```

Then redeploy the previous application build, since the new one reads
`benchmark_samples`.

---

## If you want me to run it

I have not touched your Supabase project and will not without an explicit
instruction naming the target. The Supabase connector in this session is also
unauthenticated, so it would need authorising from your side first.

If you do want it run, the safer route is a **Supabase branch** — a throwaway
copy of the schema — applied there first, with checkpoints A–G run against the
branch. That exercises the whole sequence against real data shapes with nothing
at stake. Say the word and I will prepare it, but I would still want you to run
the production apply yourself, or to watch it.
