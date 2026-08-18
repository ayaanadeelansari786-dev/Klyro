# Klyro database

Numbered migrations, applied in order, each one idempotent. There is no
dashboard-authored schema: if it is not in `migrations/`, it does not exist.

## Deploying to a live project

**[DEPLOYMENT.md](DEPLOYMENT.md)** is the runbook: which migrations are
destructive, which need downtime, what could be lost, the sequencing trap
between 0002 and the code deploy, a verification checkpoint after each one, and
rollback scripts. Every query in it is executed by
`tests/db/verification-queries.test.ts`, so the checklist has been run before
you run it.

## Applying them

```bash
supabase link --project-ref <your-project-ref>
supabase db push
```

Or, without the CLI, paste each file into the Supabase SQL editor **in
numerical order**. They are safe to re-run — every statement is guarded with
`if not exists`, `create or replace`, or `drop ... if exists` — so a partial
application can be repaired by running the whole set again.

## Apply 0002 first, and separately

`0002_revoke_public_writes.sql` closes a hole that exists in any deployment
running the baseline schema: the anon key, which ships in the browser bundle by
definition, could insert rows into `scan_results` and rewrite `vendors`. That
means anyone could forge benchmark scores for any domain and rewrite who owns a
company.

It does not depend on anything after it. Apply it now, on its own, ahead of the
account work.

## The migrations

| File | What it does |
|---|---|
| `0001_baseline.sql` | The schema as it stood before accounts, minus the four permissive write policies it used to create — those are recorded as comments, because leaving them executable meant a replay of this folder would silently undo 0002. |
| `0002_revoke_public_writes.sql` | **Security fix.** Removes anon/authenticated write access to the corpus. Reads stay public. |
| `0003_profiles.sql` | A public-schema row per user holding only a display name, plus the trigger that creates it on signup. |
| `0004_organisations.sql` | `org_role` enum, organisations, membership, the `app.*` helper functions, and the owner-lockout trigger. |
| `0005_join_codes.sql` | Join codes, stored as a keyed hash with the hash column revoked even from admins. |
| `0006_assessments.sql` | The full assessment snapshot and its host rows, with the ownership boundary. |
| `0007_benchmark_samples.sql` | Splits the public corpus from private data; backfills from `scan_results`; repoints the four views. |
| `0008_organisation_vendors.sql` | An organisation's own vendor portfolio, and the view a dashboard would read. |

## Two things that are easy to get wrong

**Helper functions must be `SECURITY DEFINER`.** The natural policy on
`organisation_members` reads `organisation_members` to decide whether you may
read `organisation_members`, and Postgres refuses with infinite recursion.
`app.is_org_member()` and friends exist to break that cycle.

**A column-level `REVOKE` does nothing while a table-level `GRANT` stands.**
Postgres treats them as separate grants, and the table-level one satisfies a
read of any column. `0005` therefore revokes `SELECT` on the whole table and
then grants it back column by column, omitting `code_hash`. Writing
`revoke select (code_hash)` alone looks correct and leaves the hash readable —
this was caught by a test rather than by review.

## Testing

```bash
npm run test:db
```

Boots PGlite — real Postgres, compiled to WebAssembly, in process — creates the
`auth` schema and the `anon` / `authenticated` / `service_role` roles that
Supabase provides, replays every migration in this directory, and then attacks
the result: cross-user reads, cross-organisation reads, role escalation, direct
membership inserts, forged assessments, join code expiry and revocation.

No Docker required, and the policies are enforced by Postgres rather than
asserted against a mock.

One detail in the harness matters more than it looks: it applies Supabase's
default privileges (`grant all on tables to anon, authenticated`) *before*
running the migrations. Without that, every unauthorised query would fail with
"permission denied" and the suite would pass while proving nothing about the
policies. The tests are meant to fail the way production would.

`tests/db/public-writes.test.ts` includes a control that runs the baseline
alone and asserts the write **succeeds** — reproducing the vulnerability, which
is what shows the other assertions are observing the fix rather than an
artefact of the harness.
