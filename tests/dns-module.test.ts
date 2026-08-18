import { afterEach, describe, expect, it, vi } from 'vitest';

import { checkDns } from '@/lib/checks/dns';

import { type DnsTable, dnsKey, stubFetch } from './helpers/dns';

const DOMAIN = 'example.test';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A well-configured zone, used as the baseline every case deviates from. */
function healthyZone(overrides: DnsTable = {}): DnsTable {
  return {
    [dnsKey(DOMAIN, 'A')]: { answers: ['192.0.2.1'], ad: true },
    [dnsKey(DOMAIN, 'AAAA')]: { answers: ['2001:db8::1'] },
    [dnsKey(DOMAIN, 'MX')]: { answers: ['10 mail.example.test.'] },
    // Two *operators*, not just two hosts. A zone whose nameservers all sit
    // under one registrable domain now gives up points for the missing
    // secondary provider, so a baseline that scores 100 has to span two.
    [dnsKey(DOMAIN, 'NS')]: { answers: ['ns1.example.test.', 'ns1.dns-secondary.test.'] },
    [dnsKey(DOMAIN, 'TXT')]: { answers: ['"v=spf1 -all"'] },
    [dnsKey(DOMAIN, 'SOA')]: {
      answers: ['ns1.example.test. admin.example.test. 2024010101 7200 3600 1209600 86400'],
    },
    [dnsKey(DOMAIN, 'CAA')]: { answers: ['0 issue "letsencrypt.org"'] },
    [dnsKey('ns1.example.test', 'A')]: { answers: ['192.0.2.10'] },
    [dnsKey('ns1.dns-secondary.test', 'A')]: { answers: ['192.0.2.11'] },
    ...overrides,
  };
}

function titles(findings: { title: string }[]): string[] {
  return findings.map((f) => f.title);
}

describe('DNSSEC', () => {
  it('credits a signed zone when the resolver sets the AD flag', async () => {
    stubFetch({ dns: healthyZone() });
    const out = await checkDns(DOMAIN);

    const line = out.scoreBreakdown?.find((l) => l.label === 'DNSSEC signing');
    expect(line).toMatchObject({ value: 25, assessed: true });
    expect(out.details.find((d) => d.label === 'DNSSEC')?.value).toBe('Signed and validating');
  });

  it('reports an unsigned zone at low severity without claiming tampering', async () => {
    stubFetch({ dns: healthyZone({ [dnsKey(DOMAIN, 'A')]: { answers: ['192.0.2.1'], ad: false } }) });
    const out = await checkDns(DOMAIN);

    const finding = out.findings.find((f) => f.title === 'DNS records are not signed with DNSSEC');
    expect(finding?.severity).toBe('low');
    // The exact overclaim this replaced: "an attacker could send your customers
    // to a fake version of your website".
    expect(finding?.risk).toMatch(/observed no evidence of any such tampering/i);
    expect(finding?.risk).toMatch(/absence of a defence, not an attack/i);
  });

  it('distinguishes signed-but-broken from never-signed using the DS record', async () => {
    stubFetch({
      dns: healthyZone({
        [dnsKey(DOMAIN, 'A')]: { answers: ['192.0.2.1'], ad: false },
        [dnsKey(DOMAIN, 'DS')]: { answers: ['12345 13 2 abcdef'] },
      }),
    });
    const out = await checkDns(DOMAIN);

    const finding = out.findings.find(
      (f) => f.title === 'DNSSEC is published but the chain did not authenticate',
    );
    expect(finding?.severity).toBe('high');
  });

  it('excludes DNSSEC from the score when the probe does not resolve', async () => {
    stubFetch({
      dns: healthyZone({
        // The DNSSEC probe is a separate A query with do=1; failing every A
        // query would break the module, so the DS lookup is what fails here.
        [dnsKey(DOMAIN, 'A')]: { answers: ['192.0.2.1'], ad: false },
        [dnsKey(DOMAIN, 'DS')]: { fail: true },
      }),
    });
    const out = await checkDns(DOMAIN);

    const line = out.scoreBreakdown?.find((l) => l.label === 'DNSSEC signing');
    expect(line?.assessed).toBe(false);
    expect(titles(out.findings)).toContain('DNSSEC status could not be determined');
    expect(out.moduleCoverage).toBeLessThan(1);
  });
});

