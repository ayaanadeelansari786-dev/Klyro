import { beforeEach, describe, expect, it } from 'vitest';

import { createTestDb, type TestDb } from './harness';

/**
 * The boundary that matters most: nobody reaches another party's assessment.
 *
 * An assessment names a third party's weaknesses in detail. If any of these
 * tests fail, Klyro discloses one customer's supplier analysis to another, and
 * every other property of the system is irrelevant.
 *
 * The scenarios are written the way an attacker would try them: not "does the
 * happy path work" but "what happens when I put someone else's id in the
 * request". Guessing an id is the whole attack — they are UUIDs precisely so
 * it cannot be done by counting, but a system that only relies on ids being
 * unguessable has no access control at all.
 */

let db: TestDb;

interface World {
  alice: string;
  bob: string;
  aliceScan: string;
  bobScan: string;
}

beforeEach(async () => {
  if (db) await db.close();
  db = await createTestDb();
});

async function makeOrg(owner: string, slug: string): Promise<string> {
  const [row] = await db
    .asService()
    .query<{ id: string }>(
      `insert into organisations (name, slug, created_by) values ($1, $2, $3) returning id`,
      [slug, slug, owner],
    );
  return row.id;
}

/** Inserts an assessment the way the scan route will: through the server. */
async function storeAssessment(
  owner: { user?: string; org?: string },
  domain: string,
  score = 80,
  hosts: string[] = [],
): Promise<string> {
  const [row] = await db.asService().query<{ id: string }>(
    `insert into assessments
       (owner_user_id, owner_org_id, created_by, domain, industry, region,
        composite_score, coverage, tool_version, findings, categories, inventory)
     values ($1::uuid, $2::uuid, $3::uuid, $4, 'Technology', 'Global', $5, 1.0, '1.0.0',
             '[{"id":"f1","title":"secret finding"}]'::jsonb,
             '[{"key":"dns","score":90}]'::jsonb,
             '{"hosts":[]}'::jsonb)
     returning id`,
    [owner.user ?? null, owner.org ?? null, owner.user ?? null, domain, score],
  );

  for (const host of hosts) {
    await db
      .asService()
      .query(
        `insert into assessment_hosts (assessment_id, host, addresses) values ($1, $2, $3)`,
        [row.id, host, ['203.0.113.10']],
      );
  }

  return row.id;
}

async function twoUsers(): Promise<World> {
  const alice = await db.createUser('alice@example.test');
  const bob = await db.createUser('bob@example.test');
  return {
    alice,
    bob,
    aliceScan: await storeAssessment({ user: alice }, 'alice-vendor.test', 41),
    bobScan: await storeAssessment({ user: bob }, 'bob-vendor.test', 92),
  };
}

describe('personal assessments', () => {
  it('are visible to the person who created them', async () => {
    const { alice, aliceScan } = await twoUsers();

    const rows = await db
      .asUser(alice)
      .query<{ id: string; domain: string }>(`select id, domain from assessments`);

    expect(rows).toEqual([{ id: aliceScan, domain: 'alice-vendor.test' }]);
  });

  it('are invisible to another signed-in user, even given the exact id', async () => {
    const { bob, aliceScan } = await twoUsers();

    // The IDOR, tried directly. An empty result rather than an error is
    // correct: Bob learns nothing, not even whether the id exists.
    expect(await db.asUser(bob).query(`select * from assessments where id = $1`, [aliceScan])).toEqual([]);
  });

  it('are invisible when queried by domain rather than by id', async () => {
    const { bob } = await twoUsers();

    // The variant that matters for Klyro specifically: the comparison endpoint
    // used to take a domain, not an id, so "guess the id" was never the attack
    // — "know the company name" was.
    expect(
      await db.asUser(bob).query(`select * from assessments where domain = 'alice-vendor.test'`),
    ).toEqual([]);
  });

  it('leak nothing through an aggregate', async () => {
    const { bob } = await twoUsers();

    // A count is a disclosure too: "how many assessments exist for acme.com"
    // answers a question the asker has no right to ask.
    const [row] = await db
      .asUser(bob)
      .query<{ n: number }>(`select count(*)::int as n from assessments`);

    expect(row.n).toBe(1);
  });

  it('are invisible to anonymous callers entirely', async () => {
    await twoUsers();
    expect(await db.asAnon().query(`select * from assessments`)).toEqual([]);
  });

  it('cannot be deleted by another user', async () => {
    const { bob, aliceScan } = await twoUsers();

    await db
      .asUser(bob)
      .affectsNothing(`delete from assessments where id = $1 returning id`, [aliceScan]);

    expect(await db.asService().query(`select 1 from assessments where id = $1`, [aliceScan])).toHaveLength(1);
  });

  it('can be deleted by their owner', async () => {
    const { alice, aliceScan } = await twoUsers();

    await db.asUser(alice).query(`delete from assessments where id = $1`, [aliceScan]);
    expect(await db.asService().query(`select 1 from assessments where id = $1`, [aliceScan])).toEqual([]);
  });
});

