import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestDb, type TestDb } from './harness';

/**
 * The benchmark corpus must not be writable with the anon key.
 *
 * `NEXT_PUBLIC_SUPABASE_ANON_KEY` is in the browser bundle — that is what the
 * prefix means — so "anon can insert" is the same statement as "anyone on the
 * internet can insert". The baseline schema shipped exactly that, for
 * `scan_results`, `vendors` and `ownership_assessments`.
 *
 * The consequence is not abstract. Klyro's benchmark is its claim to
 * objectivity: percentiles, industry averages, the rankings page. A corpus
 * that anyone can write to supports none of it. A single forged row can move a
 * vendor's percentile, and a forged `vendors` update can rewrite who owns a
 * company.
 *
 * These tests run against the real migrations, so they fail if 0002 is ever
 * reverted, half-reverted, or undone by a later migration adding a permissive
 * policy back.
 */

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db?.close();
});

const TABLES = ['scan_results', 'vendors', 'ownership_assessments'] as const;

/** Minimal legal row per table, so a refusal is about permission, not shape. */
const VALID_ROW: Record<(typeof TABLES)[number], { sql: string; params: unknown[] }> = {
  scan_results: {
    sql: `insert into scan_results (domain, industry, region, composite_score)
          values ($1, 'Technology', 'Global', 100)`,
    params: ['forged.example'],
  },
  vendors: {
    sql: `insert into vendors (domain, display_name, industry, region)
          values ($1, 'Forged', 'Technology', 'Global')`,
    params: ['forged.example'],
  },
  ownership_assessments: {
    sql: `insert into ownership_assessments (vendor_id, vendor_domain, narrative)
          values (gen_random_uuid(), $1, 'forged')`,
    params: ['forged.example'],
  },
};

describe('anonymous callers', () => {
  it.each(TABLES)('cannot insert into %s', async (table) => {
    const { sql, params } = VALID_ROW[table];
    const message = await db.asAnon().denied(sql, params);

    // Either mechanism is a pass — the migration removes both the policy and
    // the grant, deliberately, because they fail independently.
    expect(message).toMatch(/permission denied|row-level security/i);
  });

  it('cannot update a vendor ownership record', async () => {
    await db
      .asService()
      .query(
        `insert into vendors (domain, display_name, industry, region)
         values ('real.example', 'Real', 'Technology', 'Global')`,
      );

    const message = await db
      .asAnon()
      .denied(`update vendors set parent_name = 'Forged Parent' where domain = 'real.example'`);

    expect(message).toMatch(/permission denied|row-level security/i);

    const [row] = await db
      .asAnon()
      .query<{ parent_name: string | null }>(
        `select parent_name from vendors where domain = 'real.example'`,
      );
    expect(row.parent_name).toBeNull();
  });

  it('cannot delete from the corpus', async () => {
    await db
      .asService()
      .query(
        `insert into scan_results (domain, industry, region, composite_score)
         values ('keep.example', 'Technology', 'Global', 70)`,
      );

    const message = await db.asAnon().denied(`delete from scan_results where domain = 'keep.example'`);
    expect(message).toMatch(/permission denied|row-level security/i);

    const rows = await db
      .asAnon()
      .query(`select 1 from scan_results where domain = 'keep.example'`);
    expect(rows).toHaveLength(1);
  });
});

describe('signed-in callers', () => {
  it.each(TABLES)('get no write access to %s either', async (table) => {
    const userId = await db.createUser();
    const { sql, params } = VALID_ROW[table];

    // Holding an account is not a reason to be able to write to the corpus.
    // Contribution, when it is added, will run server-side through the
    // service role rather than by granting users direct table access.
    const message = await db.asUser(userId).denied(sql, params);
    expect(message).toMatch(/permission denied|row-level security/i);
  });
});

