import { afterEach, describe, expect, it, vi } from 'vitest';

import { checkEmailSecurity } from '@/lib/checks/email-security';

import { type DnsTable, dnsKey, stubFetch, txt } from './helpers/dns';

/**
 * The SPF / DKIM / DMARC matrix.
 *
 * Two properties are asserted throughout, beyond the individual cases: an
 * unconfirmable DKIM never costs points, and a resolver failure never becomes
 * a "not published" finding.
 */

const DOMAIN = 'example.test';

afterEach(() => {
  vi.unstubAllGlobals();
});

function table(overrides: DnsTable): DnsTable {
  return {
    [dnsKey(DOMAIN, 'TXT')]: txt('v=spf1 -all'),
    [dnsKey(`_dmarc.${DOMAIN}`, 'TXT')]: txt('v=DMARC1; p=reject; rua=mailto:d@example.test'),
    ...overrides,
  };
}

function titles(findings: { title: string }[]): string[] {
  return findings.map((f) => f.title);
}

describe('SPF default rule', () => {
  it('scores -all at full marks with no finding', async () => {
    stubFetch({ dns: table({}) });
    const out = await checkEmailSecurity(DOMAIN);

    expect(out.score).toBe(100);
    expect(titles(out.findings)).not.toContain('No SPF record is published');
    const spfLine = out.scoreBreakdown?.find((l) => l.label === 'SPF policy');
    expect(spfLine).toMatchObject({ value: 25, max: 25, assessed: true });
  });

  it('treats ~all as a low-severity observation, not a failure', async () => {
    stubFetch({ dns: table({ [dnsKey(DOMAIN, 'TXT')]: txt('v=spf1 include:a.test ~all') }) });
    const out = await checkEmailSecurity(DOMAIN);

    const finding = out.findings.find((f) => f.title === 'SPF ends in soft fail rather than hard fail');
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe('low');
    expect(finding?.confidence).toBe('high');
    // The interpretation has to acknowledge that DMARC does the enforcing.
    expect(finding?.interpretation).toMatch(/DMARC/);
  });

  it('reports ?all as neutral at medium severity', async () => {
    stubFetch({ dns: table({ [dnsKey(DOMAIN, 'TXT')]: txt('v=spf1 ?all') }) });
    const out = await checkEmailSecurity(DOMAIN);

    const finding = out.findings.find((f) => f.title === 'SPF default rule is neutral');
    expect(finding?.severity).toBe('medium');
  });

  it('reports +all as high severity', async () => {
    stubFetch({ dns: table({ [dnsKey(DOMAIN, 'TXT')]: txt('v=spf1 +all') }) });
    const out = await checkEmailSecurity(DOMAIN);

    const finding = out.findings.find((f) => f.title === 'SPF record authorises every sending host');
    expect(finding?.severity).toBe('high');
    expect(out.score).toBeLessThan(80);
  });

  it('follows redirect= to the record that supplies the default rule', async () => {
    stubFetch({
      dns: table({
        [dnsKey(DOMAIN, 'TXT')]: txt('v=spf1 redirect=_spf.example.test'),
        [dnsKey('_spf.example.test', 'TXT')]: txt('v=spf1 ip4:192.0.2.0/24 -all'),
      }),
    });
    const out = await checkEmailSecurity(DOMAIN);

    // The regression this guards: a redirect-only record used to be reported as
    // "no explicit default rule" and marked down, on domains that are correct.
    expect(titles(out.findings)).not.toContain('SPF record specifies no default rule');
    const detail = out.details.find((d) => d.label === 'SPF default rule');
    expect(detail?.value).toMatch(/-all \(via redirect to _spf\.example\.test\)/);
    expect(out.score).toBe(100);
  });

  it('reports a record with neither all nor redirect as having no default rule', async () => {
    stubFetch({ dns: table({ [dnsKey(DOMAIN, 'TXT')]: txt('v=spf1 ip4:192.0.2.0/24') }) });
    const out = await checkEmailSecurity(DOMAIN);

    expect(titles(out.findings)).toContain('SPF record specifies no default rule');
  });

  it('reports duplicate SPF records as a permerror', async () => {
    stubFetch({
      dns: table({ [dnsKey(DOMAIN, 'TXT')]: txt('v=spf1 -all', 'v=spf1 include:b.test ~all') }),
    });
    const out = await checkEmailSecurity(DOMAIN);

    const finding = out.findings.find((f) => f.title === 'More than one SPF record is published');
    expect(finding?.severity).toBe('high');
    expect(finding?.interpretation).toMatch(/permerror/i);
  });

  it('reports a missing SPF record at high severity, not critical', async () => {
    stubFetch({ dns: table({ [dnsKey(DOMAIN, 'TXT')]: { status: 0, answers: [] } }) });
    const out = await checkEmailSecurity(DOMAIN);

    const finding = out.findings.find((f) => f.title === 'No SPF record is published');
    expect(finding?.severity).toBe('high');
    // SPF absence is a "none" result at the receiver, not a rejection — the
    // copy must not claim otherwise.
    expect(finding?.interpretation).toMatch(/not a failure/i);
  });
});

