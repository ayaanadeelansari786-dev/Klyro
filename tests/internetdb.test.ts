import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CATEGORY_WEIGHTS } from '@/lib/constants';
import type { CategoryResult } from '@/lib/types';

/**
 * The InternetDB module, which is the only one in the tree that measures
 * nothing.
 *
 * Most of these tests are about a single property: that the report never
 * presents Shodan's record as Klyro's observation. The module is useful
 * precisely because it says what somebody else saw — and it is dangerous in
 * exactly the same breath, because a port number in a PDF reads as a fact
 * whoever put it there. So the staleness language, the confidence ceiling, and
 * the "Klyro did not connect" statement are asserted, not assumed.
 */

const safeFetch = vi.fn();
const dnsQuery = vi.fn();

vi.mock('@/lib/checks/util', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/checks/util')>();
  return {
    ...actual,
    safeFetch: (...args: unknown[]) => safeFetch(...args),
    dnsQuery: (...args: unknown[]) => dnsQuery(...args),
  };
});

const { computeComposite } = await import('@/lib/scoring');
const { runModule } = await import('@/lib/checks/util');

const {
  checkInternetDB,
  classifyPort,
  evictInternetDbCacheEntry,
  internetDbCacheStats,
  lookupInternetDB,
  lookupInternetDBCached,
  resetInternetDbCache,
  scoreExposure,
  serviceFor,
  splitHostnames,
} = await import('@/lib/checks/internetdb');

/** DoH answer shape, A = type 1. */
function aRecord(address: string) {
  return {
    resolved: true,
    status: 0,
    ad: false,
    answers: [{ name: 'vendor.example', type: 1, TTL: 300, data: address }],
    resolvers: ['test'],
  };
}

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

const RECORD = {
  ip: '93.184.216.34',
  ports: [80, 443, 22, 3306],
  hostnames: ['www.vendor.example', 'vendor.example', 'stranger.example.org'],
  tags: [],
  vulns: [],
  cpes: [],
};

beforeEach(() => {
  safeFetch.mockReset();
  dnsQuery.mockReset();
  dnsQuery.mockResolvedValue(aRecord('93.184.216.34'));
  // Module-level state, so every test starts from the same place.
  resetInternetDbCache();
});

afterEach(() => vi.clearAllMocks());

describe('the lookup', () => {
  it('parses a record', async () => {
    safeFetch.mockResolvedValue(jsonResponse(RECORD));
    const result = await lookupInternetDB('93.184.216.34');
    expect(result).toMatchObject({ outcome: 'record' });
    if (result.outcome !== 'record') throw new Error('unreachable');
    expect(result.data.ports).toEqual([80, 443, 22, 3306]);
    expect(result.data.hostnames).toHaveLength(3);
  });

  it('treats 404 as "no record", not as a failure', async () => {
    // The two are different and they score differently: 404 is Shodan telling
    // us it has never crawled the address, which is information; 500 is Shodan
    // failing to tell us anything, which is not.
    safeFetch.mockResolvedValue(jsonResponse({ detail: 'No information available' }, 404));
    await expect(lookupInternetDB('1.2.3.4')).resolves.toEqual({ outcome: 'no-record' });
  });

  it.each([500, 502, 429])('treats %i as an error', async (status) => {
    safeFetch.mockResolvedValue(jsonResponse({}, status));
    const result = await lookupInternetDB('1.2.3.4');
    expect(result.outcome).toBe('error');
  });

  it('treats a dead request as an error', async () => {
    safeFetch.mockResolvedValue(null);
    expect((await lookupInternetDB('1.2.3.4')).outcome).toBe('error');
  });

  it('survives a body that is not the documented shape', async () => {
    // A third party's JSON is rendered into a document under Klyro's name.
    safeFetch.mockResolvedValue(
      jsonResponse({ ports: 'not-an-array', hostnames: [42, null], vulns: null }),
    );
    const result = await lookupInternetDB('1.2.3.4');
    expect(result).toMatchObject({ outcome: 'record' });
    if (result.outcome !== 'record') throw new Error('unreachable');
    expect(result.data.ports).toEqual([]);
    expect(result.data.hostnames).toEqual([]);
    expect(result.data.vulns).toEqual([]);
  });

  it('rejects port numbers outside the valid range', async () => {
    safeFetch.mockResolvedValue(jsonResponse({ ...RECORD, ports: [22, 0, -1, 70000, 1.5] }));
    const result = await lookupInternetDB('1.2.3.4');
    if (result.outcome !== 'record') throw new Error('unreachable');
    expect(result.data.ports).toEqual([22]);
  });

  it('rejects host names that are not host names', async () => {
    safeFetch.mockResolvedValue(
      jsonResponse({ ...RECORD, hostnames: ['ok.example', '<script>x</script>', 'a b c'] }),
    );
    const result = await lookupInternetDB('1.2.3.4');
    if (result.outcome !== 'record') throw new Error('unreachable');
    expect(result.data.hostnames).toEqual(['ok.example']);
  });
});

