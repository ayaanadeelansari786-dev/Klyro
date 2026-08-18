import { beforeEach, describe, expect, it } from 'vitest';

import { createTestDb, type TestDb } from './harness';

/**
 * Organisation membership, roles, and the boundaries between organisations.
 *
 * Every assertion here runs against the real policies. Where a test expects a
 * refusal it uses `denied()`, which fails loudly if the statement is permitted
 * — a security test that quietly passes when the operation succeeds is worse
 * than not having written it.
 */

let db: TestDb;

/**
 * Creates an organisation the way the server does.
 *
 * Through the service role, because clients cannot insert here — see the note
 * in 0004. The ownership trigger still does the work of making the creator an
 * owner, so this exercises the same path production takes.
 */
async function makeOrg(owner: string, name: string, slug: string): Promise<string> {
  const [row] = await db
    .asService()
    .query<{ id: string }>(
      `insert into organisations (name, slug, created_by) values ($1, $2, $3) returning id`,
      [name, slug, owner],
    );
  return row.id;
}

async function addMember(org: string, user: string, role: string): Promise<void> {
  await db
    .asService()
    .query(`insert into organisation_members (org_id, user_id, role) values ($1, $2, $3::org_role)`, [
      org,
      user,
      role,
    ]);
}

beforeEach(async () => {
  if (db) await db.close();
  db = await createTestDb();
});

describe('creating an organisation', () => {
  it('makes the creator its owner without a second call', async () => {
    const user = await db.createUser();
    const org = await makeOrg(user, 'Acme Security', 'acme');

    const rows = await db
      .asUser(user)
      .query<{ role: string }>(`select role from organisation_members where org_id = $1`, [org]);

    expect(rows).toEqual([{ role: 'owner' }]);
  });

  it('refuses a signed-in client inserting an organisation directly', async () => {
    const attacker = await db.createUser();
    const victim = await db.createUser();

    // Creation goes through the server. A client that could insert here could
    // also set `created_by` to another user, and the ownership trigger would
    // hand that user an organisation they never asked for.
    const message = await db
      .asUser(attacker)
      .denied(`insert into organisations (name, slug, created_by) values ('Evil', 'evil', $1)`, [
        victim,
      ]);

    expect(message).toMatch(/permission denied|row-level security/i);
  });

  it('refuses an anonymous caller outright', async () => {
    const message = await db
      .asAnon()
      .denied(`insert into organisations (name, slug) values ('Anon Corp', 'anon-corp')`);

    expect(message).toMatch(/permission denied|row-level security/i);
  });

  it('refuses a duplicate slug', async () => {
    const a = await db.createUser();
    const b = await db.createUser();
    await makeOrg(a, 'Acme', 'acme');

    const message = await db
      .asService()
      .denied(`insert into organisations (name, slug, created_by) values ('Acme Two', 'acme', $1)`, [
        b,
      ]);

    expect(message).toMatch(/duplicate key|unique/i);
  });

  it('refuses an uppercase slug outright, so case can never collide', async () => {
    const user = await db.createUser();

    // Two guards, deliberately. The check constraint keeps stored slugs
    // lowercase, and the unique index is built on lower(slug) so that even if
    // the constraint were relaxed later, "Acme" and "acme" could not coexist.
    const message = await db
      .asService()
      .denied(`insert into organisations (name, slug, created_by) values ('Acme', 'ACME', $1)`, [user]);

    expect(message).toMatch(/violates check constraint/i);
  });
});

