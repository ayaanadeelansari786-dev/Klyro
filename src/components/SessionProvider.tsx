'use client';

import { createContext, useContext, useEffect, useMemo, useState } from 'react';

import { roleAtLeast, type OrgRole } from '@/lib/auth/context';

/**
 * Who is signed in, resolved once for the whole app.
 *
 * This exists because of a specific and very visible bug: the header was not
 * in a layout. Every page rendered its own `<SiteHeader>`, so every
 * navigation unmounted the account control and mounted a new one, which
 * called `supabase.auth.getUser()` again and re-fetched the reader's
 * organisations again. The name in the corner emptied and refilled on every
 * single page change, and the organisation dropdown on the scan form did the
 * same. Nothing was slow in the sense of taking a long time; the same fast
 * request was simply being made over and over, and each one was visible.
 *
 * Mounted in the root layout, this provider survives client-side navigation
 * — a layout is not re-rendered when the page under it changes — so the
 * answer is fetched once per page *load* rather than once per page *view*.
 * Consumers read it synchronously and render the settled state on their first
 * paint.
 *
 * The Supabase client is imported inside the effect, not at the top of the
 * module. The provider wraps every route including the landing page, which is
 * the one statically prerendered page in the app and the page most people
 * arrive on; a static import here would put the auth client into its
 * first-load bundle. The module itself is a few hundred bytes, the client
 * arrives just after hydration, and no route pays for it up front.
 *
 * Session state stays a browser concern rather than being read server-side,
 * which is the trade the landing page's static render depends on and is
 * documented at more length in `AccountMenu`.
 */

export interface Account {
  id: string;
  email: string;
  displayName: string;
}

export interface Membership {
  id: string;
  name: string;
  role: OrgRole;
  /** True when this member may add assessments, not merely read them. */
  canFile: boolean;
}

interface SessionValue {
  /**
   * `undefined` is "not asked yet", `null` is a settled answer of nobody.
   * Collapsing the two would flash the signed-out header at every signed-in
   * reader on every page load.
   */
  account: Account | null | undefined;
  memberships: Membership[];
  membershipsLoading: boolean;
  /** Null when accounts are not configured for this deployment. */
  signOut: (() => Promise<void>) | null;
}

const SessionContext = createContext<SessionValue>({
  account: null,
  memberships: [],
  membershipsLoading: false,
  signOut: null,
});

export function useSession(): SessionValue {
  return useContext(SessionContext);
}

function accountFrom(
  user: { id?: string; email?: string; user_metadata?: Record<string, unknown> } | null,
): Account | null {
  if (!user?.email || !user.id) return null;

  const raw = user.user_metadata?.display_name;
  const named = typeof raw === 'string' ? raw.trim() : '';

  return {
    id: user.id,
    email: user.email,
    // The local part is a poor name and a good fallback: it is what the person
    // typed, and it beats rendering an empty button.
    displayName: named || user.email.split('@')[0],
  };
}

interface MemberRow {
  role: OrgRole;
  organisations: { id: string; name: string } | { id: string; name: string }[] | null;
}

export default function SessionProvider({ children }: { children: React.ReactNode }) {
  const [account, setAccount] = useState<Account | null | undefined>(undefined);
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [membershipsLoading, setMembershipsLoading] = useState(true);
  const [client, setClient] = useState<{ auth: { signOut: () => Promise<unknown> } } | null>(null);

  useEffect(() => {
    let live = true;
    let unsubscribe: (() => void) | undefined;

    (async () => {
      const { getBrowserClient } = await import('@/lib/supabase/browser');
      const supabase = getBrowserClient();

      if (!live) return;

      // Accounts are not configured for this deployment. Assessments still
      // run; the header simply says nothing about them.
      if (!supabase) {
        setAccount(null);
        setMembershipsLoading(false);
        return;
      }

      setClient(supabase);

      /*
       * Filtered to the caller's own membership row.
       *
       * This query used to have no filter, on the stated reasoning that row
       * level security "returns only the caller's own memberships". That was
       * simply wrong about the policy. `organisation_members` is protected by
       * `app.is_org_member(org_id)`, which scopes rows to organisations you
       * belong to — not to your membership of them. An unfiltered read
       * therefore returns one row per member of every organisation you are
       * in, and each row carries *that member's* role.
       *
       * Two things followed. An organisation with two people appeared twice
       * in every list built from this. And `canFile` was computed from
       * whichever row arrived, so a viewer in an organisation that has an
       * owner picked up `owner` and was offered a "save to organisation"
       * option the server then refused, filing the scan personally with a
       * notice. The permission check was never wrong; the list it was applied
       * to was.
       *
       * The boundary is still the policy. Nothing security-critical rests on
       * this filter — `resolveOwner` re-checks membership server-side, with
       * its own `user_id` test, before any scan is filed anywhere. The filter
       * is what tells a row about me apart from a row about a colleague.
       */
      const loadMemberships = async (userId: string) => {
        const { data } = await supabase
          .from('organisation_members')
          .select('role, organisations(id, name)')
          .eq('user_id', userId);

        if (!live) return;

        const rows = (data ?? []) as unknown as MemberRow[];
        setMemberships(
          rows
            .map((row) => {
              // PostgREST returns an embedded one-to-one as an object but
              // types it as an array often enough that both shapes have to be
              // handled rather than trusted.
              const org = Array.isArray(row.organisations)
                ? row.organisations[0]
                : row.organisations;
              if (!org?.id) return null;
              return {
                id: org.id,
                name: org.name,
                role: row.role,
                canFile: roleAtLeast(row.role, 'analyst'),
              };
            })
            .filter((m): m is Membership => m !== null)
            .sort((a, b) => a.name.localeCompare(b.name)),
        );
        setMembershipsLoading(false);
      };

      const { data } = await supabase.auth.getUser();
      if (!live) return;

      const resolved = accountFrom(data.user);
      setAccount(resolved);

      if (resolved) await loadMemberships(resolved.id);
      else setMembershipsLoading(false);

      /*
       * Subscribed to rather than read once. Signing out in another tab, or a
       * token expiring mid-session, both leave a header claiming somebody is
       * signed in who is not — and the one control that must never be wrong
       * is the one saying whose data you are looking at. A stale organisation
       * list is the same problem one step down: a dropdown offering to file a
       * stranger's scan under your organisation.
       */
      const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
        if (!live) return;
        const next = accountFrom(session?.user ?? null);
        setAccount(next);
        if (next) {
          void loadMemberships(next.id);
        } else {
          setMemberships([]);
          setMembershipsLoading(false);
        }
      });
      unsubscribe = () => sub.subscription.unsubscribe();
    })();

    return () => {
      live = false;
      unsubscribe?.();
    };
  }, []);

  const value = useMemo<SessionValue>(
    () => ({
      account,
      memberships,
      membershipsLoading,
      signOut: client ? () => client.auth.signOut().then(() => undefined) : null,
    }),
    [account, memberships, membershipsLoading, client],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
