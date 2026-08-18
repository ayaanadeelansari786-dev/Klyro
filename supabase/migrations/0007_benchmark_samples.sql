-- 0007 — The benchmark corpus, separated from private data.
--
-- The benchmark has to be readable by everyone: percentiles, industry
-- averages and the rankings page are the product's claim to objectivity, and
-- they are worthless if only the person who ran the scan can see them.
-- Assessments have to be readable by almost nobody. Those two requirements
-- cannot be satisfied by one table with one policy.
--
-- Row level security is per row, not per column, so "public may read these
-- five columns and members may read all of them" is not something a policy can
-- say. It could be approximated with column grants and a permissive row
-- policy, but then the isolation of private data would rest on the exact set
-- of columns granted — and every future column would be private by
-- forgetfulness rather than by design.
--
-- So the corpus is its own table, holding only what a benchmark needs: a
-- domain, a score, an industry and a date. No findings, no inventory, no
-- owner, and no path back to who ran the assessment. A leak of this table
-- discloses what a public leaderboard already discloses.
--
-- Nothing writes to it automatically. Contribution is a deliberate act — see
-- `assessments.contributes_to_benchmark`, which is off by default — and until
-- that is switched on the corpus is exactly the seeded dataset it is today.

create table if not exists benchmark_samples (
  id              uuid primary key default gen_random_uuid(),

  -- Nullable and ON DELETE SET NULL on purpose: a person deleting their own
  -- assessment should not silently rewrite an industry average that has
  -- already been published. The sample survives, anonymous, as it always was.
  assessment_id   uuid references assessments(id) on delete set null,

  domain          text not null,
  industry        text not null,
  region          text not null,
  composite_score integer not null check (composite_score between 0 and 100),
  risk_level      text,
  coverage        numeric,
  category_scores jsonb not null default '{}'::jsonb,
  tool_version    text,
  run_label       text,
  scanned_at      timestamptz not null default now()
);

create index if not exists idx_samples_industry_region on benchmark_samples (industry, region, scanned_at desc);
create index if not exists idx_samples_domain          on benchmark_samples (domain, scanned_at desc);
create index if not exists idx_samples_industry        on benchmark_samples (industry, scanned_at desc);

-- ---------------------------------------------------------------- --
-- Backfill
--
-- Every existing row moves across. These are the seeded vendors and the
-- anonymous scans collected before accounts existed — no owner, no private
-- content, which is precisely the shape this table is for.
--
-- Guarded by NOT EXISTS on the id so re-running the migration does not double
-- the corpus, which would halve nothing and skew every average.
-- ---------------------------------------------------------------- --
insert into benchmark_samples (
  id, domain, industry, region, composite_score, risk_level, coverage,
  category_scores, tool_version, run_label, scanned_at
)
select
  s.id, s.domain, s.industry, s.region, s.composite_score, s.risk_level, s.coverage,
  coalesce(s.category_scores, '{}'::jsonb), s.tool_version, s.run_label,
  coalesce(s.scanned_at, now())
from scan_results s
where not exists (select 1 from benchmark_samples b where b.id = s.id);

-- ---------------------------------------------------------------- --
-- Views move to the corpus
--
-- Same definitions, different source. `security_invoker` stays on so they
-- carry the caller's rights rather than the definer's — with a public-read
-- table that changes nothing today, and it is what stops these views becoming
-- a way around row level security if they are ever joined to something
-- private.
-- ---------------------------------------------------------------- --
-- `create or replace view` cannot change a view's column list, and these
-- views were defined over `scan_results`, which has columns the corpus does
-- not (`vendor_id`, `scan_metadata`, the full findings blob). They have to be
-- dropped and rebuilt, in dependency order — `industry_summary` reads
-- `vendor_leaderboard`.
drop view if exists industry_summary;
drop view if exists vendor_leaderboard;
drop view if exists score_trend;
drop view if exists latest_scans;

-- Columns named rather than `select *`: a view built on a star silently
-- changes shape the next time a column is added to the table underneath it,
-- and these are read by the rankings page.
create view latest_scans
with (security_invoker = on) as
select distinct on (domain)
  id, assessment_id, domain, industry, region, composite_score, risk_level,
  coverage, category_scores, tool_version, run_label, scanned_at
from benchmark_samples
order by domain, scanned_at desc;

create view score_trend
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
from benchmark_samples;

create view vendor_leaderboard
with (security_invoker = on) as
with ranked as (
  select
    domain, industry, region, composite_score, risk_level, coverage,
    category_scores, scanned_at, run_label,
    row_number() over (partition by domain order by scanned_at desc) as recency
  from benchmark_samples
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

create view industry_summary
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
-- Policies: read by all, written by none
-- ---------------------------------------------------------------- --
alter table benchmark_samples enable row level security;

drop policy if exists "samples: public read" on benchmark_samples;
create policy "samples: public read" on benchmark_samples
  for select using (true);

-- The lesson of 0002, applied on the first day rather than the last: a corpus
-- anyone can write to cannot support a claim about anything.
revoke insert, update, delete, truncate on benchmark_samples from anon, authenticated;
grant select on benchmark_samples to anon, authenticated;

-- `scan_results` is left in place, unmodified and read-only, as the record of
-- what the corpus looked like before this split. Nothing writes to it any
-- more. Dropping it is a separate decision, taken once the new corpus has been
-- running long enough to trust.
comment on table scan_results is
  'Superseded by benchmark_samples in migration 0007. Retained read-only; nothing writes here.';