describe('organisation assessments', () => {
  it('are visible to every member regardless of role', async () => {
    const owner = await db.createUser();
    const viewer = await db.createUser();
    const org = await makeOrg(owner, 'acme');
    await db
      .asService()
      .query(`insert into organisation_members (org_id, user_id, role) values ($1, $2, 'viewer')`, [
        org,
        viewer,
      ]);

    const scan = await storeAssessment({ org }, 'supplier.test');

    expect(await db.asUser(owner).query(`select id from assessments`)).toEqual([{ id: scan }]);
    expect(await db.asUser(viewer).query(`select id from assessments`)).toEqual([{ id: scan }]);
  });

  it('are invisible to another organisation', async () => {
    const ownerA = await db.createUser();
    const ownerB = await db.createUser();
    const orgA = await makeOrg(ownerA, 'acme');
    await makeOrg(ownerB, 'beta');

    const scan = await storeAssessment({ org: orgA }, 'shared-supplier.test');

    // Both organisations may well assess the same supplier. Knowing that Acme
    // did, and what it scored, is Acme's information.
    expect(await db.asUser(ownerB).query(`select * from assessments where id = $1`, [scan])).toEqual([]);
    expect(
      await db.asUser(ownerB).query(`select * from assessments where domain = 'shared-supplier.test'`),
    ).toEqual([]);
  });

  it('stop being visible the moment a member is removed', async () => {
    const owner = await db.createUser();
    const leaver = await db.createUser();
    const org = await makeOrg(owner, 'acme');
    await db
      .asService()
      .query(`insert into organisation_members (org_id, user_id, role) values ($1, $2, 'analyst')`, [
        org,
        leaver,
      ]);

    const scan = await storeAssessment({ org }, 'supplier.test');
    expect(await db.asUser(leaver).query(`select id from assessments`)).toEqual([{ id: scan }]);

    await db
      .asService()
      .query(`delete from organisation_members where org_id = $1 and user_id = $2`, [org, leaver]);

    // Access is evaluated per query, not granted at join time. Someone who has
    // left keeps nothing.
    expect(await db.asUser(leaver).query(`select id from assessments`)).toEqual([]);
  });

  it('do not appear in a member’s personal history', async () => {
    const owner = await db.createUser();
    const org = await makeOrg(owner, 'acme');
    await storeAssessment({ org }, 'org-supplier.test');
    const personal = await storeAssessment({ user: owner }, 'my-vendor.test');

    const rows = await db
      .asUser(owner)
      .query<{ id: string }>(`select id from assessments where owner_user_id = $1`, [owner]);

    expect(rows).toEqual([{ id: personal }]);
  });

  it('cannot be deleted by a viewer or analyst', async () => {
    const owner = await db.createUser();
    const analyst = await db.createUser();
    const org = await makeOrg(owner, 'acme');
    await db
      .asService()
      .query(`insert into organisation_members (org_id, user_id, role) values ($1, $2, 'analyst')`, [
        org,
        analyst,
      ]);

    const scan = await storeAssessment({ org }, 'supplier.test');

    await db
      .asUser(analyst)
      .affectsNothing(`delete from assessments where id = $1 returning id`, [scan]);
    expect(await db.asService().query(`select 1 from assessments where id = $1`, [scan])).toHaveLength(1);
  });
});

describe('assessments cannot be forged or edited', () => {
  it('refuses a client insert outright', async () => {
    const alice = await db.createUser();

    // Writing an assessment means writing a score and a set of findings under
    // Klyro's name. Only a scan Klyro actually ran may do that.
    const message = await db.asUser(alice).denied(
      `insert into assessments (owner_user_id, domain, industry, region, composite_score)
       values ($1, 'invented.test', 'Technology', 'Global', 100)`,
      [alice],
    );

    expect(message).toMatch(/permission denied|row-level security/i);
  });

  it('refuses an insert naming someone else as owner', async () => {
    const alice = await db.createUser();
    const bob = await db.createUser();

    const message = await db.asUser(alice).denied(
      `insert into assessments (owner_user_id, domain, industry, region, composite_score)
       values ($1, 'planted.test', 'Technology', 'Global', 10)`,
      [bob],
    );

    expect(message).toMatch(/permission denied|row-level security/i);
  });

  it('refuses to let an owner rewrite their own score', async () => {
    const { alice, aliceScan } = await twoUsers();

    // Deletion is the owner's right; revision is not. A report exported from
    // an edited assessment would carry Klyro's name over numbers Klyro never
    // measured.
    const message = await db
      .asUser(alice)
      .denied(`update assessments set composite_score = 100 where id = $1`, [aliceScan]);

    expect(message).toMatch(/cannot be edited/i);
  });

  it('refuses to let an owner rewrite the findings', async () => {
    const { alice, aliceScan } = await twoUsers();

    const message = await db
      .asUser(alice)
      .denied(`update assessments set findings = '[]'::jsonb where id = $1`, [aliceScan]);

    expect(message).toMatch(/cannot be edited/i);
  });

  it('refuses to let an owner hand an assessment to another user', async () => {
    const { alice, bob, aliceScan } = await twoUsers();

    const message = await db
      .asUser(alice)
      .denied(`update assessments set owner_user_id = $1 where id = $2`, [bob, aliceScan]);

    expect(message).toMatch(/cannot be edited/i);
  });

  it('requires exactly one owner at the database level', async () => {
    const alice = await db.createUser();
    const org = await makeOrg(alice, 'acme');

    // Neither owner: a row no policy can match, which would sit in the table
    // waiting for the next mistake to expose it.
    const orphan = await db.asService().denied(
      `insert into assessments (domain, industry, region, composite_score)
       values ('orphan.test', 'Technology', 'Global', 50)`,
    );
    expect(orphan).toMatch(/assessments_one_owner/);

    // Both owners: ambiguous, and would be visible through two different
    // policies with different rules about who may delete it.
    const both = await db.asService().denied(
      `insert into assessments (owner_user_id, owner_org_id, domain, industry, region, composite_score)
       values ($1, $2, 'confused.test', 'Technology', 'Global', 50)`,
      [alice, org],
    );
    expect(both).toMatch(/assessments_one_owner/);
  });
});