describe('wildcard DNS', () => {
  it('detects a wildcard and says it qualifies the rest of the report', async () => {
    // Any name under the domain resolves, which is what a wildcard means.
    const dns = healthyZone();
    const originalKeys = new Set(Object.keys(dns));
    const { questions } = stubFetch({
      dns: new Proxy(dns, {
        get(target, prop: string) {
          if (originalKeys.has(prop)) return target[prop];
          if (typeof prop === 'string' && prop.startsWith('klyro-wildcard-')) {
            return { answers: ['192.0.2.99'] };
          }
          return target[prop];
        },
        has(target, prop: string) {
          return originalKeys.has(prop) || String(prop).startsWith('klyro-wildcard-');
        },
      }),
    });

    const out = await checkDns(DOMAIN);

    expect(questions.some((q) => q.startsWith('klyro-wildcard-'))).toBe(true);
    const finding = out.findings.find(
      (f) => f.title === 'Zone answers for host names that were never defined',
    );
    expect(finding?.severity).toBe('info');
    expect(finding?.risk).toMatch(/no longer evidence that a system exists/i);
  });

  it('reports no wildcard when a random name returns NXDOMAIN', async () => {
    stubFetch({ dns: healthyZone() });
    const out = await checkDns(DOMAIN);

    expect(out.details.find((d) => d.label === 'Wildcard DNS')?.value).toMatch(/Not present/);
  });
});

describe('CAA', () => {
  it('credits a published CAA record', async () => {
    stubFetch({ dns: healthyZone() });
    const out = await checkDns(DOMAIN);

    const line = out.scoreBreakdown?.find((l) => l.label.startsWith('Certificate issuance'));
    expect(line).toMatchObject({ value: 10, assessed: true });
    expect(out.details.find((d) => d.label.startsWith('Certificate issuance'))?.value).toBe(
      'letsencrypt.org',
    );
  });

  it('reports an absent CAA record as a missing constraint, not an incident', async () => {
    stubFetch({ dns: healthyZone({ [dnsKey(DOMAIN, 'CAA')]: { status: 0, answers: [] } }) });
    const out = await checkDns(DOMAIN);

    const finding = out.findings.find(
      (f) => f.title === 'No CAA record restricts who may issue certificates',
    );
    expect(finding?.severity).toBe('low');
    expect(finding?.risk).toMatch(/no evidence of mis-issuance/i);
  });

  it('excludes CAA from the score when the lookup fails', async () => {
    stubFetch({ dns: healthyZone({ [dnsKey(DOMAIN, 'CAA')]: { fail: true } }) });
    const out = await checkDns(DOMAIN);

    expect(out.scoreBreakdown?.find((l) => l.label.startsWith('Certificate issuance'))?.assessed).toBe(
      false,
    );
  });
});

describe('nameservers', () => {
  it('flags a delegation naming a nameserver that does not resolve', async () => {
    stubFetch({
      dns: healthyZone({ [dnsKey('ns1.dns-secondary.test', 'A')]: { status: 0, answers: [] } }),
    });
    const out = await checkDns(DOMAIN);

    const finding = out.findings.find(
      (f) => f.title === 'A published nameserver does not resolve to an address',
    );
    expect(finding?.severity).toBe('medium');
    expect(finding?.confidence).toBe('high');
  });

  it('flags a single-nameserver delegation', async () => {
    stubFetch({
      dns: healthyZone({ [dnsKey(DOMAIN, 'NS')]: { answers: ['ns1.example.test.'] } }),
    });
    const out = await checkDns(DOMAIN);

    expect(titles(out.findings)).toContain('Only one nameserver is published for this domain');
  });
});

/* ------------------------------------------------------------------ *
 * Operator diversity
 *
 * Two nameservers protect against one machine failing. Two *operators*
 * protect against one company failing. The distinction is the whole point of
 * this check, and it is deliberately low severity — self-hosting DNS on
 * genuinely redundant infrastructure is a normal, defensible choice.
 * ------------------------------------------------------------------ */

