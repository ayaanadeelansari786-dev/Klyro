import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { isActive, NAV_ITEMS, PUBLIC_NAV_ITEMS } from '@/components/navItems';

/**
 * The navigation, pinned.
 *
 * Every one of these rules was broken at some point and none of them broke
 * loudly. Four pages each grew their own `<nav>` with a different subset of
 * links, naming the same destination three different ways. The account
 * control refetched the session on every navigation because the header was
 * rendered per page rather than by a layout, so the reader's own name blinked
 * out and back on every click — nothing failed, it was just visibly slow at
 * something it should not have been doing at all.
 *
 * A test that asserts on rendered output would not have caught either. These
 * assert on structure instead: where the navigation is defined, where the
 * session is resolved, and that no page has started composing its own bar
 * again.
 */

const ROOT = process.cwd();
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), 'utf8');

/**
 * Source with comments removed.
 *
 * Necessary because the comments in these files describe the navigation they
 * used to contain — a bar this very test exists to keep out. Matching the raw
 * text finds the explanation and reports the file as an offender, which is
 * the same mistake as asserting a module does not use a service client by
 * grepping for the word "service" in its header.
 */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

/** Every `page.tsx` under `src/app`, recursively. */
function pageFiles(dir = join(ROOT, 'src', 'app'), found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) pageFiles(path, found);
    else if (entry === 'page.tsx') found.push(path);
  }
  return found;
}

describe('one navigation, defined once', () => {
  it('no page composes its own navigation bar', () => {
    // Includes the landing page, which kept a one-item bar linking to the
    // benchmark dataset long after the rest were consolidated — and so was
    // the only page in the product from which that dataset was reachable.
    // The failure this prevents is not a broken page — each of those
    // hand-rolled bars rendered perfectly. It is four bars disagreeing about
    // what the product's navigation is.
    const offenders = pageFiles()
      .filter((path) => /<nav[\s>]/.test(code(readFileSync(path, 'utf8'))))
      .map((path) => path.slice(ROOT.length + 1));

    expect(offenders).toEqual([]);
  });

  it('the header renders the shared nav and the account control', () => {
    const chrome = read('src', 'components', 'Chrome.tsx');
    expect(chrome).toMatch(/<MainNav \/>/);
    expect(chrome).toMatch(/<AccountMenu \/>/);
  });

  it('the account menu and the header bar read the same list', () => {
    // Two copies of a navigation is how one of them ends up missing a link.
    for (const file of ['MainNav.tsx', 'AccountMenu.tsx']) {
      expect(read('src', 'components', file)).toMatch(/from '@\/components\/navItems'/);
    }
  });

  it('offers a signed-out reader nothing that requires an account', () => {
    // "Organisations" shown to a visitor who cannot have one is a door onto a
    // page whose only content is an instruction to sign in.
    const hrefs = PUBLIC_NAV_ITEMS.map((entry) => entry.href);
    expect(hrefs).not.toContain('/app');
    expect(hrefs).not.toContain('/org');
  });
});

describe('current-page marking', () => {
  it('marks an exact match', () => {
    expect(isActive('/', { href: '/', label: 'New assessment' })).toBe(true);
    expect(isActive('/app', { href: '/', label: 'New assessment' })).toBe(false);
  });

  it('marks a section from any page inside it', () => {
    // `/org/abc/activity` is still "Organisations". Without this the tab bar
    // says where you are within the section and the header says nowhere.
    const org = NAV_ITEMS.find((entry) => entry.href === '/org')!;
    expect(isActive('/org', org)).toBe(true);
    expect(isActive('/org/abc', org)).toBe(true);
    expect(isActive('/org/abc/activity', org)).toBe(true);
  });

  it('does not mark a section for a path that merely starts with its name', () => {
    // `/organisms` is not inside `/org`, and a naive `startsWith` says it is.
    const org = NAV_ITEMS.find((entry) => entry.href === '/org')!;
    expect(isActive('/organisms', org)).toBe(false);
  });

  it('never marks the home link for every page in the app', () => {
    const home = NAV_ITEMS.find((entry) => entry.href === '/')!;
    expect(home.prefix).toBeFalsy();
    expect(isActive('/app', home)).toBe(false);
  });
});

