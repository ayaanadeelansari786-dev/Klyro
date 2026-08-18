import { NextResponse } from 'next/server';

import { getNewsIntelligence } from '@/lib/intel/news';
import { parseDomain } from '@/lib/domain';
import { clientKey, consumeRateLimit } from '@/lib/rateLimit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = parseDomain(url.searchParams.get('domain') ?? '');

  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  const limit = await consumeRateLimit(`news:${clientKey(request)}`, 60);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: 'Rate limit exceeded. Try again later.' },
      { status: 429, headers: { 'retry-after': String(limit.retryAfterSeconds) } },
    );
  }

  try {
    const intelligence = await getNewsIntelligence(parsed.domain);
    return NextResponse.json(intelligence);
  } catch (err) {
    return NextResponse.json(
      {
        error: 'News intelligence could not be gathered.',
        detail: err instanceof Error ? err.message : 'Unknown error',
      },
      { status: 502 },
    );
  }
}
