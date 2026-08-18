import { beforeAll, afterAll, describe, expect, it } from 'vitest';

import { createTestDb, type TestDb } from './harness';

/**
 * The post-migration verification checklist, executed.
 *
 * Every query in `supabase/DEPLOYMENT.md` runs here against a database with
 * the migrations applied, and the expected result is asserted. A checklist
 * handed to somebody to run against production should not be the first time
 * the SQL in it has been executed — a typo turns "verify the fix" into "the
 * verification errored, assume it is fine".
 *
 * If a query here changes, change it in the runbook too. They are the same
 * queries by intent, and this file is what keeps that true.
 */

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db?.close();
});

describe('checkpoint 0002 — public writes are gone', () => {
  it('finds no non-SELECT policy on the corpus tables', async () => {
    const rows = await db.asService().query(`
      select c.relname as table_name, p.polname as policy, p.polcmd as command
      from pg_policy p
      join pg_class c on c.oid = p.polrelid
      where c.relname in ('scan_results', 'vendors', 'ownership_assessments')
        and p.polcmd <> 'r'
    `);

    expect(rows).toEqual([]);
  });

  it('finds no write grant to anon or authenticated on the corpus tables', async () => {
    /*
     * `has_table_privilege` rather than `information_schema.role_table_grants`.
     *
     * The information_schema views report privileges only where the grantor or
     * grantee is a *currently enabled role*, so asking them about another
     * role's grants can return nothing whether or not the grant exists — an
     * empty result that reads as a pass and proves nothing. These functions
     * answer directly for any named role.
     */
    const [row] = await db.asService().query<Record<string, boolean>>(`
      select
        has_table_privilege('anon',          'scan_results',          'INSERT') as anon_insert_scans,
        has_table_privilege('anon',          'scan_results',          'UPDATE') as anon_update_scans,
        has_table_privilege('anon',          'scan_results',          'DELETE') as anon_delete_scans,
        has_table_privilege('authenticated', 'scan_results',          'INSERT') as auth_insert_scans,
        has_table_privilege('anon',          'vendors',               'INSERT') as anon_insert_vendors,
        has_table_privilege('anon',          'vendors',               'UPDATE') as anon_update_vendors,
        has_table_privilege('authenticated', 'vendors',               'UPDATE') as auth_update_vendors,
        has_table_privilege('anon',          'ownership_assessments', 'INSERT') as anon_insert_ownership
    `);

    expect(Object.entries(row).filter(([, granted]) => granted)).toEqual([]);
  });

  it('confirms the read grants survived, so the check above means something', async () => {
    // The positive control. Without it every assertion here would also pass
    // against a database where these tables did not exist at all.
    const [row] = await db.asService().query<Record<string, boolean>>(`
      select
        has_table_privilege('anon',          'scan_results', 'SELECT') as anon_read_scans,
        has_table_privilege('authenticated', 'vendors',      'SELECT') as auth_read_vendors
    `);

    expect(row).toEqual({ anon_read_scans: true, auth_read_vendors: true });
  });

  it('confirms the read policies survived', async () => {
    const rows = await db.asService().query<{ table_name: string }>(`
      select c.relname as table_name
      from pg_policy p
      join pg_class c on c.oid = p.polrelid
      where c.relname in ('scan_results', 'vendors', 'ownership_assessments')
        and p.polcmd = 'r'
      order by c.relname
    `);

    expect(rows.map((r) => r.table_name)).toEqual([
      'ownership_assessments',
      'scan_results',
      'vendors',
    ]);
  });
});

describe('checkpoint 0003 — profiles', () => {
  it('confirms every account has a profile', async () => {
    await db.createUser('backfill-check@example.test', 'Backfilled');

    const [row] = await db.asService().query<{ orphans: number }>(`
      select count(*)::int as orphans
      from auth.users u
      where not exists (select 1 from public.profiles p where p.id = u.id)
    `);

    expect(row.orphans).toBe(0);
  });

  it('confirms the signup trigger is attached', async () => {
    const rows = await db.asService().query(`
      select tgname from pg_trigger
      where tgname = 'on_auth_user_created' and not tgisinternal
    `);

    expect(rows).toHaveLength(1);
  });
});

