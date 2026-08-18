import { describe, expect, it } from 'vitest';

import { sanitiseScanResult } from '@/lib/reportPayload';
import { acquireScanSlot, activeScanCount, clientKey, consumeRateLimit } from '@/lib/rateLimit';

/*
 * These exercise the in-memory implementation, which is what runs when
 * UPSTASH_REDIS_REST_URL is unset — the state of a test process, and of a
 * fresh checkout. It is a supported mode rather than a stub, so testing it is
 * testing the product. The Redis path is covered by the fact that both
 * implementations satisfy the same interface and the same assertions below;
 * what cannot be asserted here is the property the Redis path exists for,
 * which is that two processes share a counter.
 */
describe('rate limiting', () => {
  it('allows up to the limit then refuses with a retry hint', async () => {
    const key = `test-${Math.random()}`;
    for (let i = 0; i < 3; i += 1) {
      expect((await consumeRateLimit(key, 3, 60_000)).allowed).toBe(true);
    }

    const refused = await consumeRateLimit(key, 3, 60_000);
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('keys separately per identity', async () => {
    const a = `a-${Math.random()}`;
    const b = `b-${Math.random()}`;
    await consumeRateLimit(a, 1, 60_000);

    expect((await consumeRateLimit(a, 1, 60_000)).allowed).toBe(false);
    expect((await consumeRateLimit(b, 1, 60_000)).allowed).toBe(true);
  });

  it('caps the identity taken from proxy headers', () => {
    const key = clientKey(
      new Request('https://example.test', {
        headers: { 'x-forwarded-for': 'x'.repeat(5_000) },
      }),
    );

    // The header is caller-controlled; an uncapped key is a way to grow the
    // bucket map with megabyte-long entries.
    expect(key.length).toBeLessThanOrEqual(64);
  });

  it('takes the first entry of a forwarded chain', () => {
    expect(
      clientKey(
        new Request('https://example.test', {
          headers: { 'x-forwarded-for': '203.0.113.9, 70.41.3.18' },
        }),
      ),
    ).toBe('203.0.113.9');
  });
});

describe('scan concurrency', () => {
  it('grants slots up to the ceiling and refuses beyond it', async () => {
    const held: { release: () => Promise<void> }[] = [];
    let refusedAt = -1;

    for (let i = 0; i < 12; i += 1) {
      const slot = await acquireScanSlot();
      if (slot.granted) held.push(slot);
      else {
        refusedAt = i;
        break;
      }
    }

    expect(refusedAt).toBeGreaterThan(0);
    expect(held.length).toBe(refusedAt);

    for (const slot of held) await slot.release();
    expect(await activeScanCount()).toBe(0);
  });

  it('ignores a double release, so a cancelled stream cannot leak capacity', async () => {
    const before = await activeScanCount();
    const slot = await acquireScanSlot();
    await slot.release();
    await slot.release();
    await slot.release();

    expect(await activeScanCount()).toBe(before);
  });
});

/* ------------------------------------------------------------------ */

function payload(overrides: Record<string, unknown> = {}) {
  return {
    domain: 'example.test',
    industry: 'Technology',
    region: 'Global',
    compositeScore: 80,
    riskLevel: 'Low Risk',
    coverage: 1,
    scannedAt: '2026-01-01T00:00:00.000Z',
    toolVersion: '1.0.0',
    persisted: false,
    categories: [
      {
        key: 'dns',
        label: 'DNS Configuration',
        score: 80,
        status: 'assessed',
        findings: [],
        summary: 'fine',
        details: [],
        durationMs: 10,
      },
    ],
    findings: [],
    ...overrides,
  };
}

describe('report payload sanitisation', () => {
  it('accepts a well-formed result', () => {
    const verdict = sanitiseScanResult(payload(), 'example.test');
    expect(verdict.ok).toBe(true);
    expect(verdict.result?.compositeScore).toBe(80);
  });

  it('refuses a payload with no recognisable categories', () => {
    const verdict = sanitiseScanResult(payload({ categories: [{ key: 'not-a-category' }] }), 'x.test');
    expect(verdict.ok).toBe(false);
  });

  it('refuses a non-object payload', () => {
    expect(sanitiseScanResult('a report of my choosing', 'x.test').ok).toBe(false);
    expect(sanitiseScanResult(null, 'x.test').ok).toBe(false);
  });

  it('clamps prose to the length its layout allows', () => {
    const verdict = sanitiseScanResult(
      payload({
        findings: [
          {
            category: 'dns',
            title: 'T'.repeat(5_000),
            severity: 'critical',
            confidence: 'high',
            observed: 'O'.repeat(50_000),
            interpretation: '',
            risk: '',
            recommendation: '',
            evidence: { test: '', observed: '', verification: '' },
          },
        ],
      }),
      'example.test',
    );

    const finding = verdict.result!.findings[0];
    expect(finding.title.length).toBeLessThanOrEqual(160);
    expect(finding.observed.length).toBeLessThanOrEqual(1_200);
  });

  it('caps the number of findings rendered', () => {
    const many = Array.from({ length: 5_000 }, (_, i) => ({
      category: 'dns',
      title: `finding ${i}`,
      severity: 'low',
      confidence: 'high',
      evidence: {},
    }));

    const verdict = sanitiseScanResult(payload({ findings: many }), 'example.test');
    expect(verdict.result!.findings.length).toBeLessThanOrEqual(300);
  });

  it('forces an unrecognised severity or confidence to the weakest value', () => {
    const verdict = sanitiseScanResult(
      payload({
        findings: [
          {
            category: 'dns',
            title: 'x',
            severity: 'apocalyptic',
            confidence: 'certain',
            evidence: {},
          },
        ],
      }),
      'example.test',
    );

    // A forged payload must not be able to invent a severity band, and an
    // unstated confidence defaults to the one that claims least.
    expect(verdict.result!.findings[0].severity).toBe('info');
    expect(verdict.result!.findings[0].confidence).toBe('low');
  });

  it('drops properties it does not know about', () => {
    const verdict = sanitiseScanResult(
      payload({ evilPayload: '<script>', __proto__: { polluted: true } }),
      'example.test',
    );

    expect(verdict.result as unknown as Record<string, unknown>).not.toHaveProperty('evilPayload');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('overrides the domain with the one the route validated', () => {
    const verdict = sanitiseScanResult(payload({ domain: 'attacker.test' }), 'example.test');
    expect(verdict.result!.domain).toBe('example.test');
  });

  it('replaces an invalid timestamp rather than rendering it', () => {
    const verdict = sanitiseScanResult(payload({ scannedAt: 'yesterday-ish' }), 'example.test');
    expect(Number.isNaN(Date.parse(verdict.result!.scannedAt))).toBe(false);
  });

  it('strips characters from ids that reach React keys and the PDF', () => {
    const verdict = sanitiseScanResult(
      payload({
        findings: [{ category: 'dns', title: 'x', id: 'a"b<c>d e', evidence: {} }],
      }),
      'example.test',
    );

    expect(verdict.result!.findings[0].id).toBe('abcde');
  });

  it('clamps a score outside the 0-100 band', () => {
    const verdict = sanitiseScanResult(payload({ compositeScore: 100_000 }), 'example.test');
    expect(verdict.result!.compositeScore).toBe(100);
  });
});
