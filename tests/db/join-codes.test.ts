import { beforeEach, describe, expect, it } from 'vitest';

import { generateJoinCode, hashJoinCode } from '@/lib/auth/joinCode';

import { createTestDb, type TestDb } from './harness';

/**
 * Joining an organisation by code, at the database level.
 *
 * The join itself is a server-side operation — clients cannot write to
 * `organisation_members`, and cannot read `code_hash` — so what these tests
 * cover is the state the server acts on: that a code stored here cannot be
 * read back, that expiry, revocation and use limits are recorded where the
 * server can see them, and that nothing about a code leaks to the people it
 * was not issued to.
 */

let db: TestDb;

beforeEach(async () => {
  if (db) await db.close();
  db = await createTestDb();
  process.env.KLYRO_JOIN_CODE_PEPPER = 'test-pepper-value-at-least-32-characters-long';
});

async function makeOrg(owner: string, slug = 'acme'): Promise<string> {
  const [row] = await db
    .asService()
    .query<{ id: string }>(
      `insert into organisations (name, slug, created_by) values ('Acme', $1, $2) returning id`,
      [slug, owner],
    );
  return row.id;
}

/** Mints a code the way the server route will. */
async function issueCode(
  org: string,
  by: string,
  options: { expiresAt?: string | null; maxUses?: number | null } = {},
) {
  const generated = generateJoinCode();
  await db
    .asService()
    .query(
      `insert into organisation_join_codes (org_id, code_hash, code_hint, created_by, expires_at, max_uses)
       values ($1, $2, $3, $4, $5, $6)`,
      [org, generated.hash, generated.hint, by, options.expiresAt ?? null, options.maxUses ?? null],
    );
  return generated;
}

/** The lookup the join route performs. */
async function resolveCode(code: string): Promise<{ org_id: string; live: boolean }[]> {
  return db.asService().query<{ org_id: string; live: boolean }>(
    `select org_id, app.join_code_is_live(c.*) as live
     from organisation_join_codes c
     where code_hash = $1`,
    [hashJoinCode(code)],
  );
}

describe('storage', () => {
  it('stores a hash, never the code', async () => {
    const owner = await db.createUser();
    const org = await makeOrg(owner);
    const { code } = await issueCode(org, owner);

    const [row] = await db
      .asService()
      .query<{ code_hash: string; code_hint: string }>(
        `select code_hash, code_hint from organisation_join_codes where org_id = $1`,
        [org],
      );

    const body = code.replace(/[^A-Z0-9]/g, '').replace(/^KLY/, '');
    expect(row.code_hash).not.toContain(body);
    expect(row.code_hash).toBe(hashJoinCode(code));
    // The hint identifies a code without being enough to use one.
    expect(body.endsWith(row.code_hint)).toBe(true);
  });

  it('hides the hash column even from the admins who manage codes', async () => {
    const owner = await db.createUser();
    const org = await makeOrg(owner);
    await issueCode(org, owner);

    // The read policy lets an admin list codes. The column grant is a second,
    // independent control: a hash is an offline verifier, and handing one to
    // the browser means an attacker can test candidate codes at their own
    // hardware's speed rather than at the rate limiter's.
    const message = await db
      .asUser(owner)
      .denied(`select code_hash from organisation_join_codes where org_id = $1`, [org]);

    expect(message).toMatch(/permission denied/i);

    // Everything else about the code is legitimately visible to an admin.
    const rows = await db
      .asUser(owner)
      .query<{ code_hint: string }>(
        `select code_hint from organisation_join_codes where org_id = $1`,
        [org],
      );
    expect(rows).toHaveLength(1);
  });

  it('hides codes from members who are not admins', async () => {
    const owner = await db.createUser();
    const analyst = await db.createUser();
    const org = await makeOrg(owner);
    await db
      .asService()
      .query(`insert into organisation_members (org_id, user_id, role) values ($1, $2, 'analyst')`, [
        org,
        analyst,
      ]);
    await issueCode(org, owner);

    expect(
      await db.asUser(analyst).query(`select id from organisation_join_codes where org_id = $1`, [org]),
    ).toEqual([]);
  });

  it('hides codes from other organisations entirely', async () => {
    const ownerA = await db.createUser();
    const ownerB = await db.createUser();
    const orgA = await makeOrg(ownerA, 'acme');
    await makeOrg(ownerB, 'beta');
    await issueCode(orgA, ownerA);

    expect(
      await db.asUser(ownerB).query(`select id from organisation_join_codes where org_id = $1`, [orgA]),
    ).toEqual([]);
  });

  it('refuses to let any client write a code', async () => {
    const owner = await db.createUser();
    const org = await makeOrg(owner);

    const message = await db
      .asUser(owner)
      .denied(
        `insert into organisation_join_codes (org_id, code_hash, code_hint)
         values ($1, 'forged', 'AAAA')`,
        [org],
      );

    expect(message).toMatch(/permission denied|row-level security/i);
  });
});