describe('visibility between organisations', () => {
  it('shows an organisation only to its members', async () => {
    const insider = await db.createUser();
    const outsider = await db.createUser();
    const org = await makeOrg(insider, 'Acme', 'acme');

    expect(await db.asUser(insider).query(`select id from organisations where id = $1`, [org])).toHaveLength(1);

    // Not an error — an empty result. The outsider cannot tell the difference
    // between "exists but is not mine" and "does not exist", which is the
    // correct amount of information to give them.
    expect(await db.asUser(outsider).query(`select id from organisations where id = $1`, [org])).toEqual([]);
    expect(await db.asAnon().query(`select id from organisations where id = $1`, [org])).toEqual([]);
  });

  it('does not leak the member list to another organisation', async () => {
    const ownerA = await db.createUser();
    const ownerB = await db.createUser();
    const orgA = await makeOrg(ownerA, 'Acme', 'acme');
    await makeOrg(ownerB, 'Beta', 'beta');

    expect(
      await db.asUser(ownerB).query(`select user_id from organisation_members where org_id = $1`, [orgA]),
    ).toEqual([]);
  });

  it('shows profile names to colleagues and to nobody else', async () => {
    const owner = await db.createUser('owner@acme.test', 'Ada');
    const colleague = await db.createUser('colleague@acme.test', 'Grace');
    const stranger = await db.createUser('stranger@other.test', 'Mallory');

    const org = await makeOrg(owner, 'Acme', 'acme');
    await addMember(org, colleague, 'analyst');

    const seen = await db
      .asUser(owner)
      .query<{ display_name: string }>(`select display_name from profiles where id = $1`, [colleague]);
    expect(seen).toEqual([{ display_name: 'Grace' }]);

    // A stranger cannot enumerate account names.
    expect(await db.asUser(stranger).query(`select display_name from profiles where id = $1`, [colleague])).toEqual([]);
  });

  it('creates a profile automatically on signup', async () => {
    const user = await db.createUser('someone@example.test', 'Someone');
    const [row] = await db
      .asUser(user)
      .query<{ display_name: string }>(`select display_name from profiles where id = $1`, [user]);

    expect(row.display_name).toBe('Someone');
  });

  it('falls back to the local part of the address when no name was given', async () => {
    const user = await db.createUser('nameless@example.test');
    const [row] = await db
      .asUser(user)
      .query<{ display_name: string }>(`select display_name from profiles where id = $1`, [user]);

    expect(row.display_name).toBe('nameless');
  });
});

