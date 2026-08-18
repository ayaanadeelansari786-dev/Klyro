-- 0008 — An organisation's vendor portfolio.
--
-- Separate from the `vendors` table, which is the seeded public registry of
-- who a company is. This is an organisation's own record of a supplier: the
-- name they call them internally, the reference number in their procurement
-- system, how much they depend on them. None of that is public, and putting it
-- in the shared registry would mean one buyer's private note about a supplier
-- sitting in a table everybody reads.
--
-- No dashboard is built on this yet. The view at the bottom is included
-- because it is the whole query — an organisation's vendors with their latest
-- score — and having it here means the dashboard is a read rather than a
-- migration.

create table if not exists organisation_vendors (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organisations(id) on delete cascade,

  domain       text not null,
  display_name text not null check (length(trim(display_name)) between 1 and 160),
  -- Their reference for this supplier: a contract number, a vendor ID.
  internal_ref text,
  -- How much the organisation depends on this supplier. Deliberately the
  -- buyer's own judgement and never inferred from a score: Klyro can measure a
  -- domain's exposure, and has no way to know whether that domain runs payroll
  -- or a marketing microsite.
  criticality  text check (criticality is null or criticality in ('critical','high','medium','low')),
  notes        text,

  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  unique (org_id, domain)
);

create index if not exists idx_org_vendors_org on organisation_vendors (org_id, display_name);

-- Assessments can be filed against a vendor record. Nullable: a scan run
-- before the vendor was catalogued is still the organisation's assessment.
alter table assessments
  add column if not exists org_vendor_id uuid references organisation_vendors(id) on delete set null;

create index if not exists idx_assessments_org_vendor
  on assessments (org_vendor_id, scanned_at desc);

-- ---------------------------------------------------------------- --
-- Policies
-- ---------------------------------------------------------------- --
alter table organisation_vendors enable row level security;

drop policy if exists "org vendors: read as member" on organisation_vendors;
create policy "org vendors: read as member" on organisation_vendors
  for select to authenticated
  using (app.is_org_member(org_id));

-- Analyst and above. A viewer can read the portfolio and not edit it, which is
-- the distinction the role exists to make.
drop policy if exists "org vendors: analysts write" on organisation_vendors;
create policy "org vendors: analysts write" on organisation_vendors
  for insert to authenticated
  with check (app.has_org_role(org_id, 'analyst'));

drop policy if exists "org vendors: analysts update" on organisation_vendors;
create policy "org vendors: analysts update" on organisation_vendors
  for update to authenticated
  using (app.has_org_role(org_id, 'analyst'))
  with check (app.has_org_role(org_id, 'analyst'));

drop policy if exists "org vendors: admins delete" on organisation_vendors;
create policy "org vendors: admins delete" on organisation_vendors
  for delete to authenticated
  using (app.has_org_role(org_id, 'admin'));

-- ---------------------------------------------------------------- --
-- The portfolio, with each vendor's most recent assessment
--
-- `security_invoker` matters here in a way it does not for the public views:
-- this joins two member-scoped tables, and with the default (definer rights)
-- it would hand every caller every organisation's portfolio. The one word is
-- the difference between a view and a data leak.
-- ---------------------------------------------------------------- --
create or replace view organisation_vendor_latest
with (security_invoker = on) as
with latest as (
  select
    v.id   as org_vendor_id,
    v.org_id,
    v.domain,
    v.display_name,
    v.criticality,
    v.internal_ref,
    a.id   as assessment_id,
    a.composite_score,
    a.risk_level,
    a.coverage,
    a.scanned_at
  from organisation_vendors v
  left join lateral (
    select id, composite_score, risk_level, coverage, scanned_at
    from assessments
    where org_vendor_id = v.id
    order by scanned_at desc
    limit 1
  ) a on true
),
-- The median has to be computed here rather than as a window function:
-- `percentile_cont` is an ordered-set aggregate and Postgres does not accept
-- OVER on one. Vendors with no assessment yet are excluded from both figures
-- so an uncatalogued supplier does not drag the average toward zero.
portfolio as (
  select
    org_id,
    round(avg(composite_score))                                    as portfolio_average,
    percentile_cont(0.5) within group (order by composite_score)   as portfolio_median,
    count(*)                                                       as assessed_vendors
  from latest
  where composite_score is not null
  group by org_id
)
select
  l.*,
  -- Position within this organisation's own portfolio, which is the
  -- comparison a buyer actually wants: not "how does Acme rank globally" but
  -- "which of my suppliers is the weakest".
  rank() over (partition by l.org_id order by l.composite_score desc nulls last) as portfolio_rank,
  p.portfolio_average,
  p.portfolio_median,
  p.assessed_vendors
from latest l
left join portfolio p on p.org_id = l.org_id;