describe('checkpoint 0004 — roles and helpers', () => {
  it('confirms the role enum is ordered by privilege', async () => {
    const rows = await db.asService().query<{ enumlabel: string }>(`
      select enumlabel from pg_enum
      join pg_type on pg_type.oid = pg_enum.enumtypid
      where pg_type.typname = 'org_role'
      order by enumsortorder
    `);

    // The order is not cosmetic: `role >= 'admin'` in a policy depends on it.
    expect(rows.map((r) => r.enumlabel)).toEqual(['viewer', 'analyst', 'admin', 'owner']);
  });

  it('confirms the membership helpers are SECURITY DEFINER', async () => {
    const rows = await db.asService().query<{ proname: string; prosecdef: boolean }>(`
      select p.proname, p.prosecdef
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'app'
        and p.proname in ('is_org_member', 'has_org_role', 'org_role_of', 'shares_org_with')
      order by p.proname
    `);

    expect(rows).toHaveLength(4);
    // Without SECURITY DEFINER these recurse: a policy on organisation_members
    // that reads organisation_members to decide access.
    expect(rows.every((r) => r.prosecdef)).toBe(true);
  });

  it('confirms clients cannot insert membership or create organisations directly', async () => {
    const [row] = await db.asService().query<Record<string, boolean>>(`
      select
        has_table_privilege('authenticated', 'organisation_members', 'INSERT') as auth_join,
        has_table_privilege('anon',          'organisation_members', 'INSERT') as anon_join,
        has_table_privilege('authenticated', 'organisations',        'INSERT') as auth_create,
        -- Control: membership must stay readable, or the product breaks.
        has_table_privilege('authenticated', 'organisation_members', 'SELECT') as auth_read
    `);

    expect(row).toEqual({ auth_join: false, anon_join: false, auth_create: false, auth_read: true });
  });
});

describe('checkpoint 0005 — join codes', () => {
  it('confirms the hash is unreadable while the rest of the row is readable', async () => {
    /*
     * Both halves in one assertion, because each is meaningless alone. If the
     * hash were readable the control is broken; if the hint were not, the
     * table-level revoke went too far and administrators cannot manage codes.
     */
    const [row] = await db.asService().query<Record<string, boolean>>(`
      select
        has_column_privilege('authenticated', 'organisation_join_codes', 'code_hash',  'SELECT') as auth_hash,
        has_column_privilege('anon',          'organisation_join_codes', 'code_hash',  'SELECT') as anon_hash,
        has_column_privilege('authenticated', 'organisation_join_codes', 'code_hint',  'SELECT') as auth_hint,
        has_column_privilege('authenticated', 'organisation_join_codes', 'expires_at', 'SELECT') as auth_expiry
    `);

    expect(row).toEqual({ auth_hash: false, anon_hash: false, auth_hint: true, auth_expiry: true });
  });
});

describe('checkpoint 0006 — the ownership boundary', () => {
  it('confirms the one-owner constraint exists', async () => {
    const rows = await db.asService().query(`
      select conname from pg_constraint where conname = 'assessments_one_owner'
    `);

    expect(rows).toHaveLength(1);
  });

  it('confirms no client role may insert an assessment or a host row', async () => {
    const [row] = await db.asService().query<Record<string, boolean>>(`
      select
        has_table_privilege('authenticated', 'assessments',      'INSERT') as auth_insert,
        has_table_privilege('anon',          'assessments',      'INSERT') as anon_insert,
        has_table_privilege('authenticated', 'assessment_hosts', 'INSERT') as auth_hosts,
        -- Control: owners must still read and delete their own.
        has_table_privilege('authenticated', 'assessments',      'SELECT') as auth_read,
        has_table_privilege('authenticated', 'assessments',      'DELETE') as auth_delete
    `);

    expect(row).toEqual({
      auth_insert: false,
      anon_insert: false,
      auth_hosts: false,
      auth_read: true,
      auth_delete: true,
    });
  });

  it('confirms row level security is enabled on both tables', async () => {
    const rows = await db.asService().query<{ relname: string; relrowsecurity: boolean }>(`
      select relname, relrowsecurity
      from pg_class
      where relname in ('assessments', 'assessment_hosts')
      order by relname
    `);

    expect(rows).toEqual([
      { relname: 'assessment_hosts', relrowsecurity: true },
      { relname: 'assessments', relrowsecurity: true },
    ]);
  });
});

