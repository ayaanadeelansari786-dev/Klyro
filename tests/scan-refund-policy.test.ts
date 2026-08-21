import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * Which rejections in the scan route are refundable.
 *
 * This is policy rather than arithmetic, and it is the half worth pinning
 * down: the limiter runs ahead of DNS on purpose, so that an unlimited path to
 * the resolver cannot turn Klyro into a query relay. That ordering is not
 * moving. What it costs is that a typo spends a token before anything has
 * established that it was a typo, and the refund is the narrow correction for
 * exactly that case — narrow because a refusal that is free to repeat is a
 * refusal an attacker can issue indefinitely.
 */

const consumeRateLimit = vi.fn();
const refund = vi.fn(async () => undefined);
const release = vi.fn(async () => undefined);
const screenName = vi.fn();
const screenTarget = vi.fn();
const preflightDomainCheck = vi.fn();

vi.mock('@/lib/rateLimit', () => ({
  clientKey: () => '203.0.113.9',
  acquireScanSlot: async () => ({ granted: true, active: 1, release }),
  consumeRateLimit: (...args: unknown[]) => consumeRateLimit(...args),
}));

vi.mock('@/lib/target', () => ({
  screenName: (...args: unknown[]) => screenName(...args),
  screenTarget: (...args: unknown[]) => screenTarget(...args),
  preflightDomainCheck: (...args: unknown[]) => preflightDomainCheck(...args),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClientForRequest: () => ({}),
  getCurrentUser: async () => null,
}));

vi.mock('@/lib/auth/context', () => ({
  resolveOwner: async () => ({ userId: null, orgId: null, notice: null }),
}));

// Carries `import 'server-only'`, which throws outside a server component and
// so cannot be loaded here. Nothing in these tests persists anything anyway —
// an anonymous scan writes no row.
vi.mock('@/lib/dataset/assessments', () => ({
  storeAssessment: async () => null,
  shouldContributeToBenchmark: async () => false,
  contributeToBenchmark: async () => undefined,
}));

/*
 * The scan itself is not under test, and letting it run would put real network
 * calls behind an assertion about bookkeeping. An empty manifest means the
 * stream opens, finds nothing to do, and closes.
 */
vi.mock('@/lib/checks', () => ({
  CHECKS: {},
  CHECK_ORDER: [],
  MODULE_MANIFEST: [],
  timeoutFor: () => 1_000,
}));

vi.mock('@/lib/checks/util', () => ({
  dnsQuery: async () => ({ resolved: false, status: 0, answers: [] }),
  runModule: async () => {
    throw new Error('no check module should run in these tests');
  },
}));

vi.mock('@/lib/benchmark', () => ({ getBenchmark: async () => null }));

vi.mock('@/lib/intel/inventory', () => ({ buildInventory: async () => null }));

function scanRequest() {
  return new Request('https://klyro.test/api/scan', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      domain: 'exampel.ae',
      industry: 'Banking & Finance',
      region: 'UAE',
    }),
  });
}

describe('scan route refund policy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    consumeRateLimit.mockResolvedValue({
      allowed: true,
      remaining: 9,
      retryAfterSeconds: 0,
      refund,
    });
    screenName.mockReturnValue({ ok: true });
    screenTarget.mockResolvedValue({ ok: true, addresses: ['192.0.2.1'] });
  });

  it('refunds exactly once when the domain does not resolve', async () => {
    preflightDomainCheck.mockResolvedValue({ exists: false, suggestion: 'exampel.com' });

    const { POST } = await import('@/app/api/scan/route');
    const response = await POST(scanRequest());

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      code: 'DOMAIN_NOT_FOUND',
      suggestion: 'exampel.com',
    });
    expect(refund).toHaveBeenCalledTimes(1);
  });

  it('refunds a name with no suggestion just the same', async () => {
    preflightDomainCheck.mockResolvedValue({ exists: false, suggestion: null });

    const { POST } = await import('@/app/api/scan/route');
    const response = await POST(scanRequest());

    expect(response.status).toBe(422);
    expect(refund).toHaveBeenCalledTimes(1);
  });

  it('does not refund a target refused by the SSRF screen', async () => {
    screenTarget.mockResolvedValue({
      ok: false,
      error: 'That domain resolves to an address on a private network.',
    });

    const { POST } = await import('@/app/api/scan/route');
    const response = await POST(scanRequest());

    expect(response.status).toBe(400);
    expect(refund).not.toHaveBeenCalled();
    // And the resolver was never reached for it, which is the point of
    // screening before the pre-flight rather than after.
    expect(preflightDomainCheck).not.toHaveBeenCalled();
  });

  it('does not refund a domain that resolves and goes on to be scanned', async () => {
    preflightDomainCheck.mockResolvedValue({ exists: true, suggestion: null });

    const { POST } = await import('@/app/api/scan/route');
    const response = await POST(scanRequest());

    expect(response.status).toBe(200);
    expect(refund).not.toHaveBeenCalled();

    await response.body?.cancel();
  });

  it('refunds before answering, so the token is back by the time the user retypes', async () => {
    const order: string[] = [];
    refund.mockImplementationOnce(async () => {
      order.push('refund');
    });
    preflightDomainCheck.mockImplementation(async () => {
      order.push('preflight');
      return { exists: false, suggestion: null };
    });

    const { POST } = await import('@/app/api/scan/route');
    await POST(scanRequest());

    expect(order).toEqual(['preflight', 'refund']);
  });
});
