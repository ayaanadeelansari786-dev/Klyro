import type { Metadata } from 'next';
import Link from 'next/link';

import { PageFooter, SiteHeader } from '@/components/Chrome';
import { recentAssessments, assessmentFromRow } from '@/lib/dataset/history';
import { createClientForRequest, getCurrentUser } from '@/lib/supabase/server';
import { isSupabaseConfigured } from '@/lib/supabase';

export const metadata: Metadata = {
  title: 'Your assessments — Klyro',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

/**
 * Saved assessment history.
 *
 * Every row on this page arrived through the caller's own Supabase client, so
 * the list is whatever row level security returned — this component does no
 * filtering of its own and could not usefully do any. A signed-out visitor
 * gets an empty list from the database and an explanation from here.
 */
export default async function AppPage() {
  const user = await getCurrentUser();
  const supabase = createClientForRequest();

  const rows = user && supabase ? await recentAssessments(supabase, { limit: 60 }) : [];
  const assessments = rows.map((row) => ({
    row,
    scan: assessmentFromRow(row),
  }));

  const orgs =
    user && supabase
      ? ((
          await supabase
            .from('organisation_members')
            .select('role, organisations(id, name, slug)')
        ).data ?? [])
      : [];

  /*
   * Which organisation an assessment belongs to, by name.
   *
   * The list above is the union of the reader's own assessments and every
   * organisation's they belong to — `recentAssessments` applies no ownership
   * filter, because the policy on `assessments` has already done it. That
   * makes naming the owner the difference between a useful history and a
   * confusing one: a member of two organisations otherwise cannot tell which
   * of them a colleague's scan was filed under, or which rows are their own.
   */
  const orgNames = new Map<string, string>();
  for (const entry of orgs) {
    const record = entry as unknown as { organisations: { id: string; name: string } | null };
    if (record.organisations) orgNames.set(record.organisations.id, record.organisations.name);
  }

  return (
    <main className="mx-auto w-full max-w-[1180px] px-5 py-6 sm:px-8 sm:py-8">
      <SiteHeader>
        <nav className="flex items-center gap-6">
          <Link href="/" className="text-[12.5px] text-tx-2 transition-colors hover:text-tx">
            New assessment
          </Link>
          <Link href="/org" className="text-[12.5px] text-tx-2 transition-colors hover:text-tx">
            Organisations
          </Link>
        </nav>
      </SiteHeader>

      <div className="py-12 lg:py-16">
        <p className="micro">Saved assessments</p>
        <h1 className="wide mt-4 text-[34px] font-semibold leading-none tracking-[-0.03em] text-tx sm:text-[44px]">
          {user ? 'Your history' : 'Nothing saved yet'}
        </h1>

        {!isSupabaseConfigured && (
          <p className="mt-6 max-w-[60ch] text-[13.5px] leading-relaxed text-tx-2">
            This deployment has no dataset configured, so nothing is stored anywhere. Assessments
            still run in full.
          </p>
        )}

        {isSupabaseConfigured && !user && (
          <p className="mt-6 max-w-[60ch] text-[13.5px] leading-relaxed text-tx-2">
            Assessments run without an account and are not stored — they are streamed to you and
            nothing is kept. To build a history you can compare against later,{' '}
            <Link
              href="/login"
              className="text-tx underline decoration-line-strong underline-offset-4 hover:decoration-tx"
            >
              sign in
            </Link>
            .
          </p>
        )}

        {user && assessments.length === 0 && (
          <p className="mt-6 max-w-[60ch] text-[13.5px] leading-relaxed text-tx-2">
            Nothing here yet. Assessments you run while signed in are saved automatically, and two
            assessments of the same domain can be compared to see what changed. Assessments filed
            under an organisation appear here for every member of it, and a new vendor is ranked
            against the others that organisation has assessed in the same industry.
          </p>
        )}
      </div>

      {assessments.length > 0 && (
        <section className="panel overflow-hidden">
          <div className="flex items-baseline justify-between px-6 py-4">
            <p className="micro">
              {assessments.length} assessment{assessments.length === 1 ? '' : 's'}
            </p>
            <p className="text-[11.5px] text-tx-3">Newest first</p>
          </div>

          <ul className="border-t border-line">
            {assessments.map(({ row, scan }) => (
              <li
                key={row.id}
                className="ledger-row flex flex-wrap items-center gap-x-6 gap-y-2 px-6 py-4"
              >
                <span className="num w-12 shrink-0 text-[22px] font-semibold leading-none text-tx">
                  {scan.compositeScore}
                </span>

                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13.5px] font-medium text-tx">{scan.domain}</p>
                  <p className="mt-1 text-[11.5px] text-tx-3">
                    {new Date(scan.scannedAt).toLocaleString('en-GB', {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    })}
                    {' · '}
                    {Math.round(scan.coverage * 100)}% assessed
                    {' · '}
                    {row.owner_org_id
                      ? (orgNames.get(row.owner_org_id) ?? 'an organisation')
                      : 'only you'}
                  </p>
                </div>

                <span className="chip shrink-0">{scan.riskLevel}</span>

                <Link
                  href={`/compare?domain=${encodeURIComponent(scan.domain)}`}
                  className="btn-ghost shrink-0 px-3 py-1.5 text-[12px]"
                >
                  Compare
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {orgs.length > 0 && (
        <section className="panel mt-8 overflow-hidden">
          <p className="micro px-6 py-4">Your organisations</p>
          <ul className="border-t border-line">
            {orgs.map((entry) => {
              const record = entry as unknown as {
                role: string;
                organisations: { id: string; name: string; slug: string } | null;
              };
              if (!record.organisations) return null;
              return (
                <li key={record.organisations.id} className="ledger-row flex items-center gap-4 px-6 py-3.5">
                  <Link
                    href={`/org/${record.organisations.id}`}
                    className="flex-1 text-[13.5px] text-tx transition-opacity hover:opacity-70"
                  >
                    {record.organisations.name}
                  </Link>
                  <span className="chip">{record.role}</span>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <PageFooter />
    </main>
  );
}