describe('port classification', () => {
  it('treats the ports every website answers on as expected', () => {
    for (const port of [80, 443, 53, 25]) expect(classifyPort(port)).toBe('expected');
  });

  it('treats the Cloudflare alternate ports as expected', () => {
    // Every Cloudflare-fronted domain publishes these. Flagging them would put
    // an identical finding on a large share of the corpus.
    for (const port of [2052, 2053, 2082, 2083, 2087, 8443, 8880]) {
      expect(classifyPort(port)).toBe('expected');
    }
  });

  it('classifies data stores as critical', () => {
    for (const port of [3306, 5432, 27017, 6379, 9200]) {
      expect(classifyPort(port)).toBe('critical');
      expect(serviceFor(port)).not.toBeNull();
    }
  });

  it('classifies remote access separately from data stores', () => {
    for (const port of [22, 23, 3389, 5900]) expect(classifyPort(port)).toBe('remote');
  });
});

describe('scoring', () => {
  it('is 100 for a record with nothing notable in it', () => {
    expect(scoreExposure({ ports: [80, 443], hasVulns: false })).toBe(100);
  });

  it('does not penalise the ports every site answers on', () => {
    expect(scoreExposure({ ports: [80, 443, 53, 2053, 8443], hasVulns: false })).toBe(100);
  });

  it('takes 25 for a data store and 15 for remote access', () => {
    expect(scoreExposure({ ports: [3306], hasVulns: false })).toBe(75);
    expect(scoreExposure({ ports: [22], hasVulns: false })).toBe(85);
    expect(scoreExposure({ ports: [3306, 22], hasVulns: false })).toBe(60);
  });

  it('takes 20 for an attributed vulnerability list', () => {
    expect(scoreExposure({ ports: [80], hasVulns: true })).toBe(80);
  });

  it('floors at zero rather than going negative', () => {
    expect(scoreExposure({ ports: [3306, 5432, 27017, 6379], hasVulns: true })).toBe(0);
    expect(scoreExposure({ ports: [3306, 5432, 27017, 6379, 1433, 9200], hasVulns: true })).toBe(0);
  });
});

describe('host name attribution', () => {
  it('separates the domain’s own names from strangers on the same address', () => {
    // The important one. On a shared or CDN address most names belong to other
    // people — 1.1.1.1 comes back with a school district and a university.
    const split = splitHostnames(
      ['www.vendor.example', 'vendor.example', 'pms-sfusd-ca.schoolloop.com', 'wlan.net.umd.edu'],
      'vendor.example',
    );
    expect(split.own).toEqual(['vendor.example', 'www.vendor.example']);
    expect(split.foreign).toBe(2);
  });

  it('does not match a domain that merely ends with the same letters', () => {
    const split = splitHostnames(['notvendor.example', 'evilvendor.example'], 'vendor.example');
    expect(split.own).toEqual([]);
    expect(split.foreign).toBe(2);
  });

  it('is case- and trailing-dot-insensitive', () => {
    const split = splitHostnames(['WWW.Vendor.Example.', 'vendor.example'], 'vendor.example');
    expect(split.own).toEqual(['vendor.example', 'www.vendor.example']);
  });
});

