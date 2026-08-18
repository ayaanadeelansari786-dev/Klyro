import { afterEach, describe, expect, it, vi } from 'vitest';

import { dnsQuery } from '@/lib/checks/util';

import { dnsKey, stubFetch, txt } from './helpers/dns';

/**
 * The resolver layer. Everything else in the product rests on one distinction
 * this makes: a lookup that failed is not a record that is absent.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('dnsQuery', () => {
  it('returns a positive answer from the first resolver without asking a second', async () => {
    const { questions } = stubFetch({
      dns: { [dnsKey('example.com', 'A')]: { answers: ['93.184.216.34'] } },
    });

    const result = await dnsQuery('example.com', 'A');

    expect(result.resolved).toBe(true);
    expect(result.status).toBe(0);
    expect(result.answers).toHaveLength(1);
    expect(result.resolvers).toHaveLength(1);
    // A positive answer needs no corroboration: the record either exists or it
    // does not, and one resolver returning it settles that.
    expect(questions.filter((q) => q === dnsKey('example.com', 'A'))).toHaveLength(1);
  });

  it('confirms an NXDOMAIN against a second resolver before reporting absence', async () => {
    const { questions } = stubFetch({
      dns: { [dnsKey('nothing.example', 'TXT')]: { status: 3 } },
    });

    const result = await dnsQuery('nothing.example', 'TXT');

    expect(result.resolved).toBe(true);
    expect(result.status).toBe(3);
    expect(result.answers).toHaveLength(0);
    expect(result.resolvers).toHaveLength(2);
    expect(questions.filter((q) => q === dnsKey('nothing.example', 'TXT'))).toHaveLength(2);
  });

  it('reports resolved:false when no resolver answers at all', async () => {
    stubFetch({ dns: { [dnsKey('flaky.example', 'TXT')]: { fail: true } } });

    const result = await dnsQuery('flaky.example', 'TXT');

    // The single most important assertion in this file. If this ever returns
    // resolved:true with an empty answer, every "not published" finding in the
    // product becomes reachable by rate-limiting one resolver.
    expect(result.resolved).toBe(false);
    expect(result.status).toBeNull();
    expect(result.answers).toHaveLength(0);
    expect(result.reason).toMatch(/No DNS resolver answered/);
  });

  it('skips the absence confirmation when the caller asks it to', async () => {
    const { questions } = stubFetch({
      dns: { [dnsKey('bulk.example', 'TXT')]: { status: 0, answers: [] } },
    });

    const result = await dnsQuery('bulk.example', 'TXT', { confirmAbsence: false });

    expect(result.resolved).toBe(true);
    expect(questions).toHaveLength(1);
  });

  it('carries the AD flag through for DNSSEC checks', async () => {
    stubFetch({
      dns: { [dnsKey('signed.example', 'A')]: { ad: true, answers: ['192.0.2.1'] } },
    });

    const result = await dnsQuery('signed.example', 'A', { dnssec: true });

    expect(result.ad).toBe(true);
  });

  it('rebuilds TXT values that a resolver split into chunks', async () => {
    stubFetch({
      dns: {
        [dnsKey('long.example', 'TXT')]: {
          answers: ['"v=spf1 include:a.example " "include:b.example -all"'],
        },
      },
    });

    const result = await dnsQuery('long.example', 'TXT');
    const { txtValues } = await import('@/lib/checks/util');

    expect(txtValues(result)).toEqual(['v=spf1 include:a.example include:b.example -all']);
  });

  it('treats a quoted single-string TXT record as one value', async () => {
    stubFetch({ dns: { [dnsKey('simple.example', 'TXT')]: txt('v=spf1 -all') } });

    const result = await dnsQuery('simple.example', 'TXT');
    const { txtValues } = await import('@/lib/checks/util');

    expect(txtValues(result)).toEqual(['v=spf1 -all']);
  });
});