describe('reads stay public', () => {
  it('lets anyone read the corpus, which is the point of a benchmark', async () => {
    await db
      .asService()
      .query(
        `insert into scan_results (domain, industry, region, composite_score)
         values ('readable.example', 'Technology', 'Global', 82)`,
      );

    const anon = await db
      .asAnon()
      .query<{ composite_score: number }>(
        `select composite_score from scan_results where domain = 'readable.example'`,
      );

    expect(anon).toEqual([{ composite_score: 82 }]);
  });

  it('still exposes the aggregate views the rankings page reads', async () => {
    const rows = await db.asAnon().query(`select * from industry_summary`);
    expect(Array.isArray(rows)).toBe(true);
  });
});

/**
 * The test that makes the rest of this file mean something.
 *
 * Everything above asserts that a write is refused. A refusal is also what you
 * get from a harness that forgot to grant table privileges, from a typo in a
 * table name, or from a database that never ran the migration at all — so a
 * green suite is not by itself evidence that 0002 does anything.
 *
 * This runs the baseline *alone* and asserts the write succeeds. It is the
 * control: the vulnerability is reproduced, which is what proves the tests
 * above are observing the fix rather than an artefact of the harness.
 */
describe('the vulnerability, reproduced as a control', () => {
  /*
   * These reintroduce the exact policy and grant that 0002 removed, confirm
   * the forged write then succeeds, and remove them again.
   *
   * The control used to run the baseline alone, but the baseline no longer
   * contains the vulnerable statements: leaving executable SQL that reopens a
   * security hole meant a replay of the migration folder — after a restore, or
   * on a new environment — would undo 0002 silently. Recreating the condition
   * here keeps the proof without shipping the footgun.
   *
   * The proof matters because every other test in this file asserts a refusal,
   * and a refusal is also what a broken harness produces. This is what shows
   * they are observing the fix.
   */
  async function withPermissivePolicy(run: () => Promise<void>) {
    // Through `raw`, not `asService()`: creating a policy is owner-level DDL,
    // and `service_role` bypasses row level security without owning the table.
    // That distinction is worth knowing — it is also why the service role
    // cannot quietly grant itself more than it already has.
    await db.raw.exec(`
      create policy "temp permissive insert" on scan_results for insert with check (true);
      grant insert on scan_results to anon;
    `);
    try {
      await run();
    } finally {
      await db.raw.exec(`
        drop policy if exists "temp permissive insert" on scan_results;
        revoke insert on scan_results from anon;
      `);
    }
  }

  it('would let anyone forge a benchmark row, were the policy restored', async () => {
    await withPermissivePolicy(async () => {
      await db.asAnon().query(
        `insert into scan_results (domain, industry, region, composite_score)
         values ('forged.example', 'Technology', 'Global', 100)`,
      );

      const rows = await db
        .asAnon()
        .query<{ composite_score: number }>(
          `select composite_score from scan_results where domain = 'forged.example'`,
        );

      // A perfect score for a domain nobody scanned, written by a browser.
      expect(rows).toEqual([{ composite_score: 100 }]);
    });

    // And with it gone again, the same write is refused.
    const message = await db.asAnon().denied(
      `insert into scan_results (domain, industry, region, composite_score)
       values ('forged-two.example', 'Technology', 'Global', 100)`,
    );
    expect(message).toMatch(/permission denied|row-level security/i);
  });

  it('keeps the baseline itself free of write policies', async () => {
    // Guards the footgun directly: a replay of 0001 must not restore write
    // access, whatever else it does.
    const baseline = await createTestDb({ upTo: '0001' });

    try {
      const message = await baseline.asAnon().denied(
        `insert into scan_results (domain, industry, region, composite_score)
         values ('forged.example', 'Technology', 'Global', 100)`,
      );
      expect(message).toMatch(/permission denied|row-level security/i);

      // Reads still work at the baseline, which is the half that must survive.
      expect(await baseline.asAnon().query(`select 1 from scan_results limit 1`)).toEqual([]);
    } finally {
      await baseline.close();
    }
  });
});

describe('the service role', () => {
  it('can still write, because that is how seeding works', async () => {
    await db
      .asService()
      .query(
        `insert into vendors (domain, display_name, industry, region)
         values ('seeded.example', 'Seeded', 'Technology', 'Global')`,
      );

    const rows = await db
      .asService()
      .query(`select domain from vendors where domain = 'seeded.example'`);
    expect(rows).toHaveLength(1);
  });
});