describe('nameserver operator diversity', () => {
  /** Both nameservers under one registrable domain, as bosch.de is for boschaishield.com. */
  function singleOperatorZone() {
    return healthyZone({
      [dnsKey(DOMAIN, 'NS')]: { answers: ['gwa.fe.bosch.test.', 'gwa2.fe.bosch.test.'] },
      [dnsKey('gwa.fe.bosch.test', 'A')]: { answers: ['192.0.2.20'] },
      [dnsKey('gwa2.fe.bosch.test', 'A')]: { answers: ['192.0.2.21'] },
    });
  }

  it('groups nameservers by registrable domain rather than by hostname', async () => {
    stubFetch({ dns: singleOperatorZone() });
    const out = await checkDns(DOMAIN);

    const finding = out.findings.find(
      (f) => f.title === 'All nameservers are operated by a single provider',
    );
    expect(finding?.severity).toBe('low');
    expect(finding?.observed).toContain('bosch.test');
  });

  it('holds back four of twenty points, not more', async () => {
    stubFetch({ dns: singleOperatorZone() });
    const out = await checkDns(DOMAIN);

    const line = out.scoreBreakdown?.find((l) => l.label === 'Nameserver resilience');
    expect(line).toMatchObject({ value: 16, max: 20, assessed: true });
    // Low severity has to mean a low deduction, or the label is decoration.
    expect(out.score).toBeGreaterThanOrEqual(95);
  });

  it('raises nothing when the nameservers span two operators', async () => {
    stubFetch({ dns: healthyZone() });
    const out = await checkDns(DOMAIN);

    expect(titles(out.findings)).not.toContain(
      'All nameservers are operated by a single provider',
    );
    expect(out.scoreBreakdown?.find((l) => l.label === 'Nameserver resilience')?.value).toBe(20);
  });

  it('says the operator looks like the domain owner when it does', async () => {
    stubFetch({
      dns: healthyZone({
        [dnsKey(DOMAIN, 'NS')]: { answers: ['ns1.example.test.', 'ns2.example.test.'] },
        [dnsKey('ns1.example.test', 'A')]: { answers: ['192.0.2.10'] },
        [dnsKey('ns2.example.test', 'A')]: { answers: ['192.0.2.11'] },
      }),
    });
    const out = await checkDns(DOMAIN);

    const finding = out.findings.find(
      (f) => f.title === 'All nameservers are operated by a single provider',
    );
    expect(finding?.interpretation).toMatch(/self-hosted DNS/i);
  });

  /*
   * The case that made the check wrong before it was fixed.
   *
   * Route 53 publishes one hosted zone's nameservers across four TLDs on
   * purpose. Grouping by registrable domain counted netflix.com as having four
   * independent DNS operators and github.com as five — the opposite of the
   * truth, and a reader could reasonably have concluded those domains had
   * multiple independent suppliers.
   */
  it('counts one managed provider spread across four TLDs as one operator', async () => {
    stubFetch({
      dns: healthyZone({
        [dnsKey(DOMAIN, 'NS')]: {
          answers: [
            'ns-81.awsdns-10.com.',
            'ns-659.awsdns-18.net.',
            'ns-1372.awsdns-43.org.',
            'ns-1984.awsdns-56.co.uk.',
          ],
        },
        [dnsKey('ns-81.awsdns-10.com', 'A')]: { answers: ['192.0.2.30'] },
        [dnsKey('ns-659.awsdns-18.net', 'A')]: { answers: ['192.0.2.31'] },
        [dnsKey('ns-1372.awsdns-43.org', 'A')]: { answers: ['192.0.2.32'] },
        [dnsKey('ns-1984.awsdns-56.co.uk', 'A')]: { answers: ['192.0.2.33'] },
      }),
    });
    const out = await checkDns(DOMAIN);

    expect(out.details.find((d) => d.label === 'Nameserver operators')?.value).toBe(
      '1 — Amazon Route 53',
    );
    expect(titles(out.findings)).toContain('All nameservers are operated by a single provider');
  });

  it('recognises a genuine second provider alongside the first', async () => {
    stubFetch({
      dns: healthyZone({
        [dnsKey(DOMAIN, 'NS')]: {
          answers: ['ns-81.awsdns-10.com.', 'dns1.p08.nsone.net.'],
        },
        [dnsKey('ns-81.awsdns-10.com', 'A')]: { answers: ['192.0.2.30'] },
        [dnsKey('dns1.p08.nsone.net', 'A')]: { answers: ['192.0.2.40'] },
      }),
    });
    const out = await checkDns(DOMAIN);

    expect(out.details.find((d) => d.label === 'Nameserver operators')?.value).toBe(
      '2 — Amazon Route 53, NS1',
    );
    expect(titles(out.findings)).not.toContain(
      'All nameservers are operated by a single provider',
    );
  });

  it('does not call a managed provider self-hosted', async () => {
    stubFetch({
      dns: healthyZone({
        [dnsKey(DOMAIN, 'NS')]: { answers: ['a.ns.cloudflare.com.', 'b.ns.cloudflare.com.'] },
        [dnsKey('a.ns.cloudflare.com', 'A')]: { answers: ['192.0.2.50'] },
        [dnsKey('b.ns.cloudflare.com', 'A')]: { answers: ['192.0.2.51'] },
      }),
    });
    const out = await checkDns(DOMAIN);

    const finding = out.findings.find(
      (f) => f.title === 'All nameservers are operated by a single provider',
    );
    expect(finding?.interpretation).not.toMatch(/self-hosted/i);
  });

  it('does not draw the conclusion from a single nameserver', async () => {
    stubFetch({
      dns: healthyZone({ [dnsKey(DOMAIN, 'NS')]: { answers: ['ns1.example.test.'] } }),
    });
    const out = await checkDns(DOMAIN);

    // One nameserver is already reported as having no redundancy at all.
    // Adding "and they are all one operator" on top would be double counting.
    expect(titles(out.findings)).not.toContain(
      'All nameservers are operated by a single provider',
    );
  });
});

