import { afterEach, describe, expect, it, vi } from 'vitest';

import { checkEmailSecurity } from '@/lib/checks/email-security';

import { stubFetch, txt, type DnsTable } from './helpers/dns';

/**
 * Precision in the combined email-authentication finding.
 *
 * Two independent reviewers flagged the same overstatement: a domain
 * publishing SPF `-all` was being told that "nothing" instructs receivers to
 * reject forged mail. That is wrong, and wrong in a way that costs trust —
 * the person reading it configured SPF and knows it.
 *
 * The real gap is narrower. SPF authenticates the envelope sender used during
 * delivery; the `From:` header a recipient actually reads is unconstrained by
 * it, and DMARC is the only mechanism that ties the two together. These tests
 * hold the wording to that distinction in both directions: it must not
 * overstate the gap when SPF is doing its job, and must not understate it when
 * genuinely nothing is published.
 */

const DOMAIN = 'example.com';

afterEach(() => {
  vi.unstubAllGlobals();
});

interface Setup {
  spf?: string | null;
  dmarc?: string | null;
}

function zone({ spf = null, dmarc = null }: Setup): DnsTable {
  const table: DnsTable = {
    [`${DOMAIN}|MX`]: { answers: ['10 mail.example.com.'] },
  };
  if (spf) table[`${DOMAIN}|TXT`] = txt(spf);
  if (dmarc) table[`_dmarc.${DOMAIN}|TXT`] = txt(dmarc);
  return table;
}

async function combinedFinding(setup: Setup) {
  stubFetch({ dns: zone(setup), unmatched: 'fail' });
  const out = await checkEmailSecurity(DOMAIN);
  return out.findings.find(
    (f) =>
      f.title === 'Nothing published instructs receivers to reject forged mail' ||
      f.title === 'SPF rejects forged senders, but nothing covers the visible From address',
  );
}

/* ------------------------------------------------------------------ *
 * The flagged case: SPF -all, no DMARC
 * ------------------------------------------------------------------ */

describe('SPF hard-fail with no DMARC', () => {
  it('does not claim that nothing instructs receivers to reject', async () => {
    const finding = await combinedFinding({ spf: 'v=spf1 include:_spf.example.net -all' });

    expect(finding).toBeDefined();
    // The exact sentence both reviewers objected to.
    expect(finding!.title).not.toBe('Nothing published instructs receivers to reject forged mail');
    expect(finding!.interpretation).not.toMatch(/publishes no such instruction/i);
  });

  it('credits SPF for what it actually does', async () => {
    const finding = await combinedFinding({ spf: 'v=spf1 -all' });

    expect(finding!.interpretation).toMatch(/hard-fail|-all/);
    expect(finding!.interpretation).toMatch(/does instruct receiving servers to reject/i);
  });

  it('names the envelope sender as the thing SPF covers', async () => {
    const finding = await combinedFinding({ spf: 'v=spf1 -all' });

    expect(finding!.interpretation).toMatch(/envelope sender/i);
    expect(finding!.interpretation).toMatch(/a recipient never sees|never sees/i);
  });

  it('names the visible From address as the thing that is still open', async () => {
    const finding = await combinedFinding({ spf: 'v=spf1 -all' });

    expect(finding!.interpretation).toMatch(/From address/i);
    expect(finding!.risk).toMatch(/visible From header|From header/i);
    expect(finding!.risk).toMatch(/DMARC closes|gap DMARC/i);
  });

  it('keeps the severity, because the gap is real', async () => {
    const finding = await combinedFinding({ spf: 'v=spf1 -all' });

    // The fix is about precision of language, not about softening the finding.
    expect(finding!.severity).toBe('high');
  });

  it('recommends the shorter path rather than telling them to add SPF again', async () => {
    const finding = await combinedFinding({ spf: 'v=spf1 -all' });

    expect(finding!.recommendation).toMatch(/SPF half is already done/i);
    expect(finding!.recommendation).toMatch(/p=none/);
  });
});

/* ------------------------------------------------------------------ *
 * Neither published — the original wording is correct here
 * ------------------------------------------------------------------ */

describe('neither SPF nor DMARC', () => {
  it('keeps the stronger claim, because it is accurate', async () => {
    const finding = await combinedFinding({});

    expect(finding!.title).toBe('Nothing published instructs receivers to reject forged mail');
    expect(finding!.interpretation).toMatch(/Neither SPF nor DMARC is published/i);
  });

  it('states that neither the envelope nor the visible address is covered', async () => {
    const finding = await combinedFinding({});

    expect(finding!.interpretation).toMatch(/envelope/i);
    expect(finding!.interpretation).toMatch(/From address/i);
    expect(finding!.severity).toBe('high');
  });

  it('does not credit SPF protection that is not there', async () => {
    const finding = await combinedFinding({});

    expect(finding!.interpretation).not.toMatch(/does instruct receiving servers to reject/i);
    expect(finding!.recommendation).not.toMatch(/already done/i);
  });
});

/* ------------------------------------------------------------------ *
 * Soft fail — in between, and worded proportionally
 * ------------------------------------------------------------------ */

describe('SPF soft-fail with no DMARC', () => {
  it('describes ~all as a hint rather than an instruction', async () => {
    const finding = await combinedFinding({ spf: 'v=spf1 include:_spf.example.net ~all' });

    expect(finding!.interpretation).toMatch(/~all/);
    expect(finding!.interpretation).toMatch(/mark it rather than refuse|hint, not an instruction/i);
  });

  it('does not claim the hard-fail credit', async () => {
    const finding = await combinedFinding({ spf: 'v=spf1 ~all' });

    expect(finding!.interpretation).not.toMatch(/hard-fail/i);
  });
});

/* ------------------------------------------------------------------ *
 * Enforcing DMARC — no finding at all
 * ------------------------------------------------------------------ */

describe('DMARC enforcing', () => {
  it('raises no combined finding when the policy rejects', async () => {
    const finding = await combinedFinding({
      spf: 'v=spf1 -all',
      dmarc: 'v=DMARC1; p=reject; rua=mailto:d@example.com',
    });

    expect(finding).toBeUndefined();
  });

  it('raises no combined finding when the policy quarantines', async () => {
    const finding = await combinedFinding({
      spf: 'v=spf1 -all',
      dmarc: 'v=DMARC1; p=quarantine; rua=mailto:d@example.com',
    });

    expect(finding).toBeUndefined();
  });

  it('still raises it when a DMARC record exists but asks for nothing', async () => {
    const finding = await combinedFinding({
      spf: 'v=spf1 -all',
      dmarc: 'v=DMARC1; p=none',
    });

    // p=none publishes no enforcement, so the From-header gap is still open —
    // but SPF still deserves its credit.
    expect(finding).toBeDefined();
    expect(finding!.interpretation).toMatch(/does instruct receiving servers to reject/i);
  });
});