describe('checkpoint 0007 — the corpus split', () => {
  it('confirms the backfill moved every row across', async () => {
    // The query the runbook gives: a non-zero result means rows were left
    // behind and every industry average is now computed from a smaller pool.
    const rows = await db.asService().query(`
      select s.id, s.domain
      from scan_results s
      where not exists (select 1 from benchmark_samples b where b.id = s.id)
    `);

    expect(rows).toEqual([]);
  });

  it('confirms the four views now read the corpus', async () => {
    const rows = await db.asService().query<{ viewname: string }>(`
      select viewname from pg_views
      where viewname in ('latest_scans', 'score_trend', 'vendor_leaderboard', 'industry_summary')
      order by viewname
    `);

    expect(rows.map((r) => r.viewname)).toEqual([
      'industry_summary',
      'latest_scans',
      'score_trend',
      'vendor_leaderboard',
    ]);
  });

  it('confirms every view still carries security_invoker', async () => {
    const rows = await db.asService().query<{ relname: string; reloptions: string[] | null }>(`
      select c.relname, c.reloptions
      from pg_class c
      where c.relkind = 'v'
        and c.relname in ('latest_scans', 'score_trend', 'vendor_leaderboard', 'industry_summary')
      order by c.relname
    `);

    expect(rows).toHaveLength(4);
    // Without it a view runs with its definer's rights, which turns any future
    // join to a private table into a way around row level security.
    for (const row of rows) {
      expect(row.reloptions?.join(',') ?? '').toMatch(/security_invoker=(on|true)/);
    }
  });

  it('confirms the views are queryable by an anonymous caller', async () => {
    // The rankings page is public and reads these. A view that errors here is
    // a blank page in production.
    for (const view of ['latest_scans', 'score_trend', 'vendor_leaderboard', 'industry_summary']) {
      const rows = await db.asAnon().query(`select * from ${view} limit 1`);
      expect(Array.isArray(rows)).toBe(true);
    }
  });

  it('confirms the corpus is readable by all and writable by none', async () => {
    const [row] = await db.asService().query<Record<string, boolean>>(`
      select
        has_table_privilege('anon',          'benchmark_samples', 'SELECT') as anon_read,
        has_table_privilege('authenticated', 'benchmark_samples', 'SELECT') as auth_read,
        has_table_privilege('anon',          'benchmark_samples', 'INSERT') as anon_write,
        has_table_privilege('authenticated', 'benchmark_samples', 'INSERT') as auth_write,
        has_table_privilege('authenticated', 'benchmark_samples', 'UPDATE') as auth_update,
        has_table_privilege('authenticated', 'benchmark_samples', 'DELETE') as auth_delete
    `);

    expect(row).toEqual({
      anon_read: true,
      auth_read: true,
      anon_write: false,
      auth_write: false,
      auth_update: false,
      auth_delete: false,
    });
  });
});

describe('checkpoint 0008 — vendor portfolio', () => {
  it('confirms the link column was added to assessments', async () => {
    const rows = await db.asService().query(`
      select column_name from information_schema.columns
      where table_name = 'assessments' and column_name = 'org_vendor_id'
    `);

    expect(rows).toHaveLength(1);
  });

  it('confirms the portfolio view carries security_invoker', async () => {
    const [row] = await db.asService().query<{ reloptions: string[] | null }>(`
      select reloptions from pg_class
      where relname = 'organisation_vendor_latest' and relkind = 'v'
    `);

    // This one joins two member-scoped tables. With definer rights it would
    // hand every caller every organisation's portfolio.
    expect(row.reloptions?.join(',') ?? '').toMatch(/security_invoker=(on|true)/);
  });
});

