/**
 * A real Postgres, in process, running Klyro's real migrations.
 *
 * Row level security cannot be tested against a mock. A stubbed client that
 * returns `[]` for "another user's rows" proves only that the stub was written
 * to return `[]`; the policy it is standing in for could be missing entirely.
 * So these tests run the actual `.sql` files from `supabase/migrations/`
 * against PGlite — Postgres 18 compiled to WebAssembly — and let Postgres
 * enforce the policies.
 *
 * What this harness has to get right is the *environment* those policies run
 * in, because Supabase supplies a lot of it implicitly:
 *
 * 1. `auth.uid()` and `auth.users`, which every policy is written against.
 * 2. The `anon`, `authenticated` and `service_role` roles.
 * 3. Default privileges. This one matters more than it looks: Supabase grants
 *    `anon` and `authenticated` full table privileges by default and relies on
 *    RLS alone to hold the line. If the harness omitted those grants, every
 *    unauthorised query would fail with "permission denied" and the suite
 *    would go green while proving nothing about the policies. The grants are
 *    applied before the migrations run so the tests fail the same way
 *    production would.
 *
 * What it deliberately does not reproduce: JWT verification, the GoTrue
 * signup/login flow, and PostgREST. Those are Supabase's code, not Klyro's.
 * What is under test here is the schema and its policies.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { PGlite } from '@electric-sql/pglite';

const MIGRATIONS_DIR = join(process.cwd(), 'supabase', 'migrations');

/**
 * The parts of Supabase a policy depends on, recreated exactly enough.
 *
 * `auth.uid()` reads the request's JWT claim the same way Supabase's does,
 * supporting both the `request.jwt.claim.sub` and `request.jwt.claims` forms,
 * so policies copied from Supabase documentation behave identically here.
 */
const BOOTSTRAP = `
  create schema if not exists auth;

  -- Shaped to match the columns Klyro's migrations actually touch. The
  -- metadata column matters: Supabase stores whatever signUp() was given
  -- there, and the profile trigger in 0003 reads it.
  create table if not exists auth.users (
    id                  uuid primary key default gen_random_uuid(),
    email               text unique,
    raw_user_meta_data  jsonb not null default '{}'::jsonb,
    created_at          timestamptz not null default now()
  );

  create or replace function auth.uid() returns uuid
    language sql stable
  as $$
    select coalesce(
      nullif(current_setting('request.jwt.claim.sub', true), ''),
      nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
    )::uuid
  $$;

  create or replace function auth.role() returns text
    language sql stable
  as $$
    select coalesce(
      nullif(current_setting('request.jwt.claim.role', true), ''),
      nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
      current_user
    )
  $$;

  do $$ begin
    create role anon nologin;
  exception when duplicate_object then null; end $$;

  do $$ begin
    create role authenticated nologin;
  exception when duplicate_object then null; end $$;

  -- bypassrls is the whole point of the service role: privileged server-side
  -- work is allowed through, and it is the only thing that is.
  do $$ begin
    create role service_role nologin bypassrls;
  exception when duplicate_object then null; end $$;

  grant usage on schema public to anon, authenticated, service_role;
  grant usage on schema auth   to anon, authenticated, service_role;
  grant select on auth.users   to authenticated, service_role;

  -- Supabase's defaults. See the note above: without these the suite would
  -- pass for the wrong reason.
  alter default privileges in schema public
    grant all on tables    to anon, authenticated, service_role;
  alter default privileges in schema public
    grant all on sequences to anon, authenticated, service_role;
  alter default privileges in schema public
    grant execute on functions to anon, authenticated, service_role;
`;

export type Row = Record<string, unknown>;

/** A handle that runs every statement as one particular caller. */
export interface As {
  /** Runs a statement in its own transaction, as this caller. */
  query<T = Row>(sql: string, params?: unknown[]): Promise<T[]>;
  /**
   * Runs a statement expecting Postgres to refuse it, and returns the message.
   * Fails loudly if the statement is *allowed* — a refusal test that silently
   * passes when the operation succeeds is worse than no test.
   *
   * Correct for INSERT, and for UPDATE where the *new* row fails a WITH CHECK.
   * Not correct for UPDATE or DELETE blocked by a USING clause — see
   * `affectsNothing` below.
   */
  denied(sql: string, params?: unknown[]): Promise<string>;
  /**
   * Runs an UPDATE or DELETE expecting it to touch no rows, and fails if it
   * touches any.
   *
   * Row level security filters rather than refuses. An UPDATE whose USING
   * clause excludes every candidate row is not an error — it is a successful
   * statement that changed nothing, and Postgres reports no problem with it.
   * So "an admin cannot demote the owner" cannot be tested by expecting an
   * exception; the owner's row is simply not visible to that UPDATE, and the
   * statement succeeds having done nothing.
   *
   * The distinction is easy to get backwards, and getting it backwards in the
   * lenient direction produces a test that passes whether or not the policy
   * exists. This helper requires the caller to add RETURNING so the count of
   * affected rows is observable.
   */
  affectsNothing(sql: string, params?: unknown[]): Promise<void>;
}