describe('findings', () => {
  it('raises a high finding for a data-store port, at medium confidence', async () => {
    safeFetch.mockResolvedValue(jsonResponse(RECORD));
    const out = await checkInternetDB('vendor.example');
    const finding = out.findings.find((f) => f.title.includes('data-store'));

    expect(finding?.severity).toBe('high');
    /*
     * Never high confidence. The record's age is unknown and unknowable from
     * the API, which is exactly what the medium level's "stated limitation"
     * means.
     */
    expect(finding?.confidence).toBe('medium');
  });

  it('states in every finding that Klyro did not connect', async () => {
    safeFetch.mockResolvedValue(jsonResponse(RECORD));
    const out = await checkInternetDB('vendor.example');
    expect(out.findings.length).toBeGreaterThan(0);
    for (const f of out.findings) {
      expect(f.evidence.verification).toContain('Klyro did not connect');
      expect(f.evidence.verification).toContain('Shodan');
    }
  });

  it('discloses that the age of the record is unknown', async () => {
    safeFetch.mockResolvedValue(jsonResponse(RECORD));
    const out = await checkInternetDB('vendor.example');
    for (const f of out.findings) {
      expect(f.evidence.limitation).toMatch(/no crawl date|age of this observation is unknown/i);
    }
  });

  it('creates no vulnerability finding when the list is empty', async () => {
    safeFetch.mockResolvedValue(jsonResponse(RECORD));
    const out = await checkInternetDB('vendor.example');
    expect(out.findings.some((f) => f.title.toLowerCase().includes('vulnerability'))).toBe(false);
  });

  it('creates no finding from tags or cpes', async () => {
    safeFetch.mockResolvedValue(
      jsonResponse({ ...RECORD, tags: ['cloud', 'cdn'], cpes: ['cpe:/a:nginx:nginx'] }),
    );
    const out = await checkInternetDB('vendor.example');
    expect(out.findings.some((f) => /tag|cpe/i.test(f.title))).toBe(false);
  });

  it('flags an attributed CVE list as high severity but low confidence', async () => {
    safeFetch.mockResolvedValue(
      jsonResponse({ ...RECORD, vulns: ['CVE-2021-44228', 'CVE-2014-0160'] }),
    );
    const out = await checkInternetDB('vendor.example');
    const finding = out.findings.find((f) => f.title.toLowerCase().includes('vulnerability'));

    expect(finding?.severity).toBe('high');
    // Low, because the identifiers are a third party's inference from a banner
    // and Klyro has tested none of them.
    expect(finding?.confidence).toBe('low');
    expect(finding?.observed).toContain('CVE-2021-44228');
    expect(finding?.interpretation).toContain('not a test');
    expect(finding?.evidence.limitation).toContain('performed no vulnerability testing');
  });

  it('names no CVE outside the quoted list, and endorses none', async () => {
    safeFetch.mockResolvedValue(jsonResponse({ ...RECORD, vulns: ['CVE-2021-44228'] }));
    const out = await checkInternetDB('vendor.example');
    const finding = out.findings.find((f) => f.title.toLowerCase().includes('vulnerability'));
    expect(finding?.recommendation).toContain('confirm');
    expect(finding?.evidence.limitation).toContain('does not confirm, rank, or endorse');
  });

  it('lists in-domain host names and only counts the rest', async () => {
    safeFetch.mockResolvedValue(jsonResponse(RECORD));
    const out = await checkInternetDB('vendor.example');
    const finding = out.findings.find((f) => f.title.includes('reverse-DNS'));

    expect(finding?.observed).toContain('www.vendor.example');
    // A stranger's host name must never be printed into somebody else's report.
    expect(finding?.observed).not.toContain('stranger.example.org');
    expect(finding?.severity).toBe('info');
  });

  it('says so plainly when the record is clean', async () => {
    safeFetch.mockResolvedValue(jsonResponse({ ...RECORD, ports: [80, 443], hostnames: [] }));
    const out = await checkInternetDB('vendor.example');

    expect(out.score).toBe(100);
    expect(out.moduleCoverage).toBe(1);
    expect(out.findings[0].title).toContain('no sensitive ports');
    expect(out.findings[0].severity).toBe('info');
  });
});

