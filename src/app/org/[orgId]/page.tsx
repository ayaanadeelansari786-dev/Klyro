import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import BenchmarkOptIn from '@/components/BenchmarkOptIn';
import { PageFooter, SiteHeader } from '@/components/Chrome';
import JoinCodePanel from '@/components/JoinCodePanel';
import { roleAtLeast, type OrgRole } from '@/lib/auth/context';
import { createClientForRequest, getCurrentUser } from '@/lib/supabase/server';

export const metadata: Metadata = {
  title: 'Organisation — Klyro',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

/**
 * One organisation: members, roles, and the join code.
 *
 * Every query here runs as the caller. A non-member reaches `notFound()` not
 * because this page checks membership but because the organisation row does
 * not come back — the same reason an outsider gets nothing from the API. That
 * distinction matters: if the guard were an `if` in this file, the data would
 * still be readable by any other path that forgot to write the same `if`.
 */
export default async function OrgPage({ params }: { params: { orgId: string } }) {
  const user = await getCurrentUser();
  const supabase = createClientForRequest();

  if (!user || !supabase) {
    return (
      <main className="mx-auto w-full max-w-[1180px] px-5 py-16 sm:px-8">
        <SiteHeader />
        <p className="mt-10 text-[13.5px] text-tx-2">
          <Link href="/login" className="text-tx underline decoration-line-strong underline-offset-4">
            Sign in
          </Link>{' '}
          to view this organisation.
        </p>
      </main>
    );
  }

  const { data: org } = await supabase
    .from('organisations')
    .select('id, name, slug, created_at, benchmark_opt_in')
    .eq('id', params.orgId)
    .maybeSingle();

  // Not a member, or no such organisation. The reader is told the same thing
  // either way — distinguishing them confirms the organisation exists.
  if (!org) notFound();

  const organisation = org as unknown as {
    id: string;
    name: string;
    slug: string;
    benchmark_opt_in: boolean;
  };

  const { data: memberRows } = await supabase
    .from('organisation_members')
    .select('user_id, role, joined_at, profiles(display_name)')
    .eq('org_id', params.orgId)
    .order('joined_at', { ascending: true });

  const members = (memberRows ?? []).map((row) => {
    const record = row as unknown as {
      user_id: string;
      role: OrgRole;
      joined_at: string;
      profiles: { display_name: string | null } | null;
    };
    return {
      userId: record.user_id,
      role: record.role,
      joinedAt: record.joined_at,
      name: record.profiles?.display_name ?? 'Member',
      isYou: record.user_id === user.id,
    };
  });

  const myRole = members.find((member) => member.isYou)?.role ?? null;
  const canManage = roleAtLeast(myRole, 'admin');

  // Only administrators can read this table at all, and the hash column is
  // revoked from every client role — so this returns the hint or nothing.
  const { data: codeRows } = canManage
    ? await supabase
        .from('organisation_join_codes')
        .select('code_hint, expires_at, revoked_at, max_uses, use_count')
        .eq('org_id', params.orgId)
        .is('revoked_at', null)
        .order('created_at', { ascending: false })
        .limit(1)
    : { data: null };

  const liveCode = (codeRows ?? [])[0] as
    | { code_hint: string; expires_at: string | null; max_uses: number | null; use_count: number }
    | undefined;

  const liveHint =
    liveCode &&
    (!liveCode.expires_at || Date.parse(liveCode.expires_at) > Date.now()) &&
    (liveCode.max_uses === null || liveCode.use_count < liveCode.max_uses)
      ? liveCode.code_hint
      : null;

  const { count: assessmentCount } = await supabase
    .from('assessments')
    .select('id', { count: 'exact', head: true })
    .eq('owner_org_id', params.orgId);

  return (
    <main className="mx-auto w-full max-w-[1180px] px-5 py-6 sm:px-8 sm:py-8">
      <SiteHeader>
        <nav className="flex items-center gap-6">
          <Link href="/org" className="text-[12.5px] text-tx-2 transition-colors hover:text-tx">
            All organisations
          </Link>
          <Link
            href={`/org/${organisation.id}/activity`}
            className="text-[12.5px] text-tx-2 transition-colors hover:text-tx"
          >
            Activity
          </Link>
          <Link href="/app" className="text-[12.5px] text-tx-2 transition-colors hover:text-tx">
            Your assessments
          </Link>
        </nav>
      </SiteHeader>

      <div className="py-12 lg:py-16">
        <p className="micro">Organisation</p>
        <h1 className="wide mt-4 text-[34px] font-semibold leading-none tracking-[-0.03em] text-tx sm:text-[44px]">
          {organisation.name}
        </h1>
        <p className="mt-5 text-[13px] text-tx-2">
          {members.length} member{members.length === 1 ? '' : 's'} · {assessmentCount ?? 0} saved
          assessment{assessmentCount === 1 ? '' : 's'} · you are {myRole ?? 'not a member'}
        </p>
      </div>

      <div className="grid gap-5 lg:grid-cols-[1.1fr_1fr]">
        <section className="panel overflow-hidden">
          <p className="micro px-6 py-4">Members</p>
          <ul className="border-t border-line">
            {members.map((member) => (
              <li key={member.userId} className="ledger-row flex items-center gap-4 px-6 py-3.5">
                <span className="flex-1 truncate text-[13.5px] text-tx">
                  {member.name}
                  {member.isYou && <span className="ml-2 text-[11.5px] text-tx-3">you</span>}
                </span>
                <span className="chip">{member.role}</span>
              </li>
            ))}
          </ul>
          <p className="border-t border-line px-6 py-4 text-[11.5px] leading-relaxed text-tx-3">
            Viewers read. Analysts also run assessments for the organisation. Administrators manage
            members and the join code. Owners can additionally delete the organisation, and an
            organisation always keeps at least one.
          </p>
        </section>

        <div className="flex flex-col gap-5">
          <JoinCodePanel orgId={organisation.id} canManage={canManage} liveCodeHint={liveHint} />
          <BenchmarkOptIn
            orgId={organisation.id}
            optedIn={organisation.benchmark_opt_in === true}
            canManage={canManage}
          />
        </div>
      </div>

      <PageFooter>
        Assessments filed under this organisation are readable by its members only. The restriction
        is enforced per query by the database, not by this page.
      </PageFooter>
    </main>
  );
}
