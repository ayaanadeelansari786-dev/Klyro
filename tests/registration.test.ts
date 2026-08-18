import { afterEach, describe, expect, it, vi } from 'vitest';

import { checkWhois, parseLockStatus } from '@/lib/checks/whois';
import { registrableDomain, registrableDomainIsCertain } from '@/lib/domain';

import { stubFetch } from './helpers/dns';

/**
 * Domain registration.
 *
 * The validation pass that prompted this work compared Klyro against Verisign
 * RDAP, RIPE RDAP and a third-party WHOIS tool. The expiration date matched
 * across all three; what Klyro was fetching and then throwing away was the EPP
 * status array and the registrar identity. These tests cover the parsing of
 * both, and — more importantly — the two places where the scoring could
 * quietly mislead: a registrar bonus that is really a penalty in disguise, and
 * a domain on hold averaging out to a respectable number.
 */

const DOMAIN = 'example.com';

afterEach(() => {
  vi.unstubAllGlobals();
});

interface RdapOptions {
  status?: string[];
  registrar?: string;
  expiresInDays?: number;
  registeredYearsAgo?: number;
  delegationSigned?: boolean;
  redacted?: boolean;
}

function rdapBody(options: RdapOptions = {}): string {
  const {
    status = ['client transfer prohibited'],
    registrar = 'Example Registrar, LLC',
    expiresInDays = 400,
    registeredYearsAgo = 10,
    delegationSigned = true,
    redacted = true,
  } = options;

  const day = 86_400_000;
  return JSON.stringify({
    ldhName: DOMAIN,
    status,
    secureDNS: { delegationSigned },
    events: [
      {
        eventAction: 'registration',
        eventDate: new Date(Date.now() - registeredYearsAgo * 365 * day).toISOString(),
      },
      {
        eventAction: 'expiration',
        eventDate: new Date(Date.now() + expiresInDays * day).toISOString(),
      },
    ],
    entities: [
      {
        roles: ['registrar'],
        vcardArray: ['vcard', [['fn', {}, 'text', registrar]]],
      },
      {
        roles: ['registrant'],
        vcardArray: [
          'vcard',
          [['fn', {}, 'text', redacted ? 'REDACTED FOR PRIVACY' : 'Jane Example']],
        ],
      },
    ],
    nameservers: [{ ldhName: 'NS1.EXAMPLE.COM' }, { ldhName: 'NS2.EXAMPLE.COM' }],
  });
}

/** Bootstrap answers `primary`; the registry endpoint answers `secondary`. */
function stubRdap(primary: RdapOptions, secondary?: RdapOptions | 'unreachable') {
  stubFetch({
    http: [
      { match: 'rdap.verisign.com', ...(secondary === 'unreachable' ? { status: 503 } : { body: rdapBody(secondary ?? primary) }) },
      { match: 'rdap.org', body: rdapBody(primary) },
      { match: 'rdap.net', ...(secondary === 'unreachable' ? { status: 503 } : { body: rdapBody(secondary ?? primary) }) },
    ],
    unmatched: 'fail',
  });
}

function line(out: Awaited<ReturnType<typeof checkWhois>>, label: string) {
  return out.scoreBreakdown?.find((l) => l.label === label);
}

/* ------------------------------------------------------------------ *
 * EPP status parsing
 * ------------------------------------------------------------------ */

describe('EPP status parsing', () => {
  it('reads the space-separated form RDAP publishes', () => {
    const locks = parseLockStatus([
      'client transfer prohibited',
      'client update prohibited',
      'client delete prohibited',
    ]);

    expect(locks).toMatchObject({
      transferLocked: true,
      updateLocked: true,
      deleteLocked: true,
      onHold: false,
      registryLevel: false,
    });
  });

  it('reads the raw camelCase form some registries return instead', () => {
    // Both spellings appear in the wild. Missing one would silently report a
    // fully locked domain as having no locks at all.
    const locks = parseLockStatus([
      'clientTransferProhibited',
      'serverUpdateProhibited',
      'clientDeleteProhibited',
    ]);

    expect(locks).toMatchObject({
      transferLocked: true,
      updateLocked: true,
      deleteLocked: true,
      registryLevel: true,
    });
  });

  it.each([
    ['clientHold', 'onHold'],
    ['serverHold', 'onHold'],
    ['pendingDelete', 'pendingDeletion'],
    ['pendingTransfer', 'pendingTransfer'],
    ['redemptionPeriod', 'inRedemptionPeriod'],
    ['pendingRestore', 'pendingRestore'],
  ])('recognises %s', (code, flag) => {
    expect(parseLockStatus([code])[flag as keyof ReturnType<typeof parseLockStatus>]).toBe(true);
  });

  it('does not confuse a deletion lock with a pending deletion', () => {
    const locks = parseLockStatus(['clientDeleteProhibited']);
    expect(locks.deleteLocked).toBe(true);
    expect(locks.pendingDeletion).toBe(false);
  });

  it('keeps the codes as published so the report can quote them', () => {
    expect(parseLockStatus(['clientTransferProhibited']).rawStatusCodes).toEqual([
      'clientTransferProhibited',
    ]);
  });
});