/* ------------------------------------------------------------------ *
 * IPv6
 * ------------------------------------------------------------------ */

describe('IPv6', () => {
  it('reports absence as information and takes no points for it', async () => {
    const withIpv6 = await (async () => {
      stubFetch({ dns: healthyZone() });
      return checkDns(DOMAIN);
    })();

    vi.unstubAllGlobals();

    stubFetch({
      dns: healthyZone({ [dnsKey(DOMAIN, 'AAAA')]: { status: 0, answers: [] } }),
    });
    const withoutIpv6 = await checkDns(DOMAIN);

    const finding = withoutIpv6.findings.find(
      (f) => f.title === 'No IPv6 address record is published',
    );
    expect(finding?.severity).toBe('info');
    expect(finding?.risk).toMatch(/None is claimed/i);

    // The scored half: absence of IPv6 must cost exactly nothing.
    expect(withoutIpv6.score).toBe(withIpv6.score);
  });

  it('stays quiet when www carries IPv6 even though the apex does not', async () => {
    stubFetch({
      dns: healthyZone({
        [dnsKey(DOMAIN, 'AAAA')]: { status: 0, answers: [] },
        [dnsKey(`www.${DOMAIN}`, 'AAAA')]: { answers: ['2001:db8::2'] },
      }),
    });
    const out = await checkDns(DOMAIN);

    expect(titles(out.findings)).not.toContain('No IPv6 address record is published');
  });
});

describe('mail routing', () => {
  it('recognises a null MX as a deliberate declaration', async () => {
    stubFetch({ dns: healthyZone({ [dnsKey(DOMAIN, 'MX')]: { answers: ['0 .'] } }) });
    const out = await checkDns(DOMAIN);

    expect(out.details.find((d) => d.label === 'Mail routing (MX)')?.value).toMatch(/Null MX/);
    expect(out.scoreBreakdown?.find((l) => l.label === 'Mail routing declared')?.value).toBe(7);
  });

  it('excludes mail routing from the score when the MX lookup fails', async () => {
    stubFetch({ dns: healthyZone({ [dnsKey(DOMAIN, 'MX')]: { fail: true } }) });
    const out = await checkDns(DOMAIN);

    expect(out.scoreBreakdown?.find((l) => l.label === 'Mail routing declared')?.assessed).toBe(false);
    expect(titles(out.findings)).not.toContain('No mail routing is published for this domain');
  });
});

describe('module failure', () => {
  it('throws rather than scoring when the zone does not answer at all', async () => {
    stubFetch({
      dns: {
        [dnsKey(DOMAIN, 'A')]: { fail: true },
        [dnsKey(DOMAIN, 'NS')]: { fail: true },
        [dnsKey(DOMAIN, 'SOA')]: { fail: true },
      },
    });

    await expect(checkDns(DOMAIN)).rejects.toThrow(/No DNS resolver answered/);
  });
});

describe('score explainability', () => {
  it('publishes a breakdown line for every component', async () => {
    stubFetch({ dns: healthyZone() });
    const out = await checkDns(DOMAIN);

    expect(out.scoreBreakdown).toBeDefined();
    const total = out.scoreBreakdown!.reduce((sum, l) => sum + l.max, 0);
    expect(total).toBe(100);
    for (const line of out.scoreBreakdown!) {
      expect(line.note, line.label).toBeTruthy();
    }
  });

  it('scores a fully healthy zone at 100', async () => {
    stubFetch({ dns: healthyZone() });
    const out = await checkDns(DOMAIN);

    expect(out.score).toBe(100);
    expect(out.moduleCoverage).toBe(1);
  });
});
