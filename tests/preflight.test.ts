import { afterEach, describe, expect, it, vi } from 'vitest';

import { dnsQuery } from '@/lib/checks/util';
import { preflightDomainCheck, variantsFor } from '@/lib/target';

import { stubFetch, type DnsTable } from './helpers/dns';

/**
 * Pre-flight existence checking.
 *
 * Two of the five domains in the stress-test set did not exist at all. Left to
 * run, a name with no address produces eleven modules that each fail to reach
 * anything and a report that says almost nothing — twenty seconds spent to
 * communicate "you mistyped it", badly.
 *
 * The two properties worth protecting here are opposites, and both matter:
 * a domain that does not exist has to be caught, and a domain that merely
 * *looks* unusual — a redirect, an apex with no web server — must not be.
 * Refusing to assess a real domain is a worse failure than the one being
 * fixed, so most of these tests are about the second half.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

const resolver = (name: string, type: string) =>
  dnsQuery(name, type, { confirmAbsence: false });

/** Everything unfixtured answers NXDOMAIN, which is the helper's default. */
function withDns(table: DnsTable) {
  return stubFetch({ dns: table });
}

/* ------------------------------------------------------------------ *
 * Variant generation
 * ------------------------------------------------------------------ */

describe('variant suggestions', () => {
  it('offers the .com form of a bare .ae name', () => {
    expect(variantsFor('dunerealestate.ae')).toContain('dunerealestate.com');
  });

  it('offers the .ae form of a .com name', () => {
    expect(variantsFor('etisalat.com')).toContain('etisalat.ae');
  });

  it('strips .ac.ae down to .ae', () => {
    expect(variantsFor('fad.ac.ae')).toContain('fad.ae');
  });

  it('does not turn a second-level suffix into nonsense', () => {
    // `X.co.ae` is a registered name. Swapping the `.ae` would propose
    // `X.co.com`, which is not a plausible correction of anything.
    expect(variantsFor('acme.co.ae')).not.toContain('acme.co.com');
    expect(variantsFor('acme.gov.ae')).not.toContain('acme.gov.com');
  });

  it('never suggests the name it was given', () => {
    for (const host of ['acme.com', 'acme.ae', 'fad.ac.ae']) {
      expect(variantsFor(host)).not.toContain(host);
    }
  });

  it('bounds how many candidates it will probe', () => {
    // A typo must not cost a long wait; the probes are sequential.
    expect(variantsFor('acme.ae').length).toBeLessThanOrEqual(3);
  });
});

/* ------------------------------------------------------------------ *
 * Existence
 * ------------------------------------------------------------------ */

