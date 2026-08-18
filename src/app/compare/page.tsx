import type { Metadata } from 'next';
import { Suspense } from 'react';

import CompareView from '@/components/CompareView';

export const metadata: Metadata = {
  title: 'Compare Assessments — Klyro',
  description:
    'Diff two completed assessments of the same domain: new findings, findings no longer observed, severity changes and score movement.',
};

export const dynamic = 'force-dynamic';

export default function ComparePage() {
  return (
    <Suspense fallback={null}>
      <CompareView />
    </Suspense>
  );
}