describe('SPF lookup budget', () => {
  it('counts lookups and stays quiet below the limit', async () => {
    stubFetch({
      dns: table({
        [dnsKey(DOMAIN, 'TXT')]: txt('v=spf1 include:a.test include:b.test -all'),
        [dnsKey('a.test', 'TXT')]: txt('v=spf1 ip4:192.0.2.0/24 -all'),
        [dnsKey('b.test', 'TXT')]: txt('v=spf1 ip4:198.51.100.0/24 -all'),
      }),
    });
    const out = await checkEmailSecurity(DOMAIN);

    expect(out.details.find((d) => d.label === 'SPF DNS lookups')?.value).toBe('2 of 10');
    expect(titles(out.findings)).not.toContain('SPF evaluation exceeds the ten-lookup limit');
  });

  it('asserts an RFC breach only when the traversal completed', async () => {
    const includes = Array.from({ length: 12 }, (_, i) => `include:x${i}.test`).join(' ');
    const nested: DnsTable = {};
    for (let i = 0; i < 12; i += 1) {
      nested[dnsKey(`x${i}.test`, 'TXT')] = txt('v=spf1 ip4:192.0.2.0/24 -all');
    }

    stubFetch({ dns: table({ [dnsKey(DOMAIN, 'TXT')]: txt(`v=spf1 ${includes} -all`), ...nested }) });
    const out = await checkEmailSecurity(DOMAIN);

    const finding = out.findings.find((f) => f.title === 'SPF evaluation exceeds the ten-lookup limit');
    expect(finding).toBeDefined();
    expect(finding?.confidence).toBe('high');
    expect(finding?.evidence.verification).toMatch(/terminated naturally/);
  });
});

describe('DMARC policy', () => {
  const dmarcCases: { record: string; title: string; severity: string }[] = [
    { record: 'v=DMARC1; p=quarantine; rua=mailto:d@example.test', title: 'DMARC policy quarantines rather than rejects', severity: 'low' },
    { record: 'v=DMARC1; p=none; rua=mailto:d@example.test', title: 'DMARC policy requests no action on failing mail', severity: 'medium' },
    { record: 'v=DMARC1; rua=mailto:d@example.test', title: 'DMARC record declares no valid policy', severity: 'medium' },
  ];

  for (const testCase of dmarcCases) {
    it(`classifies "${testCase.record}"`, async () => {
      stubFetch({ dns: table({ [dnsKey(`_dmarc.${DOMAIN}`, 'TXT')]: txt(testCase.record) }) });
      const out = await checkEmailSecurity(DOMAIN);

      const finding = out.findings.find((f) => f.title === testCase.title);
      expect(finding, `expected a finding titled "${testCase.title}"`).toBeDefined();
      expect(finding?.severity).toBe(testCase.severity);
    });
  }

  it('distinguishes an active p=none rollout from an abandoned one', async () => {
    stubFetch({ dns: table({ [dnsKey(`_dmarc.${DOMAIN}`, 'TXT')]: txt('v=DMARC1; p=none') }) });
    const withoutRua = await checkEmailSecurity(DOMAIN);
    const abandoned = withoutRua.findings.find(
      (f) => f.title === 'DMARC policy requests no action on failing mail',
    );
    expect(abandoned?.interpretation).toMatch(/published and then forgotten/);

    vi.unstubAllGlobals();
    stubFetch({
      dns: table({ [dnsKey(`_dmarc.${DOMAIN}`, 'TXT')]: txt('v=DMARC1; p=none; rua=mailto:d@example.test') }),
    });
    const withRua = await checkEmailSecurity(DOMAIN);
    const rollout = withRua.findings.find(
      (f) => f.title === 'DMARC policy requests no action on failing mail',
    );
    expect(rollout?.interpretation).toMatch(/correct and intended first step/);
  });

  it('reports sp=none as exempting subdomains', async () => {
    stubFetch({
      dns: table({
        [dnsKey(`_dmarc.${DOMAIN}`, 'TXT')]: txt('v=DMARC1; p=reject; sp=none; rua=mailto:d@example.test'),
      }),
    });
    const out = await checkEmailSecurity(DOMAIN);

    expect(titles(out.findings)).toContain('Subdomains are exempted from the DMARC policy');
  });

  it('reduces the DMARC component when pct is below 100', async () => {
    stubFetch({
      dns: table({
        [dnsKey(`_dmarc.${DOMAIN}`, 'TXT')]: txt('v=DMARC1; p=reject; pct=25; rua=mailto:d@example.test'),
      }),
    });
    const out = await checkEmailSecurity(DOMAIN);

    expect(titles(out.findings)).toContain('DMARC policy is applied to a sample of mail only');
    const line = out.scoreBreakdown?.find((l) => l.label === 'DMARC policy');
    expect(line?.value).toBeLessThan(30);
  });

  it('reports the combined posture only when nothing enforces', async () => {
    stubFetch({ dns: table({ [dnsKey(`_dmarc.${DOMAIN}`, 'TXT')]: { status: 0, answers: [] } }) });
    const out = await checkEmailSecurity(DOMAIN);

    const combined = out.findings.find(
      (f) => f.title === 'Nothing published instructs receivers to reject forged mail',
    );
    expect(combined).toBeDefined();
    // The claim is about what the domain publishes, never about what a
    // receiving server would do with a specific message.
    expect(combined?.evidence.limitation).toMatch(/did not send any email/i);
  });

  it('makes no spoofability claim when DMARC is enforcing', async () => {
    stubFetch({ dns: table({}) });
    const out = await checkEmailSecurity(DOMAIN);

    expect(titles(out.findings)).not.toContain(
      'Nothing published instructs receivers to reject forged mail',
    );
  });
});