describe('the cache', () => {
  const HOUR = 60 * 60 * 1000;

  it('sends one request for repeated lookups of the same address', async () => {
    safeFetch.mockResolvedValue(jsonResponse(RECORD));

    await lookupInternetDBCached('1.2.3.4', 0);
    await lookupInternetDBCached('1.2.3.4', 1_000);
    await lookupInternetDBCached('1.2.3.4', 60_000);

    expect(safeFetch).toHaveBeenCalledTimes(1);
    expect(internetDbCacheStats().cached).toBe(1);
  });

  it('returns the same answer from the cache as from the wire', async () => {
    safeFetch.mockResolvedValue(jsonResponse(RECORD));
    const first = await lookupInternetDBCached('1.2.3.4', 0);
    const second = await lookupInternetDBCached('1.2.3.4', 5_000);
    expect(second).toEqual(first);
  });

  it('sends again once the entry is older than an hour', async () => {
    safeFetch.mockResolvedValue(jsonResponse(RECORD));

    await lookupInternetDBCached('1.2.3.4', 0);
    await lookupInternetDBCached('1.2.3.4', HOUR - 1);
    expect(safeFetch).toHaveBeenCalledTimes(1);

    await lookupInternetDBCached('1.2.3.4', HOUR);
    expect(safeFetch).toHaveBeenCalledTimes(2);
  });

  it('keeps addresses apart', async () => {
    safeFetch.mockResolvedValue(jsonResponse(RECORD));
    await lookupInternetDBCached('1.2.3.4', 0);
    await lookupInternetDBCached('5.6.7.8', 0);
    expect(safeFetch).toHaveBeenCalledTimes(2);
  });

  it('caches a "no record" answer, which is stable', async () => {
    safeFetch.mockResolvedValue(jsonResponse({ detail: 'No information available' }, 404));
    await lookupInternetDBCached('1.2.3.4', 0);
    await lookupInternetDBCached('1.2.3.4', 1_000);
    expect(safeFetch).toHaveBeenCalledTimes(1);
  });

  it('does not cache an error', async () => {
    /*
     * A record and a "no record" are statements about the address and hold for
     * an hour. A 502 is a statement about Shodan at that instant, and caching
     * it would take the module out for an hour on the strength of one bad
     * second.
     */
    safeFetch.mockResolvedValue(jsonResponse({}, 502));
    await lookupInternetDBCached('1.2.3.4', 0);
    await lookupInternetDBCached('1.2.3.4', 1_000);
    expect(safeFetch).toHaveBeenCalledTimes(2);
    expect(internetDbCacheStats().cached).toBe(0);
  });

  it('recovers on the next call after a failure', async () => {
    safeFetch.mockResolvedValueOnce(jsonResponse({}, 502));
    safeFetch.mockResolvedValue(jsonResponse(RECORD));

    expect((await lookupInternetDBCached('1.2.3.4', 0)).outcome).toBe('error');
    expect((await lookupInternetDBCached('1.2.3.4', 10)).outcome).toBe('record');
  });

  it('does not grow without limit', async () => {
    safeFetch.mockResolvedValue(jsonResponse(RECORD));
    for (let i = 0; i < 620; i += 1) {
      await lookupInternetDBCached(`10.0.${Math.floor(i / 256)}.${i % 256}`, 0);
    }
    expect(internetDbCacheStats().cached).toBeLessThanOrEqual(500);
  });
});

