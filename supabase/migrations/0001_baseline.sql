-- 0001 — Baseline.
--
-- The schema as it stood before the account/organisation work: a public
-- benchmark corpus with no concept of a user. Recorded verbatim so an existing
-- deployment and a fresh one converge on the same starting point, and so the
-- migrations that follow have something to be diffed against.
--
-- The write policies at the bottom of this file are the reason 0002 exists.
-- They are reproduced here as history, not as intent — do not copy them.
--
-- Idempotent, safe to re-run.

-- ---------------------------------------------------------------- --
-- 1. Canonical vendor registry
-- ---------------------------------------------------------------- --
create table if not exists vendors (
  id                        uuid primary key default gen_random_uuid(),
  domain                    text not null unique,
  display_name              text not null,
  legal_name                text,
  industry                  text not null,
  region                    text not null,
  hq_country                text,

  -- Ownership is recorded as fact + provenance, never as an inherited score.
  ownership_type            text not null default 'unknown'
                            check (ownership_type in
                              ('independent','subsidiary','division','joint_venture','acquired','unknown')),
  parent_name               text,
  parent_domain             text,
  ultimate_parent_name      text,
  ownership_source          text,
  ownership_source_url      text,
  ownership_confidence      text not null default 'unknown'
                            check (ownership_confidence in ('confirmed','reported','inferred','unknown')),
  ownership_note            text,
  lei                       text,

  -- True when this row exists because it is some other vendor's parent.
  is_parent_entity          boolean not null default false,

  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

create index if not exists idx_vendors_industry_region on vendors(industry, region);
create index if not exists idx_vendors_parent_domain   on vendors(parent_domain);

-- ---------------------------------------------------------------- --
-- 2. Historical scans. Every run is kept; nothing is overwritten.
-- ---------------------------------------------------------------- --
create table if not exists scan_results (
  id               uuid primary key default gen_random_uuid(),
  domain           text not null,
  industry         text not null,
  region           text not null,
  composite_score  integer not null check (composite_score between 0 and 100),
  category_scores  jsonb not null default '{}'::jsonb,
  findings         jsonb not null default '[]'::jsonb,
  scan_metadata    jsonb default '{}'::jsonb,
  scanned_at       timestamptz default now()
);

alter table scan_results add column if not exists vendor_id    uuid references vendors(id) on delete set null;
alter table scan_results add column if not exists risk_level   text;
alter table scan_results add column if not exists coverage     numeric;
alter table scan_results add column if not exists tool_version text;
alter table scan_results add column if not exists run_label    text;

create index if not exists idx_scan_domain_time   on scan_results(domain, scanned_at desc);
create index if not exists idx_scan_vendor_time   on scan_results(vendor_id, scanned_at desc);
create index if not exists idx_scan_industry_time on scan_results(industry, scanned_at desc);
create index if not exists idx_scan_run_label     on scan_results(run_label);
create index if not exists idx_scan_industry_region on scan_results(industry, region);

-- ---------------------------------------------------------------- --
-- 3. Parent-influence assessments
--
-- Deliberately separate from `vendors`: "does the parent's posture actually
-- reach this subsidiary?" is answered from measured infrastructure overlap
-- between two scans, and that answer changes over time. It is evidence, so it
-- is versioned like evidence.
-- ---------------------------------------------------------------- --
create table if not exists ownership_assessments (
  id                     uuid primary key default gen_random_uuid(),
  vendor_id              uuid not null references vendors(id) on delete cascade,
  vendor_domain          text not null,
  parent_domain          text,
  parent_name            text,
  assessed_at            timestamptz not null default now(),

  shares_nameservers     boolean,
  shares_mail_provider   boolean,
  shares_tls_issuer      boolean,
  shares_registrar       boolean,
  linkage_signals        integer not null default 0,
  linkage_verdict        text not null default 'unknown'
                         check (linkage_verdict in
                           ('integrated','partially_integrated','independent','unknown')),

  vendor_score           integer,
  parent_score           integer,
  score_delta            integer,

  narrative              text not null,
  evidence               jsonb not null default '{}'::jsonb
);

create index if not exists idx_ownership_vendor_time on ownership_assessments(vendor_id, assessed_at desc);

-- ---------------------------------------------------------------- --
-- 4. Views: latest state, rankings, trend
-- ---------------------------------------------------------------- --
create or replace view latest_scans
with (security_invoker = on) as
select distinct on (domain) *
from scan_results
order by domain, scanned_at desc;

create or replace view score_trend
with (security_invoker = on) as
select
  domain,
  industry,
  composite_score                                                         as current_score,
  lag(composite_score) over (partition by domain order by scanned_at)     as previous_score,
  composite_score
    - lag(composite_score) over (partition by domain order by scanned_at) as delta,
  scanned_at,
  lag(scanned_at) over (partition by domain order by scanned_at)          as previous_scanned_at
from scan_results;

-- Ranked leaderboard with score movement and ownership, in one query.
create or replace view vendor_leaderboard
with (security_invoker = on) as
with ranked as (
  select
    domain, industry, region, composite_score, risk_level, coverage,
    category_scores, scanned_at, run_label,
    row_number() over (partition by domain order by scanned_at desc) as recency
  from scan_results
),
current_scan  as (select * from ranked where recency = 1),
previous_scan as (select * from ranked where recency = 2)
select
  c.domain,
  v.display_name,
  c.industry,
  c.region,
  c.composite_score,
  c.risk_level,
  c.coverage,
  c.category_scores,
  c.scanned_at,
  p.composite_score                              as previous_score,
  c.composite_score - p.composite_score          as score_delta,
  p.scanned_at                                   as previous_scanned_at,
  v.parent_name,
  v.parent_domain,
  v.ownership_type,
  v.ownership_confidence,
  v.is_parent_entity,
  oa.linkage_verdict,
  oa.parent_score,
  oa.narrative                                   as ownership_narrative,
  rank()   over (partition by c.industry order by c.composite_score desc) as industry_rank,
  count(*) over (partition by c.industry)                                 as industry_size,
  round(avg(c.composite_score) over (partition by c.industry))            as industry_average,
  rank()   over (order by c.composite_score desc)                         as overall_rank,
  count(*) over ()                                                        as overall_size
from current_scan c
left join previous_scan p on p.domain = c.domain
left join vendors v       on v.domain = c.domain
left join lateral (
  select linkage_verdict, parent_score, narrative
  from ownership_assessments o
  where o.vendor_domain = c.domain
  order by o.assessed_at desc
  limit 1
) oa on true;

create or replace view industry_summary
with (security_invoker = on) as
select
  industry,
  count(*)                                                          as vendors,
  round(avg(composite_score))                                       as average_score,
  percentile_cont(0.5) within group (order by composite_score)::int  as median_score,
  min(composite_score)                                              as min_score,
  max(composite_score)                                              as max_score,
  count(*) filter (where parent_name is not null)                   as with_parent
from vendor_leaderboard
group by industry;

-- ---------------------------------------------------------------- --
-- 5. Row level security
--
-- Read is public — the benchmark is only useful if it can be read.
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

-- ---------------------------------------------------------------- --
-- The write policies this baseline originally carried
--
-- Recorded here as text, deliberately not as SQL:
--
--   create policy "Allow public insert"   on scan_results          for insert with check (true);
--   create policy "seed insert vendors"   on vendors               for insert with check (true);
--   create policy "seed update vendors"   on vendors               for update using (true) with check (true);
--   create policy "seed insert ownership" on ownership_assessments for insert with check (true);
--
-- They existed for the seeding phase and were a standing vulnerability: the
-- anon key ships in the browser bundle, so "anon may insert" means anyone may
-- forge a benchmark score for any domain and rewrite any vendor's ownership
-- record. 0002 removes them.
--
-- Leaving them executable here would mean that re-running the baseline — after
-- a restore, on a new environment, or by someone replaying the folder — undoes
-- 0002 and silently reopens the hole. A fresh database has no use for them
-- either, since 0002 follows immediately. So the record stays and the
-- statements do not.
-- ---------------------------------------------------------------- --
