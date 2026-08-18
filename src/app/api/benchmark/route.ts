import { NextResponse } from 'next/server';

import { getBenchmark } from '@/lib/benchmark';
import { INDUSTRIES, REGIONS } from '@/lib/constants';
import { parseDomain } from '@/lib/domain';
import { clientKey, consumeRateLimit } from '@/lib/rateLimit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const industry = url.searchParams.get('industry') ?? '';
  const region = url.searchParams.get('region') ?? '';
  const scoreParam = url.searchParams.get('score');

  if (!(INDUSTRIES as readonly string[]).includes(industry)) {
    return NextResponse.json({ error: 'Unknown industry.' }, { status: 400 });
  }
  if (!(REGIONS as readonly string[]).includes(region)) {
    return NextResponse.json({ error: 'Unknown region.' }, { status: 400 });
  }

  const limit = await consumeRateLimit(`benchmark:${clientKey(request)}`, 120);
  if (!limit.allowed) {
    return NextResponse.json({ error: 'Rate limit exceeded.' }, { status: 429 });
  }

  const score = scoreParam !== null && Number.isFinite(Number(scoreParam)) ? Number(scoreParam) : null;

  // Optional: when supplied, that domain is kept out of the pool it is being
  // compared against.
  const domainParam = url.searchParams.get('domain');
  const parsedDomain = domainParam ? parseDomain(domainParam) : null;

  const benchmark = await getBenchmark(
    industry,
    region,
    score,
    parsedDomain?.ok ? parsedDomain.domain : undefined,
  );

  return NextResponse.json(benchmark);
}
