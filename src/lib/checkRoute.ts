import { NextResponse } from 'next/server';
import type { CategoryKey } from './types';
import { parseDomain } from './domain';
import { clientKey, consumeRateLimit } from './rateLimit';
import { dnsQuery, runModule } from './checks/util';
import { CHECKS, timeoutFor } from './checks';
import { screenTarget } from './target';

/**
 * Shared handler for the ten individual /api/checks/* routes. Each route is a
 * thin wrapper so a single module can be run and debugged in isolation; the
 * orchestrator calls the same functions directly rather than going back out
 * over HTTP.
 */
export async function handleCheckRoute(
  request: Request,
  key: CategoryKey,
): Promise<NextResponse> {
  const url = new URL(request.url);
  const parsed = parseDomain(url.searchParams.get('domain') ?? '');

  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  // Individual checks get a looser budget than full scans.
  const limit = await consumeRateLimit(`check:${clientKey(request)}`, 120);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: 'Rate limit exceeded. Try again later.' },
      { status: 429, headers: { 'retry-after': String(limit.retryAfterSeconds) } },
    );
  }

  // These routes take a target from an anonymous caller exactly as the scan
  // endpoint does, so they get the same screening. Skipping it here would
  // leave the whole guard bypassable by calling a module directly.
  const screening = await screenTarget(parsed.domain, (name, type) =>
    dnsQuery(name, type, { confirmAbsence: false }),
  );
  if (!screening.ok) {
    return NextResponse.json({ error: screening.error }, { status: 400 });
  }

  const result = await runModule(key, CHECKS[key], parsed.domain, timeoutFor(key));
  return NextResponse.json(result);
}
