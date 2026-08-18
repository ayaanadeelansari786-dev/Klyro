import { NextResponse } from 'next/server';

import { getHistory, getRankings } from '@/lib/dataset/rankings';
import { INDUSTRIES, REGIONS } from '@/lib/constants';
import { clientKey, consumeRateLimit } from '@/lib/rateLimit';
import { parseDomain } from '@/lib/domain';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const industry = url.searchParams.get('industry') ?? undefined;
  const region = url.searchParams.get('region') ?? undefined;
  const historyFor = url.searchParams.get('history');

  if (industry && !(INDUSTRIES as readonly string[]).includes(industry)) {
    return NextResponse.json({ error: 'Unknown industry.' }, { status: 400 });
  }
  if (region && !(REGIONS as readonly string[]).includes(region)) {
    return NextResponse.json({ error: 'Unknown region.' }, { status: 400 });
  }

  const limit = await consumeRateLimit(`rankings:${clientKey(request)}`, 120);
  if (!limit.allowed) {
    return NextResponse.json({ error: 'Rate limit exceeded.' }, { status: 429 });
  }

  try {
    if (historyFor) {
      const parsed = parseDomain(historyFor);
      if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
      return NextResponse.json({ domain: parsed.domain, history: await getHistory(parsed.domain) });
    }

    return NextResponse.json(await getRankings(industry, region));
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Rankings unavailable.' },
      { status: 502 },
    );
  }
}
