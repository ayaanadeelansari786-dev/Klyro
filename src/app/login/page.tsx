import type { Metadata } from 'next';

import AuthPanel from '@/components/AuthPanel';
import { PageFooter, Wordmark } from '@/components/Chrome';

export const metadata: Metadata = {
  title: 'Sign in — Klyro',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

export default function LoginPage() {
  return (
    <main className="mx-auto w-full max-w-[1180px] px-5 py-6 sm:px-8 sm:py-8">
      <header className="flex items-center justify-between">
        <Wordmark />
        <span className="micro hidden sm:inline">Accounts are optional</span>
      </header>

      <div className="mx-auto max-w-[520px] py-16 lg:py-24">
        <AuthPanel initialMode="signin" />
      </div>

      <PageFooter>
        Assessments run without an account. Signing in stores the ones you choose to keep, visible
        only to you and to any organisation you file them under.
      </PageFooter>
    </main>
  );
}