describe('the hourly ceiling', () => {
  const HOUR = 60 * 60 * 1000;

  /*
   * The cache sits in front of the counter, so every one of these has to be a
   * miss for the counter to be reached at all. Evicting the single entry does
   * that; advancing the clock instead would reset the window under test.
   */
  const missingLookup = async (address: string, at: number) => {
    const result = await lookupInternetDBCached(address, at);
    evictInternetDbCacheEntry(address);
    return result;
  };

  it('lets a hundred lookups of one address through, then refuses', async () => {
    safeFetch.mockResolvedValue(jsonResponse(RECORD));

    let refusedAt: number | null = null;
    for (let i = 0; i < 105; i += 1) {
      const result = await missingLookup('9.9.9.9', i);
      if (refusedAt === null && result.outcome === 'error' && /not sent/.test(result.reason)) {
        refusedAt = i;
      }
    }

    expect(refusedAt).toBe(100);
    expect(safeFetch).toHaveBeenCalledTimes(100);
  });

  it('opens the window again after an hour', async () => {
    safeFetch.mockResolvedValue(jsonResponse(RECORD));

    for (let i = 0; i < 101; i += 1) await missingLookup('9.9.9.9', i);
    expect(safeFetch).toHaveBeenCalledTimes(100);

    // The version this replaces incremented a counter and never reset it, so
    // the address would have stayed refused for the life of the process.
    const after = await missingLookup('9.9.9.9', HOUR + 1);
    expect(after.outcome).toBe('record');
    expect(safeFetch).toHaveBeenCalledTimes(101);
  });

  it('counts each address separately', async () => {
    safeFetch.mockResolvedValue(jsonResponse(RECORD));
    for (let i = 0; i < 101; i += 1) await missingLookup('9.9.9.9', i);

    expect((await missingLookup('8.8.4.4', 200)).outcome).toBe('record');
  });

  it('says why the request was not sent', async () => {
    safeFetch.mockResolvedValue(jsonResponse(RECORD));
    for (let i = 0; i < 100; i += 1) await missingLookup('9.9.9.9', i);

    const refused = await missingLookup('9.9.9.9', 100);
    if (refused.outcome !== 'error') throw new Error('expected a refusal');
    expect(refused.reason).toContain('9.9.9.9');
    expect(refused.reason).toContain('not sent');
  });
});

describe('the shared-address hazard', () => {
  it('does not give one domain another domain’s host names', async () => {
    /*
     * The reason the cache holds Shodan's record and not the finished
     * findings. CDN addresses serve hundreds of domains; the host-name split
     * is domain-specific, so caching findings by address alone would put one
     * customer's hosts into another customer's report.
     */
    safeFetch.mockResolvedValue(
      jsonResponse({
        ...RECORD,
        ports: [80, 443],
        hostnames: ['www.alpha.example', 'www.beta.example'],
      }),
    );

    dnsQuery.mockResolvedValue(aRecord('93.184.216.34'));
    const alpha = await checkInternetDB('alpha.example');

    dnsQuery.mockResolvedValue(aRecord('93.184.216.34'));
    const beta = await checkInternetDB('beta.example');

    // One request: the record genuinely is a property of the address.
    expect(safeFetch).toHaveBeenCalledTimes(1);

    const alphaFacts = alpha.facts as { hostnamesInDomain: string[] };
    const betaFacts = beta.facts as { hostnamesInDomain: string[] };

    expect(alphaFacts.hostnamesInDomain).toEqual(['www.alpha.example']);
    expect(betaFacts.hostnamesInDomain).toEqual(['www.beta.example']);

    expect(JSON.stringify(alpha)).not.toContain('beta.example');
    expect(JSON.stringify(beta)).not.toContain('alpha.example');
  });
});

