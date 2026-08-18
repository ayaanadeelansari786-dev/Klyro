-- 0006 — Assessments, and the ownership boundary.
--
-- This is the table the whole access model exists to protect. An assessment
-- names a third party's weaknesses in detail — exposed administrative paths,
-- host names that should not be public, mail that can be forged — and an
-- organisation assessing a supplier has not agreed to show that to anyone
-- else. One wrong policy here is a breach; one wrong policy anywhere else is
-- an inconvenience.
--
-- Two things about the shape:
--
-- 1. It stores the complete result, not a summary. `scan_results` kept scores
--    and findings but not the category detail or the inventory, so a stored
--    scan could not reproduce its own report and a comparison could not tell
--    which host names had appeared or gone. Reconstructing that from a summary
--    is guesswork; keeping it is a JSONB column.
--
-- 2. Anonymous scans are not here at all. They have no owner, so no policy
--    could ever match them, and a row nobody can read is a row that exists to
--    be leaked by the next mistake. An anonymous scan streams its result to
--    the person who asked for it and leaves nothing behind.

create table if not exists assessments (
  id             uuid primary key default gen_random_uuid(),

  -- Exactly one of these, enforced below. Personal or organisational; never
  -- both, and never neither.
  owner_user_id  uuid references auth.users(id)   on delete cascade,
  owner_org_id   uuid references organisations(id) on delete cascade,

  -- Who ran it. Distinct from ownership: an analyst's scan belongs to the
  -- organisation, and survives that analyst leaving.
  created_by     uuid references auth.users(id) on delete set null,

  domain         text not null,
  industry       text not null,
  region         text not null,

  composite_score integer not null check (composite_score between 0 and 100),
  risk_level      text,
  coverage        numeric check (coverage is null or (coverage >= 0 and coverage <= 1)),
  tool_version    text,
  scanned_at      timestamptz not null default now(),

  -- The full result. These four are the difference between a stored score and
  -- a reproducible report.
  category_scores jsonb not null default '{}'::jsonb,   -- Record<CategoryKey, number>
  categories      jsonb not null default '[]'::jsonb,   -- CategoryResult[]
  findings        jsonb not null default '[]'::jsonb,   -- Finding[]
  inventory       jsonb,                                 -- AssetInventory | null
  -- What the benchmark said at the time. Kept because the corpus moves: a
  -- report reprinted next year should show the comparison it was written
  -- with, not a different one computed from a larger pool.
  benchmark       jsonb,

  -- Nothing reads this yet. It exists so that contributing to the shared
  -- corpus is a deliberate switch rather than a schema change, and it is off
  -- by default because publishing "we assessed acme.com" is a disclosure the
  -- assessing party has to make on purpose.
  contributes_to_benchmark boolean not null default false,

  created_at     timestamptz not null default now(),

  constraint assessments_one_owner
    check (num_nonnulls(owner_user_id, owner_org_id) = 1)
);

-- "My history" and "my organisation's history", the two queries the product
-- makes constantly.
create index if not exists idx_assessments_user   on assessments (owner_user_id, scanned_at desc);
create index if not exists idx_assessments_org    on assessments (owner_org_id,  scanned_at desc);
-- Comparison: two runs of one domain within one owner's scope.
create index if not exists idx_assessments_domain on assessments (domain, scanned_at desc);

-- ---------------------------------------------------------------- --
-- Hosts, as rows rather than as JSON
--
-- The inventory is also kept whole in `assessments.inventory`, so this is
-- deliberate duplication. It earns it: comparing two assessments means asking
-- which host names are in one and not the other, and that is a join over
-- indexed rows rather than a scan that parses two JSON documents. It also
-- makes "every host this organisation has ever seen" a query rather than a
-- migration, which is what the vendor dashboard will need.
-- ---------------------------------------------------------------- --
create table if not exists assessment_hosts (
  id              bigint generated always as identity primary key,
  assessment_id   uuid not null references assessments(id) on delete cascade,

  host            text not null,
  -- 'apex' | 'certificate-transparency', matching HostAsset.origin.
  origin          text not null default 'certificate-transparency',
  addresses       text[] not null default '{}',
  reverse_dns     text[] not null default '{}',
  asns            text[] not null default '{}',
  -- False means the lookup budget ran out before this host, which is not the
  -- same as "no network was found" and must not be rendered as if it were.
  network_looked_up boolean not null default false,
  naming_suggests text,

  unique (assessment_id, host)
);