describe('pre-flight existence check', () => {
  it('passes a domain with an A record', async () => {
    withDns({ 'github.com|A': { answers: ['140.82.121.4'] } });

    const result = await preflightDomainCheck('github.com', resolver);

    expect(result).toMatchObject({ exists: true, hasARecord: true });
    expect(result.suggestion).toBeUndefined();
  });

  it('passes a domain that has only IPv6', async () => {
    withDns({ 'v6only.test|AAAA': { answers: ['2606:4700::1111'] } });

    const result = await preflightDomainCheck('v6only.test', resolver);

    expect(result).toMatchObject({ exists: true, hasARecord: false, hasAAAARecord: true });
  });

  it('fails a domain with neither record, and offers no suggestion when no variant resolves', async () => {
    // fad.ac.ae — the variant fad.ae does not resolve either, so there is
    // nothing honest to propose.
    withDns({});

    const result = await preflightDomainCheck('fad.ac.ae', resolver);

    expect(result.exists).toBe(false);
    expect(result.suggestion).toBeUndefined();
  });

  it('offers the variant that does resolve', async () => {
    // dunerealestate.ae is dead; dunerealestate.com is live.
    withDns({ 'dunerealestate.com|A': { answers: ['203.0.113.10'] } });

    const result = await preflightDomainCheck('dunerealestate.ae', resolver);

    expect(result.exists).toBe(false);
    expect(result.suggestion).toBe('dunerealestate.com');
  });

  it('does not offer a variant that is itself unreachable', async () => {
    // The variant is generated but never confirmed, so it is never shown. A
    // wrong suggestion invites the reader to assess a domain they did not mean.
    withDns({});

    const result = await preflightDomainCheck('dunerealestate.ae', resolver);

    expect(result.suggestion).toBeUndefined();
  });

  it('does not propose a name Klyro would refuse to scan', async () => {
    // `.test` is a reserved suffix. Even if it answered, it is not a target.
    withDns({ 'acme.test|A': { answers: ['203.0.113.5'] } });

    const result = await preflightDomainCheck('acme.invalid', resolver);

    expect(result.suggestion).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ *
 * Not breaking the legitimate cases
 * ------------------------------------------------------------------ */

describe('domains that must not be blocked', () => {
  it('passes a domain that answers NOERROR with no address at all', async () => {
    /*
     * This is the case that a first pass got wrong, and it is worth stating
     * precisely because the two look identical from the outside.
     *
     * emiratesnbd.ae has a delegated zone — four Route 53 nameservers — and
     * publishes no A and no AAAA at the apex. Its A query returns NOERROR with
     * an empty answer section, not NXDOMAIN. The name exists. Deciding
     * existence from "does it have an A record" refuses it, which would block
     * a real bank's real domain to catch a typo.
     */
    withDns({
      'emiratesnbd.ae|A': { status: 0, answers: [] },
      'emiratesnbd.ae|AAAA': { status: 0, answers: [] },
    });

    const result = await preflightDomainCheck('emiratesnbd.ae', resolver);

    expect(result.exists).toBe(true);
    expect(result.hasARecord).toBe(false);
    expect(result.suggestion).toBeUndefined();
  });

  it('passes when only one family answers NOERROR', async () => {
    // Half an answer is still an answer: the name is in the DNS.
    withDns({ 'partial.ae|A': { status: 0, answers: [] } });

    expect((await preflightDomainCheck('partial.ae', resolver)).exists).toBe(true);
  });

  it('fails open when no resolver answers, rather than refusing the scan', async () => {
    // A network blip must not be reported to the reader as a domain that does
    // not exist. `status` is null here, which is not NXDOMAIN.
    withDns({
      'flaky.ae|A': { fail: true },
      'flaky.ae|AAAA': { fail: true },
    });

    expect((await preflightDomainCheck('flaky.ae', resolver)).exists).toBe(true);
  });

  it('passes a redirect domain that does publish an apex address', async () => {
    withDns({ 'redirects.ae|A': { answers: ['203.0.113.42'] } });

    const result = await preflightDomainCheck('redirects.ae', resolver);

    expect(result.exists).toBe(true);
  });

  it('adds no DNS queries when the caller already resolved the name', async () => {
    const stub = withDns({});

    const result = await preflightDomainCheck('github.com', resolver, ['140.82.121.4']);

    expect(result).toMatchObject({ exists: true, hasARecord: true });
    // The scan route resolves A and AAAA a moment earlier for SSRF screening.
    // Re-asking would put latency on every scan to catch a rare typo.
    expect(stub.questions).toEqual([]);
  });

  it('reads address families correctly from handed-through addresses', async () => {
    withDns({});

    const result = await preflightDomainCheck('example.com', resolver, ['2606:4700::1111']);

    expect(result).toMatchObject({ exists: true, hasARecord: false, hasAAAARecord: true });
  });

  it('re-queries when the handed-through list is empty, rather than assuming absence', async () => {
    /*
     * An empty address list from the SSRF screening is exactly the ambiguous
     * case — it covers both NXDOMAIN and a delegated zone with no apex record.
     * Treating it as absence would reintroduce the emiratesnbd.ae bug through
     * the fast path.
     */
    const stub = withDns({ 'noapex.ae|A': { status: 0, answers: [] } });

    const result = await preflightDomainCheck('noapex.ae', resolver, []);

    expect(result.exists).toBe(true);
    expect(stub.questions.length).toBeGreaterThan(0);
  });

  it('still reports a genuinely missing name when the list is empty', async () => {
    withDns({});

    expect((await preflightDomainCheck('nothing-here.ae', resolver, [])).exists).toBe(false);
  });
});
