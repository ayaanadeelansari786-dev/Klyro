import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The service-role key must never reach the browser.
 *
 * It bypasses row level security completely: every user's assessments, every
 * organisation's portfolio, every join code hash. There is no recovery from
 * shipping it — anyone who loaded the page once keeps it until it is rotated,
 * and they will not announce that they have it.
 *
 * The way this happens is never malice. It is a refactor: somebody moves a
 * helper into a module that a client component also imports, and the key goes
 * with it. Three independent guards exist for that reason, and this file
 * checks the two that can be checked statically.
 *
 *   1. `import 'server-only'` at the top of `supabase/service.ts`, which turns
 *      a client import into a build error.
 *   2. The variable has no `NEXT_PUBLIC_` prefix, which is the only thing that
 *      makes Next.js inline a value into a client bundle.
 *   3. This test, which fails in review rather than at build time and says why.
 */

const SRC = join(process.cwd(), 'src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(path) ? [path] : [];
  });
}

const files = sourceFiles(SRC).map((path) => ({
  path,
  relative: path.slice(SRC.length + 1).replace(/\\/g, '/'),
  source: readFileSync(path, 'utf8'),
}));

const clientComponents = files.filter(({ source }) =>
  /^\s*['"]use client['"]/m.test(source),
);

describe('the service-role key', () => {
  it('is only ever read in one module', () => {
    const readers = files
      .filter(({ source }) => source.includes('SUPABASE_SERVICE_ROLE_KEY'))
      .map(({ relative }) => relative);

    // One place to audit, and one place for `server-only` to protect.
    expect(readers).toEqual(['lib/supabase/service.ts']);
  });

  it('lives behind a server-only import', () => {
    const service = files.find((f) => f.relative === 'lib/supabase/service.ts');
    expect(service).toBeDefined();

    // Must be the first statement: `server-only` throws when evaluated in a
    // client bundle, and anything above it could run first.
    expect(service!.source.trimStart().startsWith("import 'server-only'")).toBe(true);
  });

  it('is never given a NEXT_PUBLIC_ name', () => {
    // That prefix is the whole mechanism by which Next.js inlines a value into
    // the browser bundle. A service key with it would ship on the next build.
    for (const { relative, source } of files) {
      expect(source, `${relative} must not expose a service key publicly`).not.toMatch(
        /NEXT_PUBLIC_[A-Z_]*SERVICE/,
      );
    }
  });
});

describe('client components', () => {
  it('exist, so this suite is testing something', () => {
    expect(clientComponents.length).toBeGreaterThan(5);
  });

  it('never import the service client', () => {
    const offenders = clientComponents
      .filter(({ source }) => /supabase\/service/.test(source))
      .map(({ relative }) => relative);

    expect(offenders, 'a client component importing the service client ships the key').toEqual([]);
  });

  it('never import the privileged organisation helpers', () => {
    // `lib/auth/organisations` is server-only too: it mints join codes and
    // writes membership rows with the service role.
    const offenders = clientComponents
      .filter(({ source }) => /auth\/organisations|dataset\/assessments|dataset\/store/.test(source))
      .map(({ relative }) => relative);

    expect(offenders).toEqual([]);
  });

  it('reach the database only through the browser client', () => {
    const offenders = clientComponents
      .filter(({ source }) => /createClientForRequest|createPublicClient/.test(source))
      .map(({ relative }) => relative);

    // Not a key-leak risk — both are anonymous — but a client component
    // querying directly bypasses the rate limiting and shaping the API routes
    // carry, and gives the rules two places to drift apart.
    expect(offenders).toEqual([]);
  });
});

describe('the join code pepper', () => {
  it('is read in one module and never bundled', () => {
    const readers = files
      .filter(({ source }) => source.includes('KLYRO_JOIN_CODE_PEPPER'))
      .map(({ relative }) => relative);

    expect(readers).toEqual(['lib/auth/joinCode.ts']);

    for (const { relative, source } of files) {
      expect(source, `${relative} must not expose the pepper publicly`).not.toMatch(
        /NEXT_PUBLIC_[A-Z_]*PEPPER/,
      );
    }
  });
});

describe('privileged reads state their scope', () => {
  it('keeps the public client away from the assessments table', () => {
    // `createPublicClient` runs as `anon`, which has no policy on
    // `assessments` — so a query would return nothing rather than leak. The
    // real risk is the reverse: someone "fixing" the empty result by reaching
    // for the service client instead. Keeping the two apart at the file level
    // makes that a visible change rather than a one-word one.
    const publicReaders = files.filter(
      ({ source }) => source.includes('createPublicClient') && /from\(['"]assessments['"]\)/.test(source),
    );

    expect(publicReaders.map((f) => f.relative)).toEqual([]);
  });
});