describe('roles', () => {
  it('ranks in ascending privilege so policies can compare with >=', async () => {
    const [row] = await db.asService().query<Record<string, boolean>>(`
      select ('owner'::org_role   > 'admin'::org_role)   as owner_beats_admin,
             ('admin'::org_role   > 'analyst'::org_role) as admin_beats_analyst,
             ('analyst'::org_role > 'viewer'::org_role)  as analyst_beats_viewer
    `);

    expect(row).toEqual({
      owner_beats_admin: true,
      admin_beats_analyst: true,
      analyst_beats_viewer: true,
    });
  });

  it('lets an admin change a non-owner’s role', async () => {
    const owner = await db.createUser();
    const admin = await db.createUser();
    const viewer = await db.createUser();
    const org = await makeOrg(owner, 'Acme', 'acme');
    await addMember(org, admin, 'admin');
    await addMember(org, viewer, 'viewer');

    await db
      .asUser(admin)
      .query(`update organisation_members set role = 'analyst' where org_id = $1 and user_id = $2`, [
        org,
        viewer,
      ]);

    const [row] = await db
      .asUser(admin)
      .query<{ role: string }>(
        `select role from organisation_members where org_id = $1 and user_id = $2`,
        [org, viewer],
      );
    expect(row.role).toBe('analyst');
  });

  it('stops an admin promoting themselves to owner', async () => {
    const owner = await db.createUser();
    const admin = await db.createUser();
    const org = await makeOrg(owner, 'Acme', 'acme');
    await addMember(org, admin, 'admin');

    // The escalation that matters: admin is already trusted, so the only
    // boundary left is the one between admin and owner.
    await db
      .asUser(admin)
      .denied(`update organisation_members set role = 'owner' where org_id = $1 and user_id = $2`, [
        org,
        admin,
      ]);

    const [row] = await db
      .asUser(admin)
      .query<{ role: string }>(
        `select role from organisation_members where org_id = $1 and user_id = $2`,
        [org, admin],
      );
    expect(row.role).toBe('admin');
  });

  it('stops an admin demoting the owner', async () => {
    const owner = await db.createUser();
    const admin = await db.createUser();
    const org = await makeOrg(owner, 'Acme', 'acme');
    await addMember(org, admin, 'admin');

    // The owner's row is not visible to this UPDATE, so Postgres reports
    // success having changed nothing rather than raising. Both the row count
    // and the stored role are checked, because "no error" alone would also be
    // the result if the policy were missing and the update had gone through.
    await db
      .asUser(admin)
      .affectsNothing(
        `update organisation_members set role = 'viewer'
         where org_id = $1 and user_id = $2 returning user_id`,
        [org, owner],
      );

    const [row] = await db
      .asService()
      .query<{ role: string }>(
        `select role from organisation_members where org_id = $1 and user_id = $2`,
        [org, owner],
      );
    expect(row.role).toBe('owner');
  });

  it('stops an admin removing the owner', async () => {
    const owner = await db.createUser();
    const admin = await db.createUser();
    const org = await makeOrg(owner, 'Acme', 'acme');
    await addMember(org, admin, 'admin');

    await db
      .asUser(admin)
      .affectsNothing(
        `delete from organisation_members where org_id = $1 and user_id = $2 returning user_id`,
        [org, owner],
      );

    expect(
      await db
        .asService()
        .query(`select 1 from organisation_members where org_id = $1 and user_id = $2`, [org, owner]),
    ).toHaveLength(1);
  });

  it('stops a viewer managing anyone', async () => {
    const owner = await db.createUser();
    const viewer = await db.createUser();
    const other = await db.createUser();
    const org = await makeOrg(owner, 'Acme', 'acme');
    await addMember(org, viewer, 'viewer');
    await addMember(org, other, 'analyst');

    await db
      .asUser(viewer)
      .affectsNothing(
        `update organisation_members set role = 'admin'
         where org_id = $1 and user_id = $2 returning user_id`,
        [org, other],
      );

    const [row] = await db
      .asService()
      .query<{ role: string }>(
        `select role from organisation_members where org_id = $1 and user_id = $2`,
        [org, other],
      );
    expect(row.role).toBe('analyst');
  });

  it('lets a member leave on their own account', async () => {
    const owner = await db.createUser();
    const member = await db.createUser();
    const org = await makeOrg(owner, 'Acme', 'acme');
    await addMember(org, member, 'analyst');

    await db
      .asUser(member)
      .query(`delete from organisation_members where org_id = $1 and user_id = $2`, [org, member]);

    expect(
      await db.asUser(owner).query(`select 1 from organisation_members where user_id = $1`, [member]),
    ).toEqual([]);
  });

  it('refuses to let the last owner strand the organisation', async () => {
    const owner = await db.createUser();
    const org = await makeOrg(owner, 'Acme', 'acme');

    // Leaving would be permitted by the policy — it is the caller's own row.
    // The constraint trigger is what stops it, because an organisation with no
    // owner can never be administered again.
    const message = await db
      .asUser(owner)
      .denied(`delete from organisation_members where org_id = $1 and user_id = $2`, [org, owner]);

    expect(message).toMatch(/at least one owner/i);
  });

  it('lets the last owner leave once another owner exists', async () => {
    const first = await db.createUser();
    const second = await db.createUser();
    const org = await makeOrg(first, 'Acme', 'acme');
    await addMember(org, second, 'owner');

    await db
      .asUser(first)
      .query(`delete from organisation_members where org_id = $1 and user_id = $2`, [org, first]);

    const remaining = await db
      .asUser(second)
      .query<{ user_id: string }>(`select user_id from organisation_members where org_id = $1`, [org]);
    expect(remaining).toEqual([{ user_id: second }]);
  });

  it('lets an owner delete the whole organisation, members and all', async () => {
    const owner = await db.createUser();
    const member = await db.createUser();
    const org = await makeOrg(owner, 'Acme', 'acme');
    await addMember(org, member, 'analyst');

    await db.asUser(owner).query(`delete from organisations where id = $1`, [org]);

    expect(await db.asService().query(`select 1 from organisation_members where org_id = $1`, [org])).toEqual([]);
  });

  it('stops an admin deleting the organisation', async () => {
    const owner = await db.createUser();
    const admin = await db.createUser();
    const org = await makeOrg(owner, 'Acme', 'acme');
    await addMember(org, admin, 'admin');

    await db
      .asUser(admin)
      .affectsNothing(`delete from organisations where id = $1 returning id`, [org]);

    expect(await db.asService().query(`select 1 from organisations where id = $1`, [org])).toHaveLength(1);
  });
});

/**
 * Benchmark contribution.
 *
 * This flag decides whether an organisation's assessments become public data,
 * so who may change it is a security question rather than a settings one. The
 * route that writes it does no role check of its own — it runs as the caller
 * and lets the UPDATE policy on `organisations` decide — which means these
 * tests are the only place that behaviour is actually asserted.
 */