describe('the session is resolved once, not once per navigation', () => {
  it('lives in the root layout', () => {
    // This placement *is* the fix. A layout is not re-rendered when the page
    // beneath it changes; a per-page header is remounted on every click, and
    // that is why the account control used to re-ask who was signed in each
    // time.
    expect(read('src', 'app', 'layout.tsx')).toMatch(/<SessionProvider>/);
  });

  it('is the only place that asks who is signed in', () => {
    // Each extra caller is another auth round trip and another subscription,
    // and — because these components mount with the page — another one on
    // every navigation.
    // Asserted against the *imports*, not the text. These files explain in
    // their own comments what they used to call, and an assertion on the
    // prose matches the explanation rather than the code — a mistake made
    // once already in this repo's history. Without the browser client, none
    // of them can ask.
    const callers = ['AccountMenu.tsx', 'useMemberships.ts', 'MainNav.tsx'];
    for (const file of callers) {
      const source = read('src', 'components', file);
      expect(source, file).not.toMatch(/^import .*supabase\/browser/m);
      expect(source, file).not.toMatch(/await import\('@\/lib\/supabase/);
      expect(source, file).toMatch(/useSession/);
    }
  });

  it('keeps the auth client out of every first-load bundle', () => {
    // The provider wraps the landing page, which is the one statically
    // prerendered route in the app. A static import here would put the
    // Supabase client into its first-load JS — measured at roughly seventy
    // kilobytes when this was last got wrong.
    const provider = read('src', 'components', 'SessionProvider.tsx');
    expect(provider).toMatch(/await import\('@\/lib\/supabase\/browser'\)/);
    expect(provider).not.toMatch(/^import .*supabase\/browser/m);
  });
});

describe('a reader is never stranded', () => {
  it('gives the report and rankings views a route back', () => {
    // Both carry their own compact header instead of `SiteHeader`, and both
    // used to offer the wordmark and nothing else. The account menu carries
    // the primary navigation, which is what makes one control enough.
    for (const file of ['ResultsView.tsx', 'RankingsView.tsx']) {
      expect(read('src', 'components', file), file).toMatch(/<AccountMenu \/>/);
    }
  });

  it('shows something immediately on the slow routes', () => {
    // `/app` and `/org` are force-dynamic and read two or three tables before
    // they can render. Without a loading state a click does nothing visible
    // until the whole response lands, which reads as the app being broken.
    for (const route of ['app', 'org']) {
      expect(read('src', 'app', route, 'loading.tsx')).toMatch(/PageLoading/);
    }
  });
});

/**
 * Roles, and the two ways the database says no.
 *
 * The roles existed in the schema from the start with no way to assign one,
 * so everybody who joined by code arrived a viewer and stayed one — which
 * silently disabled saving a scan to the organisation, because the scan
 * form only offers organisations the reader may write to. Two separate
 * gaps, one cause.
 */
describe('member roles', () => {
  const route = read('src', 'app', 'api', 'org', '[orgId]', 'members', 'route.ts');
  const roster = read('src', 'components', 'MemberRoster.tsx');
  const form = read('src', 'components', 'ScanForm.tsx');

  it('leaves who-may-change-whom to the policy', () => {
    // `app.has_org_role(org_id, 'admin') and (role <> 'owner' or
    // app.has_org_role(org_id, 'owner'))`, in both USING and WITH CHECK. A
    // TypeScript copy of that is free to drift from it.
    expect(code(route)).not.toMatch(/roleAtLeast|roleInOrg/);
  });

  it('handles both shapes of refusal', () => {
    // Verified against the live database: an admin demoting an owner is
    // filtered by USING and returns zero rows, while an admin promoting
    // anyone to owner passes USING and is *raised* by WITH CHECK as 42501.
    // Handling only the first reports the second as an unexplained failure.
    expect(route).toContain('42501');
    expect(route).toMatch(/data\.length === 0/);
  });

  it('passes the last-owner trigger message through rather than replacing it', () => {
    // `app.assert_owner_remains` raises 23514 with prose that names the fix.
    expect(route).toContain('23514');
    expect(route).toMatch(/error\.message/);
  });

  it('tells a viewer why they cannot save to their organisation', () => {
    // The control being absent read as the feature being broken. It is a
    // permission, and saying so is the whole fix.
    expect(form).toMatch(/readOnlyOrgs/);
    expect(form).toMatch(/starts\s*\n?\s*at analyst|saving to an organisation starts/);
  });

  it('says which rank saving starts at, not just the role names', () => {
    // "Analyst" does not tell anyone it is the rank at which saving to the
    // organisation begins working, and that is the fact a person choosing a
    // role most needs.
    expect(roster).toMatch(/Analysts/);
    expect(roster).toMatch(/save an assessment to it/);
  });
});