/* ------------------------------------------------------------------ *
 * Registrable domain
 * ------------------------------------------------------------------ */

describe('registrable domain', () => {
  it.each([
    ['gwa.fe.bosch.de', 'bosch.de'],
    ['gwa2.fe.bosch.de', 'bosch.de'],
    ['ns1.cloudflare.com', 'cloudflare.com'],
    ['ns-1.awsdns-01.net', 'awsdns-01.net'],
    ['example.com', 'example.com'],
    ['a.b.c.example.co.uk', 'example.co.uk'],
    ['ns1.company.com.au', 'company.com.au'],
  ])('reduces %s to %s', (host, expected) => {
    expect(registrableDomain(host)).toBe(expected);
  });

  it('flags the case the heuristic cannot be trusted on', () => {
    // `co.uk` is in the list, so this is safe.
    expect(registrableDomainIsCertain('ns1.example.co.uk')).toBe(true);
    // `co.zz` is not — and reducing it to `co.zz` would merge two unrelated
    // operators into one, which is exactly the wrong conclusion to publish.
    expect(registrableDomainIsCertain('ns1.example.co.zz')).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Locks and scoring
 * ------------------------------------------------------------------ */

describe('registrar locks', () => {
  it('scores all three locks separately', async () => {
    stubRdap({
      status: ['clientTransferProhibited', 'clientUpdateProhibited', 'clientDeleteProhibited'],
    });
    const out = await checkWhois(DOMAIN);

    expect(line(out, 'Transfer lock')).toMatchObject({ value: 25, max: 25 });
    expect(line(out, 'Update lock')).toMatchObject({ value: 15, max: 15 });
    expect(line(out, 'Deletion lock')).toMatchObject({ value: 15, max: 15 });
    expect(line(out, 'Registry status clear of holds')).toMatchObject({ value: 15 });
  });

  it('states the clean result plainly rather than only describing gaps', async () => {
    stubRdap({
      status: ['clientTransferProhibited', 'clientUpdateProhibited', 'clientDeleteProhibited'],
    });
    const out = await checkWhois(DOMAIN);

    expect(out.summary).toContain(
      'Transfer, update and deletion locks are all enabled at the registry.',
    );
  });

  it('raises one finding per absent lock, at the right severities', async () => {
    stubRdap({ status: ['ok'] });
    const out = await checkWhois(DOMAIN);

    const byTitle = new Map(out.findings.map((f) => [f.title, f]));
    expect(byTitle.get('No transfer lock is set on the domain')?.severity).toBe('medium');
    expect(byTitle.get('No update lock is set on the domain')?.severity).toBe('low');
    expect(byTitle.get('No deletion lock is set on the domain')?.severity).toBe('low');
  });

  it('drops the lock components entirely when the registry publishes no status', async () => {
    stubRdap({ status: [] });
    const out = await checkWhois(DOMAIN);

    // An unknown must never cost a domain points.
    for (const label of ['Transfer lock', 'Update lock', 'Deletion lock']) {
      expect(line(out, label)?.assessed, label).toBe(false);
    }
    expect(out.moduleCoverage).toBeLessThan(1);
    expect(out.findings.map((f) => f.title)).not.toContain('No transfer lock is set on the domain');
  });
});

/* ------------------------------------------------------------------ *
 * Hold states
 * ------------------------------------------------------------------ */

describe('hold and deletion states', () => {
  it('raises a high-severity finding and caps the category', async () => {
    stubRdap({
      status: [
        'clientHold',
        'clientTransferProhibited',
        'clientUpdateProhibited',
        'clientDeleteProhibited',
      ],
    });
    const out = await checkWhois(DOMAIN);

    const finding = out.findings.find(
      (f) => f.title === 'The registry has placed this domain on hold',
    );
    expect(finding?.severity).toBe('high');

    /*
     * The point of the cap. Every lock is set here, so the component score is
     * near perfect — and the domain is still one registry action from not
     * resolving. Averaging the hold against four green components would report
     * it as well managed.
     */
    expect(out.score).toBeLessThanOrEqual(30);
  });

  it('caps a domain in redemption the same way', async () => {
    stubRdap({ status: ['redemptionPeriod', 'clientTransferProhibited'] });
    const out = await checkWhois(DOMAIN);

    expect(out.findings.map((f) => f.title)).toContain(
      'The domain is in the redemption period following expiry',
    );
    expect(out.score).toBeLessThanOrEqual(30);
  });

  it('reports an open transfer without treating it as a breach', async () => {
    stubRdap({ status: ['pendingTransfer', 'clientUpdateProhibited'] });
    const out = await checkWhois(DOMAIN);

    const finding = out.findings.find(
      (f) => f.title === 'A registrar transfer is in progress for this domain',
    );
    expect(finding?.severity).toBe('medium');
    expect(finding?.evidence.limitation).toMatch(/cannot tell who initiated/i);
  });
});

/* ------------------------------------------------------------------ *
 * Registrar recognition
 * ------------------------------------------------------------------ */

describe('registrar recognition', () => {
  const allLocks = [
    'clientTransferProhibited',
    'clientUpdateProhibited',
    'clientDeleteProhibited',
  ];

  it('recognises a corporate registrar and says so', async () => {
    stubRdap({ status: allLocks, registrar: 'CSC Corporate Domains, Inc.' });
    const out = await checkWhois(DOMAIN);

    expect(out.details.find((d) => d.label === 'Registrar')?.value).toMatch(
      /specialising in corporate domain security/i,
    );
    expect(line(out, 'Corporate registrar')?.value).toBe(10);
  });

  it('matches case-insensitively on a substring', async () => {
    stubRdap({ status: allLocks, registrar: 'MARKMONITOR INC.' });
    const out = await checkWhois(DOMAIN);
    expect(line(out, 'Corporate registrar')).toBeDefined();
  });

  /*
   * The one that matters. An earlier version of this module awarded a quarter
   * of the category for being on a list of "reputable registrars", which
   * marked down every domain at a competent smaller registrar for no measured
   * reason. A bonus that is really a penalty in disguise would show up here as
   * an unlisted registrar being unable to reach full marks.
   */
  it('costs an unlisted registrar nothing', async () => {
    stubRdap({ status: allLocks, registrar: 'Some Small Registrar Ltd' });
    const out = await checkWhois(DOMAIN);

    expect(line(out, 'Corporate registrar')).toBeUndefined();
    expect(out.score).toBe(100);
    expect(out.findings.map((f) => f.title).join(' ')).not.toMatch(/registrar/i);
  });

  it('does not let the registrar brand outweigh the locks', async () => {
    stubRdap({ status: ['ok'], registrar: 'CSC Corporate Domains, Inc.' });
    const enterpriseNoLocks = await checkWhois(DOMAIN);
    vi.unstubAllGlobals();

    stubRdap({ status: allLocks, registrar: 'Some Small Registrar Ltd' });
    const unlistedAllLocks = await checkWhois(DOMAIN);

    expect(unlistedAllLocks.score).toBeGreaterThan(enterpriseNoLocks.score);
  });
});

/* ------------------------------------------------------------------ *
 * Cross-verification
 * ------------------------------------------------------------------ */

describe('second RDAP source', () => {
  it('raises confidence to high and says which source confirmed it', async () => {
    stubRdap({ status: ['clientTransferProhibited'], expiresInDays: 20 });
    const out = await checkWhois(DOMAIN);

    const expiry = out.findings.find((f) => f.title === 'Domain registration expires within 30 days');
    expect(expiry?.confidence).toBe('high');
    expect(expiry?.evidence.verification).toMatch(/confirmed against Verisign's own RDAP service/i);
  });

  it('falls back to medium confidence when no second source answers', async () => {
    stubRdap({ status: ['clientTransferProhibited'], expiresInDays: 20 }, 'unreachable');
    const out = await checkWhois(DOMAIN);

    const expiry = out.findings.find((f) => f.title === 'Domain registration expires within 30 days');
    expect(expiry?.confidence).toBe('medium');
    expect(expiry?.evidence.verification).toMatch(/a second source was not reachable/i);
  });

  it('reports a disagreement rather than silently preferring one source', async () => {
    stubRdap(
      { status: ['clientTransferProhibited'], expiresInDays: 400 },
      { status: ['clientTransferProhibited', 'clientUpdateProhibited'], expiresInDays: 400 },
    );
    const out = await checkWhois(DOMAIN);

    const conflict = out.findings.find(
      (f) => f.title === 'Domain registration data differs between RDAP sources queried',
    );
    expect(conflict?.severity).toBe('low');
    expect(conflict?.observed).toMatch(/Status codes/i);
    expect(conflict?.evidence.limitation).toMatch(/cannot establish which source is current/i);
  });

  it('does not overclaim what a second RDAP read establishes', async () => {
    stubRdap({ status: ['clientHold'] });
    const out = await checkWhois(DOMAIN);

    // Two RDAP endpoints both read the same registry database. That is not the
    // independent corroboration two DNS resolvers give, and the report says so
    // rather than borrowing the stronger phrasing.
    const hold = out.findings.find((f) => f.title === 'The registry has placed this domain on hold');
    expect(hold?.evidence.limitation).toMatch(/not independent corroboration/i);
  });
});
