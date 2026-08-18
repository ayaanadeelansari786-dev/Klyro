import { vi } from 'vitest';

/**
 * A stubbed DNS-over-HTTPS layer.
 *
 * Every check module reaches the network through the same `fetch`, so the
 * whole DNS surface can be driven from a fixture table without touching a real
 * resolver. Anything the table does not cover throws rather than silently
 * returning nothing — a test that quietly exercises the "resolver failed" path
 * when it meant to test a record is worse than one that errors.
 */

export interface DnsFixture {
  /** RCODE. 0 NOERROR, 2 SERVFAIL, 3 NXDOMAIN. */
  status?: number;
  /** Authenticated Data flag. */
  ad?: boolean;
  /** Answer rdata strings; the type code is filled in from the question. */
  answers?: string[];
  /** Full answer records, where TTL or a mixed-type answer matters. */
  records?: { name: string; type: number; TTL: number; data: string }[];
  /** Simulates a transport failure at every resolver. */
  fail?: boolean;
}

export const TYPE_CODES: Record<string, number> = {
  A: 1,
  NS: 2,
  CNAME: 5,
  SOA: 6,
  PTR: 12,
  MX: 15,
  TXT: 16,
  AAAA: 28,
  DS: 43,
  DNSKEY: 48,
  CAA: 257,
};

export type DnsTable = Record<string, DnsFixture>;

/** Key format is `name|TYPE`, matching how the fixtures read. */
export function dnsKey(name: string, type: string): string {
  return `${name.replace(/\.$/, '').toLowerCase()}|${type.toUpperCase()}`;
}

interface StubOptions {
  /** Table of DNS answers. */
  dns?: DnsTable;
  /**
   * Non-DNS responses, keyed by a substring of the URL. First match wins, so
   * order the more specific keys first.
   */
  http?: { match: string; status?: number; body?: string; headers?: Record<string, string> }[];
  /**
   * What to do with a URL no fixture covers. `throw` (default) surfaces the
   * gap; `fail` simulates an unreachable network, which is what several tests
   * are actually about.
   */
  unmatched?: 'throw' | 'fail';
}

/**
 * Replaces global fetch for the duration of a test. Returns a record of every
 * DNS question asked, so a test can assert that absence was confirmed against
 * a second resolver rather than reported from one answer.
 */
export function stubFetch(options: StubOptions): { questions: string[]; urls: string[] } {
  const questions: string[] = [];
  const urls: string[] = [];
  const dns = options.dns ?? {};
  const http = options.http ?? [];
  const unmatched = options.unmatched ?? 'throw';

  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    urls.push(url);

    const parsed = new URL(url);
    const isDoh =
      parsed.hostname === 'dns.google' || parsed.hostname === 'cloudflare-dns.com';

    if (isDoh) {
      const name = parsed.searchParams.get('name') ?? '';
      const type = parsed.searchParams.get('type') ?? 'A';
      const key = dnsKey(name, type);
      questions.push(key);

      const fixture = dns[key];
      if (!fixture) {
        // An unfixtured DNS question is an authoritative "nothing there".
        // Modules legitimately ask about names a test does not care about —
        // DKIM selectors, CNAME targets — and NXDOMAIN is the honest answer.
        return jsonResponse({ Status: 3, AD: false, Answer: [] });
      }
      if (fixture.fail) throw new Error('simulated resolver failure');

      const answers =
        fixture.records ??
        (fixture.answers ?? []).map((data) => ({
          name,
          type: TYPE_CODES[type.toUpperCase()] ?? 1,
          TTL: 300,
          data,
        }));

      return jsonResponse({
        Status: fixture.status ?? 0,
        AD: fixture.ad ?? false,
        Answer: answers,
      });
    }

    for (const rule of http) {
      if (url.includes(rule.match)) {
        return new Response(rule.body ?? '', {
          status: rule.status ?? 200,
          headers: rule.headers ?? {},
        });
      }
    }

    if (unmatched === 'fail') throw new Error(`no fixture for ${url}`);
    throw new Error(`Unstubbed request: ${init?.method ?? 'GET'} ${url}`);
  });

  return { questions, urls };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/dns-json' },
  });
}

/** Builds a TXT fixture, quoting the way a DoH resolver does. */
export function txt(...values: string[]): DnsFixture {
  return { answers: values.map((v) => `"${v}"`) };
}