describe('benchmark opt-in', () => {
  it('is off for a newly created organisation', async () => {
    const owner = await db.createUser();
    const org = await makeOrg(owner, 'Acme', 'acme');

    const [row] = await db
      .asUser(owner)
      .query<{ benchmark_opt_in: boolean }>(
        `select benchmark_opt_in from organisations where id = $1`,
        [org],
      );

    // Publishing "we assessed acme.com, it scored 61" is a disclosure the
    // assessing party has to make on purpose. Defaulting it on would make it
    // for them.
    expect(row.benchmark_opt_in).toBe(false);
  });

  it.each([
    ['owner', 'owner'],
    ['admin', 'admin'],
  ])('lets an %s turn it on', async (_label, role) => {
    const owner = await db.createUser();
    const org = await makeOrg(owner, 'Acme', 'acme');

    let actor = owner;
    if (role !== 'owner') {
      actor = await db.createUser();
      await addMember(org, actor, role);
    }

    await db
      .asUser(actor)
      .query(`update organisations set benchmark_opt_in = true where id = $1 returning id`, [org]);

    const [row] = await db
      .asService()
      .query<{ benchmark_opt_in: boolean }>(
        `select benchmark_opt_in from organisations where id = $1`,
        [org],
      );

    expect(row.benchmark_opt_in).toBe(true);
  });

  it.each([['viewer'], ['analyst']])('does not let a %s turn it on', async (role) => {
    const owner = await db.createUser();
    const member = await db.createUser();
    const org = await makeOrg(owner, 'Acme', 'acme');
    await addMember(org, member, role);

    /*
     * `affectsNothing`, not `denied`. Row level security filters rather than
     * refuses: the organisation row is simply not visible to this UPDATE, so
     * the statement succeeds having changed nothing and Postgres reports no
     * error. Asserting an exception here would produce a test that passes
     * whether or not the policy exists.
     */
    await db
      .asUser(member)
      .affectsNothing(`update organisations set benchmark_opt_in = true where id = $1 returning id`, [
        org,
      ]);

    const [row] = await db
      .asService()
      .query<{ benchmark_opt_in: boolean }>(
        `select benchmark_opt_in from organisations where id = $1`,
        [org],
      );

    expect(row.benchmark_opt_in).toBe(false);
  });

  it('does not let a non-member turn it on', async () => {
    const owner = await db.createUser();
    const outsider = await db.createUser();
    const org = await makeOrg(owner, 'Acme', 'acme');

    await db
      .asUser(outsider)
      .affectsNothing(`update organisations set benchmark_opt_in = true where id = $1 returning id`, [
        org,
      ]);

    const [row] = await db
      .asService()
      .query<{ benchmark_opt_in: boolean }>(
        `select benchmark_opt_in from organisations where id = $1`,
        [org],
      );

    expect(row.benchmark_opt_in).toBe(false);
  });

  it('lets an admin turn it back off', async () => {
    const owner = await db.createUser();
    const org = await makeOrg(owner, 'Acme', 'acme');

    await db
      .asUser(owner)
      .query(`update organisations set benchmark_opt_in = true where id = $1 returning id`, [org]);
    await db
      .asUser(owner)
      .query(`update organisations set benchmark_opt_in = false where id = $1 returning id`, [org]);

    const [row] = await db
      .asService()
      .query<{ benchmark_opt_in: boolean }>(
        `select benchmark_opt_in from organisations where id = $1`,
        [org],
      );

    // Opting out has to be as easy as opting in, or the switch is a one-way
    // door and the consent it records is not meaningful.
    expect(row.benchmark_opt_in).toBe(false);
  });
});

describe('membership cannot be self-granted', () => {
  it('refuses a direct insert into the member table', async () => {
    const owner = await db.createUser();
    const attacker = await db.createUser();
    const org = await makeOrg(owner, 'Acme', 'acme');

    // The attack this closes: knowing an organisation id is enough to join it
    // if clients can write to the membership table. Joining goes through the
    // server, which checks a code the client cannot read.
    const message = await db
      .asUser(attacker)
      .denied(
        `insert into organisation_members (org_id, user_id, role) values ($1, $2, 'admin')`,
        [org, attacker],
      );

    expect(message).toMatch(/permission denied|row-level security/i);
  });
});
