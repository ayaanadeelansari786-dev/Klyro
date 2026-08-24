'use client';

import { useSession, type Membership } from '@/components/SessionProvider';

/**
 * The organisations the signed-in reader belongs to.
 *
 * Now a two-line read from `SessionProvider` rather than its own fetch. It
 * used to open a Supabase client and query `organisation_members` in its own
 * effect, which was fine when one component used it and wrong the moment the
 * account menu was doing the same work a few pixels away: two clients, two
 * auth subscriptions, and the membership list re-fetched on every navigation
 * because `ScanForm` remounts with the page. The scan form's organisation
 * dropdown visibly repopulated each time.
 *
 * Kept as a named hook rather than having callers reach for `useSession`
 * directly. `ScanForm` wants "which organisations can I file under", not
 * "what is the session"; the narrower name is the one worth importing, and it
 * leaves room to add the filtering that question may eventually need.
 */
export type { Membership };

export function useMemberships(): { memberships: Membership[]; loading: boolean } {
  const { memberships, membershipsLoading } = useSession();
  return { memberships, loading: membershipsLoading };
}
