import { Suspense } from 'react';
import type { Metadata } from 'next';

import ResultsView from '@/components/ResultsView';

export const metadata: Metadata = {
  title: 'Assessment Results — Klyro',
  robots: { index: false, follow: false },
};

// Results are always produced live from the query string.
export const dynamic = 'force-dynamic';

function Loading() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-[1180px] items-center justify-center px-5">
      <div className="flex items-center gap-3">
        <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-line-strong border-t-tx-2" />
        <p className="text-[12.5px] text-tx-2">Preparing assessment</p>
      </div>
    </main>
  );
}

export default function ResultsPage() {
  return (
    <Suspense fallback={<Loading />}>
      <ResultsView />
    </Suspense>
  );
}