describe('validity', () => {
  it('resolves a live code to its organisation', async () => {
    const owner = await db.createUser();
    const org = await makeOrg(owner);
    const { code } = await issueCode(org, owner);

    expect(await resolveCode(code)).toEqual([{ org_id: org, live: true }]);
  });

  it('resolves nothing for a code that was never issued', async () => {
    const owner = await db.createUser();
    await makeOrg(owner);

    expect(await resolveCode(generateJoinCode().code)).toEqual([]);
  });

  it('reports an expired code as not live', async () => {
    const owner = await db.createUser();
    const org = await makeOrg(owner);
    const { code } = await issueCode(org, owner, {
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });

    const [row] = await resolveCode(code);
    expect(row.live).toBe(false);
  });

  it('reports a revoked code as not live', async () => {
    const owner = await db.createUser();
    const org = await makeOrg(owner);
    const { code } = await issueCode(org, owner);

    await db
      .asService()
      .query(`update organisation_join_codes set revoked_at = now() where org_id = $1`, [org]);

    const [row] = await resolveCode(code);
    expect(row.live).toBe(false);
  });

  it('reports a code as not live once its use limit is reached', async () => {
    const owner = await db.createUser();
    const org = await makeOrg(owner);
    const { code } = await issueCode(org, owner, { maxUses: 2 });

    await db
      .asService()
      .query(`update organisation_join_codes set use_count = 1 where org_id = $1`, [org]);
    expect((await resolveCode(code))[0].live).toBe(true);

    await db
      .asService()
      .query(`update organisation_join_codes set use_count = 2 where org_id = $1`, [org]);
    expect((await resolveCode(code))[0].live).toBe(false);
  });

  it('treats an unlimited code as live however often it is used', async () => {
    const owner = await db.createUser();
    const org = await makeOrg(owner);
    const { code } = await issueCode(org, owner, { maxUses: null });

    await db
      .asService()
      .query(`update organisation_join_codes set use_count = 9999 where org_id = $1`, [org]);

    expect((await resolveCode(code))[0].live).toBe(true);
  });
});

describe('rotation', () => {
  it('kills the old code the moment a new one is issued', async () => {
    const owner = await db.createUser();
    const org = await makeOrg(owner);
    const first = await issueCode(org, owner);

    // Rotation is revoke-then-issue: the old code stops working immediately
    // rather than at some expiry, which is the whole reason to rotate.
    await db
      .asService()
      .query(
        `update organisation_join_codes set revoked_at = now()
         where org_id = $1 and revoked_at is null`,
        [org],
      );
    const second = await issueCode(org, owner);

    expect((await resolveCode(first.code))[0].live).toBe(false);
    expect((await resolveCode(second.code))[0].live).toBe(true);
  });

  it('keeps revoked codes on record rather than deleting them', async () => {
    const owner = await db.createUser();
    const org = await makeOrg(owner);
    await issueCode(org, owner);

    await db
      .asService()
      .query(`update organisation_join_codes set revoked_at = now() where org_id = $1`, [org]);
    await issueCode(org, owner);

    // Who issued which code and when is the audit trail for how somebody got
    // into the organisation. Deleting on rotation would erase it.
    const rows = await db
      .asService()
      .query(`select id from organisation_join_codes where org_id = $1`, [org]);
    expect(rows).toHaveLength(2);
  });

  it('refuses two codes hashing to the same value', async () => {
    const ownerA = await db.createUser();
    const ownerB = await db.createUser();
    const orgA = await makeOrg(ownerA, 'acme');
    const orgB = await makeOrg(ownerB, 'beta');
    const { hash, hint } = generateJoinCode();

    await db
      .asService()
      .query(
        `insert into organisation_join_codes (org_id, code_hash, code_hint) values ($1, $2, $3)`,
        [orgA, hash, hint],
      );

    // Unique across the table, not per organisation: one code must resolve to
    // exactly one organisation, or joining becomes ambiguous.
    const message = await db
      .asService()
      .denied(
        `insert into organisation_join_codes (org_id, code_hash, code_hint) values ($1, $2, $3)`,
        [orgB, hash, hint],
      );

    expect(message).toMatch(/duplicate key|unique/i);
  });
});

describe('codes are scoped to their organisation', () => {
  it('never admits the holder to a different organisation', async () => {
    const ownerA = await db.createUser();
    const ownerB = await db.createUser();
    const orgA = await makeOrg(ownerA, 'acme');
    const orgB = await makeOrg(ownerB, 'beta');

    const codeA = await issueCode(orgA, ownerA);
    const [resolved] = await resolveCode(codeA.code);

    expect(resolved.org_id).toBe(orgA);
    expect(resolved.org_id).not.toBe(orgB);
  });
});