create index if not exists idx_assessment_hosts_assessment on assessment_hosts (assessment_id);
-- "Where else have we seen this host name?" across an owner's assessments.
create index if not exists idx_assessment_hosts_host on assessment_hosts (host);

-- ---------------------------------------------------------------- --
-- Policies
-- ---------------------------------------------------------------- --
alter table assessments      enable row level security;
alter table assessment_hosts enable row level security;

/*
 * Read: yours, or your organisation's.
 *
 * `app.is_org_member(null)` is false rather than an error, so a personal
 * assessment falls through to the first branch and an organisation assessment
 * to the second. There is no third branch, which is the point — an assessment
 * with no owner cannot exist (see the check constraint), and if one somehow
 * did it would be invisible to every client rather than visible to all of them.
 */
drop policy if exists "assessments: read own or org" on assessments;
create policy "assessments: read own or org" on assessments
  for select to authenticated
  using (
    owner_user_id = auth.uid()
    or app.is_org_member(owner_org_id)
  );

/*
 * Write: the server, and only the server.
 *
 * There is no INSERT policy. An assessment is the output of a scan Klyro ran;
 * letting a client write one would mean letting it invent scores, findings and
 * evidence and store them under Klyro's name. The scan route inserts through
 * the service role after it has established who the caller is.
 */
revoke insert on assessments from anon, authenticated;

-- Deleting your own history is reasonable. Editing it is not: an assessment is
-- a record of what was observed at a moment, and a mutable one is worthless as
-- evidence. Only the columns that express intent rather than observation are
-- writable, and that is enforced by the trigger below.
drop policy if exists "assessments: update own or org admin" on assessments;
create policy "assessments: update own or org admin" on assessments
  for update to authenticated
  using (
    owner_user_id = auth.uid()
    or app.has_org_role(owner_org_id, 'admin')
  )
  with check (
    owner_user_id = auth.uid()
    or app.has_org_role(owner_org_id, 'admin')
  );

drop policy if exists "assessments: delete own or org admin" on assessments;
create policy "assessments: delete own or org admin" on assessments
  for delete to authenticated
  using (
    owner_user_id = auth.uid()
    or app.has_org_role(owner_org_id, 'admin')
  );

/*
 * The observation is immutable.
 *
 * Without this, an owner could rewrite `composite_score` or delete findings
 * from a stored assessment and then export it as a Klyro report. The policy
 * above cannot express "these columns but not those", so a trigger does.
 */
create or replace function app.assessments_are_append_only() returns trigger
  language plpgsql
as $$
begin
  if new.domain          is distinct from old.domain
     or new.composite_score is distinct from old.composite_score
     or new.risk_level     is distinct from old.risk_level
     or new.coverage       is distinct from old.coverage
     or new.tool_version   is distinct from old.tool_version
     or new.scanned_at     is distinct from old.scanned_at
     or new.category_scores is distinct from old.category_scores
     or new.categories      is distinct from old.categories
     or new.findings        is distinct from old.findings
     or new.inventory       is distinct from old.inventory
     or new.benchmark       is distinct from old.benchmark
     or new.owner_user_id   is distinct from old.owner_user_id
     or new.owner_org_id    is distinct from old.owner_org_id
  then
    raise exception
      'An assessment records what was observed at a point in time and cannot be edited. Run a new assessment instead.'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists on_assessment_update_append_only on assessments;
create trigger on_assessment_update_append_only
  before update on assessments
  for each row execute function app.assessments_are_append_only();

/*
 * Hosts inherit their assessment's visibility.
 *
 * The subquery is itself subject to the assessments policy above — Postgres
 * applies row level security to tables referenced inside a policy expression —
 * so this is not a second copy of the ownership rule that could drift from the
 * first. It is the same rule, consulted.
 */
drop policy if exists "assessment hosts: read via assessment" on assessment_hosts;
create policy "assessment hosts: read via assessment" on assessment_hosts
  for select to authenticated
  using (
    exists (select 1 from assessments a where a.id = assessment_hosts.assessment_id)
  );

revoke insert, update, delete on assessment_hosts from anon, authenticated;
