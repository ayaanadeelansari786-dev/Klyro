import type { Metadata } from 'next';

import RankingsView from '@/components/RankingsView';

export const metadata: Metadata = {
  title: 'Industry Rankings — Klyro',
  description:
    'Vendors ranked within their industry by external exposure score, with corporate ownership and historical score movement.',
};

export const dynamic = 'force-dynamic';

export default function RankingsPage() {
  return <RankingsView />;
}