describe('final state — the whole boundary at once', () => {
  it('lists every table with RLS enabled and no policy, which must be intentional', async () => {
    const rows = await db.asService().query<{ relname: string }>(`
      select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relkind = 'r'
        and c.relrowsecurity
        and not exists (select 1 from pg_policy p where p.polrelid = c.oid)
      order by c.relname
    `);

    // A table in this list is unreadable by every client. That is correct for
    // nothing at present — every protected table has at least a read policy.
    expect(rows.map((r) => r.relname)).toEqual([]);
  });

  it('lists every public table without RLS, which must be empty', async () => {
    const rows = await db.asService().query<{ relname: string }>(`
      select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relkind = 'r'
        and not c.relrowsecurity
      order by c.relname
    `);

    // Every table in the public schema is reachable through PostgREST with the
    // anon key. One without row level security is one with no access control.
    expect(rows.map((r) => r.relname)).toEqual([]);
  });
});

/**
 * The corpus the benchmark actually reads.
 *
 * Migration 0007 split the shared corpus out of `scan_results` into
 * `benchmark_samples`, and every read path moved with it — percentiles,
 * industry averages, the rankings page. Anything that still writes to the old
 * table is writing where nothing looks, which is a failure that shows up as
 * "the benchmark says there is no data" rather than as an error.
 */
describe('benchmark corpus is what the pool statistics are computed from', () => {
  it('counts a sample with no assessment behind it, which is what seeding writes', async () => {
    await db.asService().query(
      `insert into benchmark_samples
         (assessment_id, domain, industry, region, composite_score, risk_level,
          coverage, category_scores, tool_version, run_label)
       values (null, $1, 'Technology', 'UAE', 74, 'Moderate Risk', 1,
               '{"dns": 74}'::jsonb, '1.1.0', 'audit-seed')`,
      ['seeded-corpus.test'],
    );

    // `assessment_id` is null on purpose for a seeded run: nobody's
    // organisation ran it, so there is no private row for it to point at.
    // The column is nullable precisely so this insert is legal.
    const [row] = await db.asAnon().query<{ n: number }>(
      `select count(*)::int as n from benchmark_samples
       where domain = $1 and industry = 'Technology' and region = 'UAE'`,
      ['seeded-corpus.test'],
    );

    expect(row.n).toBe(1);
  });

  it('exposes that sample to an anonymous reader, which the benchmark relies on', async () => {
    // The benchmark is read with the anon key from the browser's session. A
    // corpus only the server can see would make every percentile blank.
    const rows = await db
      .asAnon()
      .query<{ domain: string }>(
        `select domain from benchmark_samples where run_label = 'audit-seed'`,
      );

    expect(rows.map((r) => r.domain)).toContain('seeded-corpus.test');
  });

  it('surfaces the sample through the leaderboard view the rankings page reads', async () => {
    const rows = await db
      .asAnon()
      .query<{ domain: string; composite_score: number }>(
        `select domain, composite_score from vendor_leaderboard where domain = $1`,
        ['seeded-corpus.test'],
      );

    // The view is defined over `benchmark_samples`, so a sample that does not
    // appear here would not appear on the rankings page either.
    expect(rows).toHaveLength(1);
    expect(rows[0].composite_score).toBe(74);
  });

  it('keeps a published sample when the assessment behind it is deleted', async () => {
    const user = await db.createUser();

    const [assessment] = await db.asService().query<{ id: string }>(
      `insert into assessments
         (owner_user_id, created_by, domain, industry, region, composite_score,
          contributes_to_benchmark)
       values ($1, $1, 'contributed.test', 'Technology', 'UAE', 61, true)
       returning id`,
      [user],
    );

    await db.asService().query(
      `insert into benchmark_samples
         (assessment_id, domain, industry, region, composite_score, category_scores)
       values ($1, 'contributed.test', 'Technology', 'UAE', 61, '{}'::jsonb)`,
      [assessment.id],
    );

    await db.asUser(user).query(`delete from assessments where id = $1 returning id`, [
      assessment.id,
    ]);

    const [row] = await db.asAnon().query<{ n: number; assessment_id: string | null }>(
      `select count(*)::int as n, max(assessment_id::text) as assessment_id
       from benchmark_samples where domain = 'contributed.test'`,
    );

    /*
     * The point of `on delete set null` rather than `on delete cascade`.
     *
     * Somebody deleting their own assessment should not silently rewrite an
     * industry average that has already been published — a corpus that shrinks
     * retroactively is not one anyone can cite. The sample survives, and loses
     * the only thing that pointed back at who ran it.
     */
    expect(row.n).toBe(1);
    expect(row.assessment_id).toBeNull();
  });
});