export interface TestDb {
  raw: PGlite;
  /** A signed-in user with this id. */
  asUser(userId: string): As;
  /** A visitor with no session. */
  asAnon(): As;
  /** Server-side privileged access. Bypasses RLS, as in production. */
  asService(): As;
  /** Creates an `auth.users` row and returns its id. */
  createUser(email?: string, displayName?: string): Promise<string>;
  close(): Promise<void>;
}

export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

/**
 * Spins up a database with every migration applied, in order.
 *
 * `upTo` stops after a given migration, which is what lets a test assert that
 * a specific migration is the thing that changed a behaviour rather than
 * asserting against the end state and hoping.
 */
export async function createTestDb(options: { upTo?: string } = {}): Promise<TestDb> {
  const db = new PGlite();
  await db.exec(BOOTSTRAP);

  for (const file of migrationFiles()) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    try {
      await db.exec(sql);
    } catch (error) {
      throw new Error(`migration ${file} failed: ${(error as Error).message}`);
    }
    if (options.upTo && file.startsWith(options.upTo)) break;
  }

  /*
   * Every statement gets its own transaction.
   *
   * `set local role` and the JWT claim are transaction-scoped, so this is what
   * stops one test's identity leaking into the next. It also means a refused
   * statement aborts only its own transaction — a shared one would poison
   * every following statement with "current transaction is aborted", and the
   * refusal tests would then pass for a reason unrelated to the policy.
   */
  function scope(role: string, userId?: string): As {
    async function run<T>(sql: string, params?: unknown[]): Promise<T[]> {
      await db.exec('begin');
      try {
        await db.exec(`set local role ${role}`);
        if (userId) {
          await db.query(`select set_config('request.jwt.claim.sub', $1, true)`, [userId]);
          await db.query(`select set_config('request.jwt.claim.role', $1, true)`, [role]);
        }
        const result = await db.query(sql, params);
        await db.exec('commit');
        return result.rows as T[];
      } catch (error) {
        await db.exec('rollback');
        throw error;
      }
    }

    const who = `role ${role}${userId ? ` (user ${userId})` : ''}`;

    return {
      query: run,
      async denied(sql, params) {
        try {
          await run(sql, params);
        } catch (error) {
          return (error as Error).message;
        }
        throw new Error(
          `Expected Postgres to refuse this statement for ${who}, but it succeeded:\n  ${sql.trim()}`,
        );
      },
      async affectsNothing(sql, params) {
        if (!/returning/i.test(sql)) {
          throw new Error(
            'affectsNothing() needs a RETURNING clause; without one the number of ' +
              `affected rows is not observable and the assertion would be vacuous:\n  ${sql.trim()}`,
          );
        }

        let rows: Row[];
        try {
          rows = await run<Row>(sql, params);
        } catch {
          // Refused outright rather than filtered. Also a pass: the row was
          // not modified, which is the property under test.
          return;
        }

        if (rows.length > 0) {
          throw new Error(
            `Expected this statement to affect no rows for ${who}, but it changed ` +
              `${rows.length}:\n  ${sql.trim()}\n  ${JSON.stringify(rows)}`,
          );
        }
      },
    };
  }

  return {
    raw: db,
    asUser: (userId: string) => scope('authenticated', userId),
    asAnon: () => scope('anon'),
    asService: () => scope('service_role'),
    async createUser(email?: string, displayName?: string) {
      const address = email ?? `user-${Math.random().toString(36).slice(2, 10)}@example.test`;
      const rows = await db.query<{ id: string }>(
        `insert into auth.users (email, raw_user_meta_data)
         values ($1, $2::jsonb) returning id`,
        [address, JSON.stringify(displayName ? { display_name: displayName } : {})],
      );
      return rows.rows[0].id;
    },
    close: () => db.close(),
  };
}
