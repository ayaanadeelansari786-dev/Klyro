import type { Metadata } from 'next';
import Link from 'next/link';

import { PageFooter, SiteHeader } from '@/components/Chrome';
import OrgManager from '@/components/OrgManager';
import { createClientForRequest, getCurrentUser } from '@/lib/supabase/server';

export const metadata: Metadata = {
  title: 'Organisations — Klyro',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

export default async function OrgIndexPage() {
  const user = await getCurrentUser();
  const supabase = createClientForRequest();

  const memberships =
    user && supabase
      ? ((await supabase.from('organisation_members').select('role, organisations(id, name, slug)'))
          .data ?? [])
      : [];

  return (
    <main className="mx-auto w-full max-w-[1180px] px-5 py-6 sm:px-8 sm:py-8">
      <SiteHeader />

      <div className="py-12 lg:py-16">
        <p className="micro">Organisations</p>
        <h1 className="wide mt-4 text-[34px] font-semibold leading-none tracking-[-0.03em] text-tx sm:text-[44px]">
          Share assessments with colleagues
        </h1>
        <p className="mt-6 max-w-[62ch] text-[13.5px] leading-relaxed text-tx-2">
          An organisation is a boundary, not a folder. Assessments filed under one are readable by
          its members and by nobody else — the restriction is enforced by the database on every
          query, not by the pages you happen to reach.
        </p>
      </div>

      {!user ? (
        <p className="text-[13.5px] leading-relaxed text-tx-2">
          <Link
            href="/login"
            className="text-tx underline decoration-line-strong underline-offset-4 hover:decoration-tx"
          >
            Sign in
          </Link>{' '}
          to create or join an organisation.
        </p>
      ) : (
        <>
          {memberships.length > 0 && (
            <section className="panel mb-6 overflow-hidden">
              <p className="micro px-6 py-4">Your memberships</p>
              <ul className="border-t border-line">
                {memberships.map((entry) => {
                  const record = entry as unknown as {
                    role: string;
                    organisations: { id: string; name: string } | null;
                  };
                  if (!record.organisations) return null;
                  return (
                    <li
                      key={record.organisations.id}
                      className="ledger-row flex items-center gap-4 px-6 py-3.5"
                    >
                      <Link
                        href={`/org/${record.organisations.id}`}
                        className="flex-1 text-[13.5px] text-tx transition-opacity hover:opacity-70"
                      >
                        {record.organisations.name}
                      </Link>
                      {/* Open to every role. Assessments filed under an
                          organisation are readable by all of its members —
                          that is the policy on `assessments`, not a courtesy
                          — so a viewer gets the same link an owner does. */}
                      <Link
                        href={`/org/${record.organisations.id}/activity`}
                        className="text-[11.5px] text-tx-3 transition-colors hover:text-tx"
                      >
                        Activity
                      </Link>
                      <span className="chip">{record.role}</span>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          <OrgManager hasOrgs={memberships.length > 0} />
        </>
      )}

      <PageFooter />
    </main>
  );
}