describe('when there is nothing to read', () => {
  /*
   * These assert the *effect*, not a field.
   *
   * The first version of these tests checked `moduleCoverage === 0` and passed
   * while the module was scoring a domain 0 out of 100 at full weight for not
   * appearing in Shodan's index. `computeComposite` filters on `status` and
   * never reads `moduleCoverage`, so the field the test was watching had
   * nothing to do with the behaviour it claimed to cover. Running the module
   * through `runModule` and then through the real composite is the only way to
   * make that class of mistake impossible.
   */
  const runAndScore = async (domain: string) => {
    const category = await runModule('internetdb', checkInternetDB, domain, 8_000);
    // Paired with a module that did score, so the renormalisation is exercised.
    const dns: CategoryResult = {
      key: 'dns',
      label: 'DNS Configuration',
      score: 80,
      status: 'assessed',
      findings: [],
      summary: '',
      details: [],
      durationMs: 1,
    };
    return { category, composite: computeComposite([dns, category]) };
  };

  it('is excluded from the composite when Shodan has no record', async () => {
    safeFetch.mockResolvedValue(jsonResponse({ detail: 'No information available' }, 404));
    const { category, composite } = await runAndScore('vendor.example');

    expect(category.status).toBe('unavailable');
    // 80, not 80 renormalised against a zero — the domain is neither rewarded
    // nor punished for a gap in somebody else's crawl.
    expect(composite.compositeScore).toBe(80);
    expect(composite.coverage).toBeCloseTo(CATEGORY_WEIGHTS.dns, 6);
  });

  it('never marks a domain down for being absent from a third-party index', async () => {
    // The same domain, scored twice: once when Shodan holds a clean record and
    // once when it holds none. Absence must not be worse than a clean record.
    safeFetch.mockResolvedValue(jsonResponse({ ...RECORD, ports: [80, 443], hostnames: [] }));
    const present = await runAndScore('vendor.example');

    // Without this the second scoring replays the cached record, which is the
    // cache working rather than the behaviour under test.
    resetInternetDbCache();
    safeFetch.mockResolvedValue(jsonResponse({ detail: 'No information available' }, 404));
    const absent = await runAndScore('vendor.example');

    expect(present.category.status).toBe('assessed');
    expect(absent.category.status).toBe('unavailable');
    expect(absent.composite.compositeScore).toBeGreaterThanOrEqual(
      present.composite.compositeScore - 100,
    );
    // Concretely: absence leaves the DNS score untouched at 80.
    expect(absent.composite.compositeScore).toBe(80);
  });

  it('is excluded when the API fails', async () => {
    safeFetch.mockResolvedValue(jsonResponse({}, 503));
    const { category, composite } = await runAndScore('vendor.example');
    expect(category.status).toBe('unavailable');
    expect(composite.compositeScore).toBe(80);
  });

  it('is excluded when the domain publishes no address', async () => {
    dnsQuery.mockResolvedValue({ resolved: true, status: 0, ad: false, answers: [], resolvers: [] });
    const { category } = await runAndScore('mail-only.example');
    expect(safeFetch).not.toHaveBeenCalled();
    expect(category.status).toBe('unavailable');
  });

  it.each(['127.0.0.1', '10.0.0.5', '169.254.169.254'])(
    'does not ask a public database about %s',
    async (address) => {
      // A reserved address is not globally unique, so the record would be
      // somebody else's — and the query would tell Shodan about the caller.
      dnsQuery.mockResolvedValue(aRecord(address));
      const { category } = await runAndScore('internal.example');
      expect(safeFetch).not.toHaveBeenCalled();
      expect(category.status).toBe('unavailable');
    },
  );

  it('draws no conclusion in the finding it leaves behind', async () => {
    safeFetch.mockResolvedValue(jsonResponse({ detail: 'No information available' }, 404));
    const { category } = await runAndScore('vendor.example');

    expect(category.findings).toHaveLength(1);
    expect(category.findings[0].severity).toBe('info');
    expect(category.findings[0].risk).toContain('None is claimed');
  });
});
