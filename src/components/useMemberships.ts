'use client';

import { useEffect, useState } from 'react';

import { roleAtLeast, type OrgRole } from '@/lib/auth/context';

/**
 * The organisations the signed-in reader belongs to, read in the browser.
 *
 * There is no ownership filter in the query and that is deliberate, for the
 * same reason `recentAssessments` has none: row level security on
 * `organisation_members` returns only the caller's own memberships, so a row
 * coming back is itself the proof of membership. Filtering here as well would
 * imply the application is what enforces it, and invite someone to relax the
 * policy later on the strength of a `.eq()` in a React hook.
 *
 * Nothing security-critical rests on this either way. It decides which
 * options a dropdown offers; `resolveOwner` re-checks the membership
 * server-side before any scan is filed anywhere, and a forged id in the URL
 * gets the scan saved personally with a notice rather than accepted.
 *
 * The Supabase client is imported inside the effect rather than at the top of
 * the module, and that is a bundle decision rather than a stylistic one. This
 * hook is used by `ScanForm`, which the landing page renders; a static import
 * put the auth client into the first-load bundle of the one page the whole
 * product is entered through. Signed-out visitors — most of them, on that
 * page — never need it at all, and the ones who do are not waiting on a
 * dropdown before they can type a domain.
 */

export interface Membership {
  id: string;
  name: string;
  role: OrgRole;
  /** True when this member may add assessments, not merely read them. */
  canFile: boolean;
}

interface MemberRow {
  role: OrgRole;
  organisations: { id: string; name: string } | { id: string; name: string }[] | null;
}

export function useMemberships(): { memberships: Membership[]; loading: boolean } {
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    let unsubscribe: (() => void) | undefined;

    (async () => {
      const { getBrowserClient } = await import('@/lib/supabase/browser');
      const supabase = getBrowserClient();

      if (!live) return;
      if (!supabase) {
        setLoading(false);
        return;
      }

      const load = async () => {
        const { data } = await supabase
          .from('organisation_members')
          .select('role, organisations(id, name)');

        if (!live) return;

        const rows = (data ?? []) as unknown as MemberRow[];
        setMemberships(
          rows
            .map((row) => {
              // PostgREST returns an embedded one-to-one as an object, but
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
        setLoading(false);
      };

      await load();

      // Signing in or out changes the answer completely, and a stale org list
      // is a dropdown offering to file a stranger's scan under your
      // organisation.
      const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
        if (!live) return;
        if (!session) {
          setMemberships([]);
          setLoading(false);
          return;
        }
        void load();
      });
      unsubscribe = () => sub.subscription.unsubscribe();
    })();

    return () => {
      live = false;
      unsubscribe?.();
    };
  }, []);

  return { memberships, loading };
}
