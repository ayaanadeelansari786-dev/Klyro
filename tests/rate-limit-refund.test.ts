import { describe, expect, it, vi } from 'vitest';

import { consumeRateLimit } from '@/lib/rateLimit';

/*
 * The refund is a closure returned by the consume, not a `refundRateLimit(key)`
 * free function, and these tests are shaped by that. There are two backing
 * stores — Redis normally, the in-memory map when Upstash is unconfigured or
 * was unreachable for one call — and the refund has to land on whichever one
 * took the charge. Closing over it removes the guess; what is left to test is
 * that the arithmetic is right and that a failure stays quiet.
 *
 * The first group runs against the in-memory implementation, which is what a
 * test process and a fresh checkout use. The last test builds a limiter with a
 * stubbed Upstash client, because the property that matters on that path — a
 * refund that fails does not become an exception — cannot be provoked on the
 * in-memory one.
 */

const WINDOW = 60_000;

describe('rate limit refund', () => {
  it('returns the token, letting the caller spend it again', async () => {
    const key = `refund-${Math.random()}`;

    const first = await consumeRateLimit(key, 1, WINDOW);
    expect(first.allowed).toBe(true);
    expect((await consumeRateLimit(key, 1, WINDOW)).allowed).toBe(false);

    await first.refund();

    expect((await consumeRateLimit(key, 1, WINDOW)).allowed).toBe(true);
  });

  it('is idempotent, so a double call cannot mint a second token', async () => {
    const key = `idempotent-${Math.random()}`;

    const spent = await consumeRateLimit(key, 2, WINDOW);
    await consumeRateLimit(key, 2, WINDOW);

    await spent.refund();
    await spent.refund();
    await spent.refund();

    // One token back, not three: the second spend is still on the record.
    expect((await consumeRateLimit(key, 2, WINDOW)).allowed).toBe(true);
    expect((await consumeRateLimit(key, 2, WINDOW)).allowed).toBe(false);
  });

  it('does nothing when the request was refused', async () => {
    const key = `refused-${Math.random()}`;

    await consumeRateLimit(key, 1, WINDOW);
    const refused = await consumeRateLimit(key, 1, WINDOW);
    expect(refused.allowed).toBe(false);

    // A refusal never incremented anything — in both implementations the
    // ceiling check precedes the write. Crediting one back would hand out a
    // token nobody spent, and make the limit bypassable by anyone willing to
    // retry a refusal.
    await refused.refund();
    expect((await consumeRateLimit(key, 1, WINDOW)).allowed).toBe(false);
  });

  it('refunds one identity without touching another', async () => {
    const a = `a-${Math.random()}`;
    const b = `b-${Math.random()}`;

    const spentA = await consumeRateLimit(a, 1, WINDOW);
    await consumeRateLimit(b, 1, WINDOW);

    await spentA.refund();

    expect((await consumeRateLimit(a, 1, WINDOW)).allowed).toBe(true);
    expect((await consumeRateLimit(b, 1, WINDOW)).allowed).toBe(false);
  });

  it('returns the hit it recorded, not whichever is newest', async () => {
    vi.useFakeTimers();
    try {
      const key = `interleaved-${Math.random()}`;

      // A second request from the same address lands between the consume and
      // the refund. The two hits are interchangeable in arithmetic but not in
      // expiry — a sliding window is a list of instants, so returning the
      // wrong instant moves when the window reopens.
      const first = await consumeRateLimit(key, 2, WINDOW);
      vi.setSystemTime(Date.now() + 30_000);
      await consumeRateLimit(key, 2, WINDOW);

      await first.refund();

      // Only the later hit should be left. Refill and check when the window is
      // said to reopen: a full window away if the right instant was returned,
      // half of one if the newest was taken instead.
      await consumeRateLimit(key, 2, WINDOW);
      const refused = await consumeRateLimit(key, 2, WINDOW);

      expect(refused.allowed).toBe(false);
      expect(refused.retryAfterSeconds).toBeGreaterThan(45);
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends the refund through the limiter, and stays quiet when it fails', async () => {
    vi.resetModules();
    vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://upstash.invalid');
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'test-token');

    const limit = vi
      .fn()
      .mockResolvedValueOnce({ success: true, remaining: 4, reset: Date.now() + WINDOW })
      .mockRejectedValueOnce(new Error('upstash unreachable'));

    vi.doMock('@upstash/redis', () => ({ Redis: class {} }));
    vi.doMock('@upstash/ratelimit', () => ({
      Ratelimit: class {
        static slidingWindow = () => ({});
        limit = limit;
      },
    }));

    try {
      const { consumeRateLimit: consume } = await import('@/lib/rateLimit');
      const spent = await consume('scan:203.0.113.9', 5, WINDOW);
      expect(spent.allowed).toBe(true);

      // A negative rate is the library's own refund path: its sliding-window
      // script skips the ceiling check when the increment is negative and
      // applies a plain INCRBY, so the token goes back into the bucket it came
      // out of. Klyro never has to know how Upstash names its windows.
      await expect(spent.refund()).resolves.toBeUndefined();
      expect(limit).toHaveBeenNthCalledWith(2, 'scan:203.0.113.9', { rate: -1 });
    } finally {
      vi.doUnmock('@upstash/ratelimit');
      vi.doUnmock('@upstash/redis');
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});
