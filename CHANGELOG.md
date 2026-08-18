# Changelog

All notable changes to Klyro are recorded here.

`TOOL_VERSION` in `src/lib/constants.ts` is written onto every stored
assessment, so a report can always be traced to the version that produced it.

## [1.1.0] — 2026-08-18

### Fixed

- Rate limiting is now persistent across Vercel instances and redeploys
  (Upstash Redis, sliding window). Falls back to the previous in-memory
  limiter when Redis credentials are not configured, which is what local
  development uses — that fallback is a supported mode, not a stub. A Redis
  call that fails at runtime falls back the same way rather than failing the
  request.
- The concurrent-scan gate is now a deployment-wide ceiling rather than a
  per-instance one, held in a Redis sorted set with a stale-entry sweep so a
  function killed mid-scan cannot consume a slot permanently. Slots are taken
  through a single Lua script, so two instances cannot both pass the check.
- Report endpoint now fetches from the stored assessment when `assessmentId`
  is provided, binding the PDF to what Klyro actually measured. The read runs
  under the caller's own credentials, so the row-level security policy on
  `assessments` decides who may render what. The anonymous path is unchanged.
- Seeding wrote only to `scan_results`, which nothing has read since migration
  0007 moved the corpus to `benchmark_samples`. Seeded vendors now reach the
  pool the benchmark is actually computed from.

### Added

- Benchmark opt-in: organisations can contribute anonymised scan scores to the
  industry comparison pool. Off by default, toggle on the organisation page,
  admin or owner only — enforced by the database policy, not by the route.
- One sample per organisation per domain per day, so a domain watched closely
  cannot stand in for a pool of peers.
- Onboarding prompt for benchmark opt-in after creating an organisation.
  Both answers dismiss it; neither blocks anything.
- "Verified report" label on the PDF download button when the report will be
  built from a saved assessment rather than from page state.
- Contribution note on the Industry Benchmark page of the PDF, shown only when
  the assessment was in fact contributed.
- `PATCH /api/org/[orgId]`, carrying exactly one writable field.
- Database tests covering who may change `benchmark_opt_in`, and covering the
  corpus the pool statistics are read from.
- This file.

### Changed

- `consumeRateLimit`, `acquireScanSlot` and `activeScanCount` are now async,
  because the shared counters live over HTTP. Every call site was already
  inside an async handler; the names and return shapes are unchanged.

### Notes for operators

- Set `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` in production.
  Without them the deployment runs on the in-memory limiter, where the
  effective limit is the configured one multiplied by the number of warm
  instances.
- No migration is required for this release. `organisations.benchmark_opt_in`
  and `assessments.contributes_to_benchmark` already existed and were unread;
  this version reads them.

## [1.0.0]

Initial release. Eleven check modules, weighted composite scoring with
coverage renormalisation, PDF reporting, accounts and organisations with
row-level security, and a seeded benchmark corpus.
