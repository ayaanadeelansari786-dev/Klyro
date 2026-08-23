import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { PageFooter, SiteHeader } from '@/components/Chrome';
import { COLORS } from '@/lib/constants';
import { riskColorFor } from '@/lib/scoring';
import { createClientForRequest, getCurrentUser } from '@/lib/supabase/server';

export const metadata: Metadata = {
  title: 'Activity — Klyro',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

interface AssessmentRow {
  id: string;
  domain: string;
  industry: string;
  region: string;
  composite_score: number;
  risk_level: string | null;
  scanned_at: string;
  created_by: string | null;
}

/**
 * Who is in this organisation, and what they have run.
 *
 * A separate page from `/org/[orgId]` on purpose: that page is administration
 * — membership, roles, the join code — and this one is a record of activity.
 * Mixing "manage who can get in" with "see what has been done" made the
 * settings page longer without making either question easier to answer.
 *
 * Open to every member, not gated to admins. `assessments` already grants any
 * member read access to every assessment their organisation owns — `/app`
 * has shown a colleague's scans since the RLS policy was written — so
 * restricting this view to owners would be a page pretending to a boundary
 * the database does not enforce. If that turns out to be the wrong call, it
 * is a one-line change to the query below, not a schema change.
 *
 * `created_by` is looked up against the member roster already fetched for the
 * page, rather than embedded via a second query. `assessments` has two
 * columns referencing `auth.users` — `owner_user_id` and `created_by` — and
 * `profiles.id` references the same table, so asking PostgREST to embed
 * `profiles` through `created_by` is genuinely ambiguous: it has two equally
 * valid columns to embed through and no way to know which one is meant. The
 * roster query has only one such column (`user_id`), so its embed is
 * unambiguous and is reused here instead of adding a second query with the
 * same problem.
 */
export default async function OrgActivityPage({ params }: { params: { orgId: string } }) {
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
    .select('id, name')
    .eq('id', params.orgId)
    .maybeSingle();

  // Not a member, or no such organisation — the same non-answer either way.
  if (!org) notFound();
  const organisation = org as unknown as { id: string; name: string };

  const { data: memberRows } = await supabase
    .from('organisation_members')
    .select('user_id, role, profiles(display_name)')
    .eq('org_id', params.orgId)
    .order('joined_at', { ascending: true });

  const members = (memberRows ?? []).map((row) => {
    const record = row as unknown as {
      user_id: string;
      role: string;
      profiles: { display_name: string | null } | null;
    };
    return {
      userId: record.user_id,
      role: record.role,
      name: record.profiles?.display_name ?? 'Member',
      isYou: record.user_id === user.id,
    };
  });

  const nameByUserId = new Map(members.map((member) => [member.userId, member.name]));

  const { data: assessmentRows } = await supabase
    .from('assessments')
    .select('id, domain, industry, region, composite_score, risk_level, scanned_at, created_by')
    .eq('owner_org_id', params.orgId)
    .order('scanned_at', { ascending: false })
    .limit(200);

  const assessments = (assessmentRows ?? []) as AssessmentRow[];

  const scanCounts = new Map<string, number>();
  for (const assessment of assessments) {
    if (!assessment.created_by) continue;
    scanCounts.set(assessment.created_by, (scanCounts.get(assessment.created_by) ?? 0) + 1);
  }

  return (
    <main className="mx-auto w-full max-w-[1180px] px-5 py-6 sm:px-8 sm:py-8">
      <SiteHeader>
        <nav className="flex items-center gap-6">
          <Link
            href={`/org/${organisation.id}`}
            className="text-[12.5px] text-tx-2 transition-colors hover:text-tx"
          >
            Organisation settings
          </Link>
          <Link href="/app" className="text-[12.5px] text-tx-2 transition-colors hover:text-tx">
            Your assessments
          </Link>
        </nav>
      </SiteHeader>

      <div className="py-12 lg:py-16">
        <p className="micro">Activity</p>
        <h1 className="wide mt-4 text-[34px] font-semibold leading-none tracking-[-0.03em] text-tx sm:text-[44px]">
          {organisation.name}
        </h1>
        <p className="mt-5 text-[13px] text-tx-2">
          {members.length} member{members.length === 1 ? '' : 's'} · {assessments.length} assessment
          {assessments.length === 1 ? '' : 's'} filed
        </p>
      </div>

      {/* Roster, with each member's share of the organisation's scanning. */}
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
              <span className="w-[92px] shrink-0 text-right font-mono text-[12px] tabular-nums text-tx-3">
                {scanCounts.get(member.userId) ?? 0} scan
                {(scanCounts.get(member.userId) ?? 0) === 1 ? '' : 's'}
              </span>
            </li>
          ))}
        </ul>
      </section>

      {/* Every assessment filed under this organisation, newest first, with
          who ran it — the thing the members panel above cannot show on its
          own. */}
      <section className="panel mt-6 overflow-hidden">
        <p className="micro px-6 py-4">
          All assessments
          <span className="ml-2 font-mono text-tx-3">{assessments.length}</span>
        </p>

        {assessments.length === 0 ? (
          <p className="border-t border-line px-6 py-10 text-center text-[13px] text-tx-2">
            No assessments have been filed under this organisation yet. Run one and choose this
            organisation to save it here.
          </p>
        ) : (
          <ul className="border-t border-line">
            {assessments.map((assessment) => {
              const accent = COLORS[riskColorFor(assessment.composite_score)];
              // Not every stored assessment has a surviving creator — the
              // column is `on delete set null`, so someone who has since left
              // or deleted their account leaves their scans in place, unnamed
              // rather than silently reassigned to whoever reads this next.
              const ranBy = assessment.created_by
                ? (nameByUserId.get(assessment.created_by) ?? 'a former member')
                : 'a former member';

              return (
                <li
                  key={assessment.id}
                  className="ledger-row flex flex-wrap items-center gap-x-6 gap-y-2 px-6 py-4"
                >
                  <span
                    className="num w-12 shrink-0 text-[22px] font-semibold leading-none"
                    style={{ color: accent }}
                  >
                    {assessment.composite_score}
                  </span>

                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13.5px] font-medium text-tx">{assessment.domain}</p>
                    <p className="mt-1 text-[11.5px] text-tx-3">
                      {new Date(assessment.scanned_at).toLocaleString('en-GB', {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                      })}
                      {' · '}
                      by {ranBy}
                    </p>
                  </div>

                  <span className="chip shrink-0">{assessment.industry}</span>
                  <span className="chip shrink-0">{assessment.region}</span>

                  <Link
                    href={`/compare?domain=${encodeURIComponent(assessment.domain)}`}
                    className="btn-ghost shrink-0 px-3 py-1.5 text-[12px]"
                  >
                    Compare
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <PageFooter>
        Every member of this organisation can see every assessment filed under it, and who ran it —
        the same visibility /app already gives an individual reader, gathered here per organisation.
        Nothing here is visible outside the organisation.
      </PageFooter>
    </main>
  );
}