describe('DKIM', () => {
  it('excludes DKIM from the score when no selector answers', async () => {
    stubFetch({ dns: table({}) });
    const out = await checkEmailSecurity(DOMAIN);

    const line = out.scoreBreakdown?.find((l) => l.label === 'DKIM signing');
    expect(line?.assessed).toBe(false);
    // The whole point: an unknown must not move the number.
    expect(out.score).toBe(100);
    expect(out.moduleCoverage).toBeLessThan(1);

    const finding = out.findings.find((f) => f.title === 'DKIM signing could not be determined');
    expect(finding?.severity).toBe('info');
    expect(finding?.risk).toMatch(/None is claimed/);
  });

  it('scores DKIM when a selector does answer', async () => {
    stubFetch({
      dns: table({
        [dnsKey(`google._domainkey.${DOMAIN}`, 'TXT')]: txt('v=DKIM1; k=rsa; p=MIIBIjANBg'),
      }),
    });
    const out = await checkEmailSecurity(DOMAIN);

    const line = out.scoreBreakdown?.find((l) => l.label === 'DKIM signing');
    expect(line).toMatchObject({ assessed: true, value: 25 });
    expect(out.moduleCoverage).toBe(1);
  });
});

describe('resolver failure', () => {
  it('refuses to report anything when the SPF lookup does not resolve', async () => {
    stubFetch({ dns: table({ [dnsKey(DOMAIN, 'TXT')]: { fail: true } }) });

    // The module throws, which the orchestrator turns into `unavailable` and
    // the composite renormalises around. What must never happen is a finding.
    await expect(checkEmailSecurity(DOMAIN)).rejects.toThrow(/No DNS resolver answered/);
  });

  it('refuses to report anything when the DMARC lookup does not resolve', async () => {
    stubFetch({ dns: table({ [dnsKey(`_dmarc.${DOMAIN}`, 'TXT')]: { fail: true } }) });

    await expect(checkEmailSecurity(DOMAIN)).rejects.toThrow(/No DNS resolver answered/);
  });
});

describe('finding structure', () => {
  it('gives every finding the four-part structure and evidence', async () => {
    stubFetch({ dns: table({ [dnsKey(DOMAIN, 'TXT')]: txt('v=spf1 ?all') }) });
    const out = await checkEmailSecurity(DOMAIN);

    expect(out.findings.length).toBeGreaterThan(0);
    for (const finding of out.findings) {
      expect(finding.observed, finding.title).toBeTruthy();
      expect(finding.interpretation, finding.title).toBeTruthy();
      expect(finding.risk, finding.title).toBeTruthy();
      expect(finding.recommendation, finding.title).toBeTruthy();
      expect(finding.evidence.test, finding.title).toBeTruthy();
      expect(finding.evidence.verification, finding.title).toBeTruthy();
      expect(['high', 'medium', 'low']).toContain(finding.confidence);
    }
  });

  it('produces identical finding ids across two runs of the same input', async () => {
    stubFetch({ dns: table({ [dnsKey(DOMAIN, 'TXT')]: txt('v=spf1 ?all') }) });
    const first = await checkEmailSecurity(DOMAIN);
    vi.unstubAllGlobals();

    stubFetch({ dns: table({ [dnsKey(DOMAIN, 'TXT')]: txt('v=spf1 ?all') }) });
    const second = await checkEmailSecurity(DOMAIN);

    expect(second.findings.map((f) => f.id)).toEqual(first.findings.map((f) => f.id));
  });
});