describe('host inventory', () => {
  it('travels with its assessment', async () => {
    const alice = await db.createUser();
    const scan = await storeAssessment({ user: alice }, 'vendor.test', 70, [
      'www.vendor.test',
      'staging.vendor.test',
    ]);

    const rows = await db
      .asUser(alice)
      .query<{ host: string }>(
        `select host from assessment_hosts where assessment_id = $1 order by host`,
        [scan],
      );

    expect(rows).toEqual([{ host: 'staging.vendor.test' }, { host: 'www.vendor.test' }]);
  });

  it('is invisible to anyone who cannot see the assessment', async () => {
    const alice = await db.createUser();
    const bob = await db.createUser();
    const scan = await storeAssessment({ user: alice }, 'vendor.test', 70, ['secret.vendor.test']);

    // Host names are among the most sensitive things Klyro records — they are
    // the map of an estate. Reading them through the child table would be a
    // complete bypass of the assessment policy.
    expect(
      await db.asUser(bob).query(`select host from assessment_hosts where assessment_id = $1`, [scan]),
    ).toEqual([]);
    expect(await db.asUser(bob).query(`select host from assessment_hosts`)).toEqual([]);
    expect(await db.asAnon().query(`select host from assessment_hosts`)).toEqual([]);
  });

  it('disappears with its assessment', async () => {
    const alice = await db.createUser();
    const scan = await storeAssessment({ user: alice }, 'vendor.test', 70, ['a.vendor.test']);

    await db.asUser(alice).query(`delete from assessments where id = $1`, [scan]);

    expect(
      await db.asService().query(`select 1 from assessment_hosts where assessment_id = $1`, [scan]),
    ).toEqual([]);
  });

  it('refuses a client writing host rows', async () => {
    const alice = await db.createUser();
    const scan = await storeAssessment({ user: alice }, 'vendor.test');

    const message = await db
      .asUser(alice)
      .denied(`insert into assessment_hosts (assessment_id, host) values ($1, 'planted.test')`, [scan]);

    expect(message).toMatch(/permission denied|row-level security/i);
  });
});

describe('the benchmark corpus stays separate from private data', () => {
  it('does not gain a row when an assessment is stored', async () => {
    const alice = await db.createUser();
    await storeAssessment({ user: alice }, 'private-vendor.test', 33);

    // Contribution is deliberate and currently switched off everywhere. A
    // private assessment must not publish "someone assessed this domain, and
    // it scored 33" as a side effect of being saved.
    expect(
      await db.asAnon().query(`select 1 from benchmark_samples where domain = 'private-vendor.test'`),
    ).toEqual([]);
  });

  it('defaults the contribution flag to off', async () => {
    const alice = await db.createUser();
    const scan = await storeAssessment({ user: alice }, 'vendor.test');

    const [row] = await db
      .asUser(alice)
      .query<{ contributes_to_benchmark: boolean }>(
        `select contributes_to_benchmark from assessments where id = $1`,
        [scan],
      );

    expect(row.contributes_to_benchmark).toBe(false);
  });

  it('keeps the public corpus readable so benchmarking still works', async () => {
    await db
      .asService()
      .query(
        `insert into benchmark_samples (domain, industry, region, composite_score)
         values ('public-peer.test', 'Technology', 'Global', 77)`,
      );

    const rows = await db
      .asAnon()
      .query<{ composite_score: number }>(
        `select composite_score from benchmark_samples where domain = 'public-peer.test'`,
      );

    expect(rows).toEqual([{ composite_score: 77 }]);
  });

  it('carries the seeded corpus across from the old table', async () => {
    // 0007 backfills `scan_results` into `benchmark_samples`. Losing that
    // would silently empty every industry average.
    const [before] = await db
      .asService()
      .query<{ n: number }>(`select count(*)::int as n from scan_results`);
    const [after] = await db
      .asService()
      .query<{ n: number }>(`select count(*)::int as n from benchmark_samples`);

    expect(after.n).toBeGreaterThanOrEqual(before.n);
  });
});
