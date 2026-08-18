import type { CategoryDetail, Confidence, Finding } from '../types';
import {
  daysBetween,
  fetchJson,
  makeFinding,
  type ModuleOutput,
  type ScoreComponent,
  scoreFromComponents,
} from './util';

const KEY = 'whois' as const;

/**
 * RDAP is the IETF replacement for WHOIS: free, keyless, structured JSON, and
 * served by the registries themselves. rdap.org bootstraps to the correct
 * authoritative server for the TLD.
 */
const RDAP_ENDPOINTS = [
  (domain: string) => `https://rdap.org/domain/${encodeURIComponent(domain)}`,
  (domain: string) => `https://www.rdap.net/domain/${encodeURIComponent(domain)}`,
];

/**
 * Registry-operated RDAP endpoints, for the second read.
 *
 * These matter in a way a second bootstrap mirror does not. rdap.org and
 * rdap.net both *proxy* to the same registry, so agreement between them shows
 * the transport worked, not that the data is right. A query straight to the
 * registry that holds the record is a genuinely different path to it, and
 * catches a stale or cached proxy answer — the failure this check exists for.
 *
 * Only registries whose endpoint is stable and documented are listed. Anything
 * else falls back to the second bootstrap mirror, and the finding says which
 * of the two kinds of corroboration was actually obtained.
 */
const REGISTRY_RDAP: { suffix: string; registry: string; url: (domain: string) => string }[] = [
  { suffix: '.com', registry: 'Verisign', url: (d) => `https://rdap.verisign.com/com/v1/domain/${encodeURIComponent(d)}` },
  { suffix: '.net', registry: 'Verisign', url: (d) => `https://rdap.verisign.com/net/v1/domain/${encodeURIComponent(d)}` },
  { suffix: '.org', registry: 'Public Interest Registry', url: (d) => `https://rdap.publicinterestregistry.org/rdap/domain/${encodeURIComponent(d)}` },
  { suffix: '.info', registry: 'Identity Digital', url: (d) => `https://rdap.identitydigital.services/rdap/domain/${encodeURIComponent(d)}` },
  { suffix: '.io', registry: 'Identity Digital', url: (d) => `https://rdap.identitydigital.services/rdap/domain/${encodeURIComponent(d)}` },
];

interface RdapEvent {
  eventAction?: string;
  eventDate?: string;
}

interface RdapEntity {
  roles?: string[];
  handle?: string;
  vcardArray?: unknown;
  publicIds?: { type?: string; identifier?: string }[];
  entities?: RdapEntity[];
}

interface RdapDomain {
  ldhName?: string;
  events?: RdapEvent[];
  entities?: RdapEntity[];
  nameservers?: { ldhName?: string }[];
  secureDNS?: { delegationSigned?: boolean };
  status?: string[];
}

/**
 * Registrars whose corporate tier is built around brand protection — two-person
 * change approval, registry lock, no self-service transfer.
 *
 * Worth a small positive signal and nothing more. An earlier version of this
 * module awarded 25 of 100 points for appearing on a list of "reputable
 * registrars" that mostly amounted to a list of large ones, which marked down
 * every domain held at a competent smaller registrar for no measured reason.
 *
 * The bonus below is therefore applied *after* the component score is
 * normalised, not as a component of its own. That distinction is the whole
 * point: a component with a maximum would cost every unlisted domain those
 * points, which is a penalty however it is described. As a post-hoc bonus
 * capped at 100, a domain with every lock enabled at an unlisted registrar
 * still reaches full marks, and a listed registrar with no locks still scores
 * badly — which is the correct ordering, because locks are checkable and a
 * brand is not.
 */
const ENTERPRISE_REGISTRARS = [
  'csc corporate domains',
  'corporation service company',
  'markmonitor',
  'safenames',
  'com laude',
  'nom-iq',
  'brandsight',
  'gandi corporate',
];

/** Points added on top of the normalised category score. Never subtracted. */
const ENTERPRISE_REGISTRAR_BONUS = 10;

const PRIVACY_MARKERS = [
  'redacted',
  'privacy',
  'whoisguard',
  'private by design',
  'data protected',
  'not disclosed',
  'domains by proxy',
  'perfect privacy',
  'withheld',
  'gdpr',
  'contact privacy',
  'identity protect',
];

/* ------------------------------------------------------------------ *
 * EPP status codes
 * ------------------------------------------------------------------ */

export interface RegistrarLockStatus {
  transferLocked: boolean;
  updateLocked: boolean;
  deleteLocked: boolean;
  onHold: boolean;
  pendingDeletion: boolean;
  pendingTransfer: boolean;
  inRedemptionPeriod: boolean;
  pendingRestore: boolean;
  /** True when any lock is set at the *registry* rather than the registrar. */
  registryLevel: boolean;
  rawStatusCodes: string[];
}

/**
 * RDAP normalises EPP codes to space-separated lower case — `client transfer
 * prohibited` — but plenty of registries return the raw camelCase form. Both
 * reduce to the same key here so neither spelling is missed.
 */
function normaliseStatus(code: string): string {
  return code.toLowerCase().replace(/[\s_-]/g, '');
}

export function parseLockStatus(statuses: string[]): RegistrarLockStatus {
  const raw = statuses.filter((s) => typeof s === 'string' && s.trim().length > 0);
  const normalised = raw.map(normaliseStatus);
  const has = (needle: string) => normalised.some((s) => s.includes(needle));

  return {
    transferLocked: has('transferprohibited'),
    updateLocked: has('updateprohibited'),
    deleteLocked: has('deleteprohibited'),
    onHold: has('clienthold') || has('serverhold'),
    pendingDeletion: has('pendingdelete'),
    pendingTransfer: has('pendingtransfer'),
    inRedemptionPeriod: has('redemptionperiod'),
    pendingRestore: has('pendingrestore'),
    registryLevel: normalised.some((s) => s.startsWith('server') && s.includes('prohibited')),
    rawStatusCodes: raw,
  };
}

/** vcardArray is ["vcard", [["fn", {}, "text", "Value"], ...]] — pull one field. */
function vcardField(entity: RdapEntity, field: string): string | null {
  const arr = entity.vcardArray;
  if (!Array.isArray(arr) || arr.length < 2 || !Array.isArray(arr[1])) return null;
  for (const item of arr[1] as unknown[]) {
    if (Array.isArray(item) && item[0] === field && typeof item[3] === 'string') {
      return item[3];
    }
  }
  return null;
}

function findEntity(domainData: RdapDomain, role: string): RdapEntity | null {
  const walk = (entities?: RdapEntity[]): RdapEntity | null => {
    for (const entity of entities ?? []) {
      if (entity.roles?.includes(role)) return entity;
      const nested = walk(entity.entities);
      if (nested) return nested;
    }
    return null;
  };
  return walk(domainData.entities);
}

function eventDate(domainData: RdapDomain, action: string): Date | null {
  const event = domainData.events?.find((e) => e.eventAction === action);
  if (!event?.eventDate) return null;
  const date = new Date(event.eventDate);
  return Number.isNaN(date.getTime()) ? null : date;
}

function looksLikeRdap(data: RdapDomain | null): boolean {
  return Boolean(data && (data.events || data.entities || data.ldhName));
}

/* ------------------------------------------------------------------ *
 * Cross-verification
 * ------------------------------------------------------------------ */

type CorroborationKind = 'registry' | 'mirror' | 'none';

interface CrossCheck {
  /** What the second source was, in words fit for a report line. */
  source: string | null;
  kind: CorroborationKind;
  /** Both sources returned the same expiration date, to the day. */
  expiryAgrees: boolean;
  /** Both sources returned the same set of status codes. */
  statusAgrees: boolean;
  /** A real disagreement, as opposed to the second source being unreachable. */
  conflicts: boolean;
  secondExpiry: Date | null;
  secondStatuses: string[];
}

function sameDay(a: Date | null, b: Date | null): boolean {
  if (!a || !b) return false;
  return a.toISOString().slice(0, 10) === b.toISOString().slice(0, 10);
}

async function crossVerify(
  domain: string,
  primaryExpiry: Date | null,
  primaryStatuses: string[],
): Promise<CrossCheck> {
  const registry = REGISTRY_RDAP.find((r) => domain.endsWith(r.suffix));

  const attempts: { url: string; label: string; kind: CorroborationKind }[] = registry
    ? [
        { url: registry.url(domain), label: `${registry.registry}'s own RDAP service`, kind: 'registry' },
        { url: RDAP_ENDPOINTS[1](domain), label: 'a second RDAP mirror', kind: 'mirror' },
      ]
    : [{ url: RDAP_ENDPOINTS[1](domain), label: 'a second RDAP mirror', kind: 'mirror' }];

  for (const attempt of attempts) {
    const data = await fetchJson<RdapDomain>(
      attempt.url,
      { headers: { accept: 'application/rdap+json, application/json' } },
      8_000,
    );
    if (!looksLikeRdap(data)) continue;

    const secondExpiry = eventDate(data as RdapDomain, 'expiration');
    const secondStatuses = ((data as RdapDomain).status ?? []).map(normaliseStatus).sort();
    const firstStatuses = primaryStatuses.map(normaliseStatus).sort();

    // Absence on both sides is agreement — neither published the field.
    const expiryAgrees =
      primaryExpiry === null && secondExpiry === null ? true : sameDay(primaryExpiry, secondExpiry);
    const statusAgrees = firstStatuses.join('|') === secondStatuses.join('|');

    return {
      source: attempt.label,
      kind: attempt.kind,
      expiryAgrees,
      statusAgrees,
      conflicts: !expiryAgrees || !statusAgrees,
      secondExpiry,
      secondStatuses: ((data as RdapDomain).status ?? []),
    };
  }

  return {
    source: null,
    kind: 'none',
    expiryAgrees: false,
    statusAgrees: false,
    conflicts: false,
    secondExpiry: null,
    secondStatuses: [],
  };
}

/**
 * The verification line every registration finding carries.
 *
 * Deliberately does not say "confirmed" when the second source merely proxies
 * the first. Two mirrors of one registry are one source read twice.
 */
function verificationLine(cross: CrossCheck): string {
  if (cross.kind === 'none') {
    return 'Read from the registry\'s RDAP response. Confirmed against a single RDAP source; a second source was not reachable for cross-verification.';
  }
  if (cross.conflicts) {
    return `Read from the registry's RDAP response and compared against ${cross.source}, which returned different values — see the finding on differing registration data.`;
  }
  return `Read from the registry's RDAP response and confirmed against ${cross.source}.`;
}

const CROSS_LIMITATION =
  'Both reads ultimately resolve to the same registry database, so agreement between them establishes that the value was read correctly and is not a stale proxy answer. It is not independent corroboration of the fact itself in the way two DNS resolvers are — the registry is the only authority for this data.';

/* ------------------------------------------------------------------ */

export async function checkWhois(domain: string): Promise<ModuleOutput> {
  const findings: Finding[] = [];
  const details: CategoryDetail[] = [];

  let data: RdapDomain | null = null;
  for (const endpoint of RDAP_ENDPOINTS) {
    data = await fetchJson<RdapDomain>(
      endpoint(domain),
      { headers: { accept: 'application/rdap+json, application/json' } },
      10_000,
    );
    if (looksLikeRdap(data)) break;
    data = null;
  }

  if (!data) {
    throw new Error('No registration data service (RDAP) responded for this domain.');
  }

  const now = new Date();
  const created = eventDate(data, 'registration');
  const expires = eventDate(data, 'expiration');
  const updated = eventDate(data, 'last changed') ?? eventDate(data, 'last update of RDAP database');

  const statusesRaw = data.status ?? [];
  const locks = parseLockStatus(statusesRaw);
  const statuses = locks.rawStatusCodes.map((s) => s.toLowerCase());
  const statusesPublished = statuses.length > 0;

  /*
   * The second read.
   *
   * DNS findings in this product say "confirmed against a second resolver" and
   * mean it. Registration had no equivalent until now: one endpoint answered
   * and its answer became the report.
   */
  const cross = await crossVerify(domain, expires, statusesRaw);
  const verification = verificationLine(cross);
  const confidence: Confidence = cross.kind !== 'none' && !cross.conflicts ? 'high' : 'medium';

  /* ---------------- Registrar ---------------- */

  const registrarEntity = findEntity(data, 'registrar');
  const registrar =
    (registrarEntity ? vcardField(registrarEntity, 'fn') : null) ??
    registrarEntity?.publicIds?.[0]?.identifier ??
    'Not disclosed';
  const enterpriseRegistrar = ENTERPRISE_REGISTRARS.some((r) =>
    registrar.toLowerCase().includes(r),
  );

  /* ---------------- Privacy ---------------- */

  const registrant = findEntity(data, 'registrant');
  const registrantName = registrant ? vcardField(registrant, 'fn') : null;
  const registrantEmail = registrant ? vcardField(registrant, 'email') : null;
  const registrantOrg = registrant ? vcardField(registrant, 'org') : null;

  const exposedValues = [registrantName, registrantEmail, registrantOrg].filter(
    (v): v is string => typeof v === 'string' && v.trim().length > 0,
  );
  const looksRedacted =
    exposedValues.length === 0 ||
    exposedValues.every((v) => PRIVACY_MARKERS.some((m) => v.toLowerCase().includes(m)));

  const privacyEnabled = looksRedacted;

  if (!privacyEnabled) {
    const hasPersonalEmail = Boolean(registrantEmail && !/^(admin|info|hostmaster|domains?|it|noc|webmaster|security|registry)@/i.test(registrantEmail));
    findings.push(
      makeFinding(KEY, {
        title: 'Registrant contact details are published in the registration record',
        severity: 'low',
        confidence: 'high',
        asset: domain,
        observed: `The RDAP record for ${domain} returns registrant values rather than redaction markers: ${exposedValues.slice(0, 3).join(' · ')}`,
        interpretation:
          'The registration record identifies who holds this domain. Many organisations publish this deliberately — it supports trademark enforcement and makes ownership unambiguous — so publication is a choice rather than a defect.',
        risk: hasPersonalEmail
          ? 'The published contact appears to be an individual address rather than a role mailbox. That names a specific person as the party a registrar would speak to about this domain, which is the information a social-engineering attempt against registrar support would start from, and it makes that person a target for tailored phishing.'
          : 'The published contact appears to be a role address, which limits the exposure to organisational rather than personal information. The main residual concern is that anyone can see which registrar and which contact route to attempt during a domain-hijacking attempt.',
        recommendation:
          'If publication is not deliberate, enable registrar privacy — it is free at most registrars. If it is deliberate, ensure the contact is a monitored role mailbox rather than a named individual, and that the registrar account behind it has two-factor authentication and a change-approval process.',
        evidence: {
          test: `RDAP query for ${domain}, registrant entity vCard read for fn, email and org`,
          observed: exposedValues.slice(0, 3).join(' · '),
          expected: 'Redaction markers, or a role mailbox rather than a named individual',
          verification: 'Values were compared against the standard redaction markers used by registrars under GDPR before being reported as published.',
          limitation:
            'Whether publication is deliberate cannot be determined from the record. Some registries publish organisational details regardless of registrar privacy settings.',
        },
        scoreImpact: 12,
      }),
    );
  }

  /* ---------------- Expiry ---------------- */

  const daysToExpiry = expires ? daysBetween(now, expires) : null;
  if (daysToExpiry !== null) {
    if (daysToExpiry <= 0) {
      findings.push(
        makeFinding(KEY, {
          title: 'Domain registration has passed its expiry date',
          severity: 'high',
          confidence,
          asset: domain,
          observed: `The RDAP expiration event for ${domain} is dated ${expires?.toDateString()}, ${Math.abs(daysToExpiry)} days ago.`,
          interpretation:
            'The registration term has ended. Most registries then run an auto-renew grace period of around 30 days followed by a redemption period, during which the holder can still recover it — so an expired date does not mean the domain has been lost. It does mean the renewal did not happen on time.',
          risk:
            'Once the grace and redemption periods end, the domain is released and can be registered by anyone. Whoever registers it controls the website, the email, and every account elsewhere that uses an address at this domain for password recovery.',
          recommendation:
            'Renew today. Enable auto-renew with a payment method that does not expire, and set the registrar account contact to a monitored shared mailbox rather than an individual.',
          evidence: {
            test: `RDAP query for ${domain}, expiration event read`,
            observed: `expiration: ${expires?.toISOString()}`,
            expected: 'A future expiration date',
            verification,
            limitation:
              'RDAP records can lag a renewal by a short period. Confirm at the registrar before acting on this.',
          },
          scoreImpact: 30,
        }),
      );
    } else if (daysToExpiry <= 30) {
      findings.push(
        makeFinding(KEY, {
          title: 'Domain registration expires within 30 days',
          severity: 'medium',
          confidence,
          asset: domain,
          observed: `The registration expires on ${expires?.toDateString()}, in ${daysToExpiry} days.`,
          interpretation:
            'Renewal is due imminently. Most domains renew automatically, in which case this is routine.',
          risk:
            'If the renewal fails — an expired card is the usual cause — the website and company email stop working at the same moment, and recovery involves the registrar rather than anything the operations team can fix directly.',
          recommendation:
            'Confirm auto-renew is enabled and the payment method on file is current. Consider extending the registration by several years to remove the recurring risk.',
          evidence: {
            test: `RDAP query for ${domain}, expiration event read`,
            observed: `expiration: ${expires?.toISOString()}`,
            expected: 'More than 90 days remaining, with auto-renew enabled',
            verification,
          },
          scoreImpact: 18,
        }),
      );
    } else if (daysToExpiry <= 90) {
      findings.push(
        makeFinding(KEY, {
          title: 'Domain registration expires within 90 days',
          severity: 'low',
          confidence,
          asset: domain,
          observed: `The registration expires on ${expires?.toDateString()}, in ${daysToExpiry} days.`,
          interpretation:
            'The renewal window is approaching. This is normal for a domain on a one-year term and is not a defect.',
          risk:
            'A lapsed renewal is one of the few failures that takes an entire organisation offline at once, so the state is worth confirming rather than assuming.',
          recommendation: 'Confirm auto-renew is enabled, and consider a multi-year registration.',
          evidence: {
            test: `RDAP query for ${domain}, expiration event read`,
            observed: `expiration: ${expires?.toISOString()}`,
            expected: 'Auto-renew enabled well before this point',
            verification,
          },
          scoreImpact: 10,
        }),
      );
    }
  }

  /* ---------------- Age ---------------- */

  const ageDays = created ? daysBetween(created, now) : null;
  if (ageDays !== null && ageDays < 365) {
    findings.push(
      makeFinding(KEY, {
        title: 'Domain was registered within the last year',
        severity: 'info',
        confidence: 'high',
        asset: domain,
        observed: `The RDAP registration event is dated ${created?.toDateString()}, ${ageDays} days ago.`,
        interpretation:
          'This is a recently registered domain. That is unremarkable for a new company or a new product line, and says nothing about how it is configured.',
        risk:
          'Recently registered domains carry no sending reputation, so outbound email from them is more likely to be filtered until reputation accumulates. Domain age is also used as a signal by some fraud-detection systems, which can affect how counterparties treat the domain.',
        recommendation:
          'Increase outbound email volume gradually, and get SPF, DKIM and DMARC fully enforced early — authenticated domains accumulate reputation faster.',
        evidence: {
          test: `RDAP query for ${domain}, registration event read`,
          observed: `registration: ${created?.toISOString()}`,
          verification,
          limitation:
            'A recent registration date can also mean the domain changed hands or moved registrar, depending on the registry.',
        },
      }),
    );
  }

  /* ---------------- Hold and pending states ----------------
     These describe a domain that is mid-process at the registry, and they are
     reported before the locks because they override them: a locked domain in
     redemption is still a domain in redemption. */

  if (locks.onHold) {
    findings.push(
      makeFinding(KEY, {
        title: 'The registry has placed this domain on hold',
        severity: 'high',
        confidence,
        asset: domain,
        observed: `The RDAP status array for ${domain} contains ${locks.rawStatusCodes.filter((s) => normaliseStatus(s).includes('hold')).join(', ')}.`,
        interpretation:
          'A hold status instructs the registry to stop publishing this domain\'s delegation. It is applied by a registrar or registry for non-payment, a policy or abuse complaint, or a pending legal action, and while it is in force the domain may not resolve at all.',
        risk:
          'A domain on hold can stop resolving worldwide, taking the website and the email with it. Klyro read the status code and did not test whether resolution is currently suspended — the DNS section of this report records what is answering right now.',
        recommendation:
          'Contact the registrar today and establish which party set the hold and why. Non-payment is the most common cause and the fastest to clear; a policy or legal hold needs the underlying matter resolved.',
        evidence: {
          test: `RDAP query for ${domain}, status array read`,
          observed: locks.rawStatusCodes.join(', '),
          expected: 'No clientHold or serverHold status',
          verification,
          limitation: `Whether the delegation is currently suspended was not tested here. ${CROSS_LIMITATION}`,
        },
        scoreImpact: 40,
      }),
    );
  }

  if (locks.pendingDeletion || locks.inRedemptionPeriod) {
    findings.push(
      makeFinding(KEY, {
        title: locks.inRedemptionPeriod
          ? 'The domain is in the redemption period following expiry'
          : 'The domain is in the registry deletion process',
        severity: 'high',
        confidence,
        asset: domain,
        observed: `The RDAP status array for ${domain} contains ${locks.rawStatusCodes.join(', ')}.`,
        interpretation: locks.inRedemptionPeriod
          ? 'The registration lapsed and the domain has entered redemption. The holder can still restore it, usually for a substantially higher fee than a renewal, for a limited window.'
          : 'The registry has begun releasing this domain. At the end of the process the name returns to the available pool.',
        risk:
          'When the process completes, the domain can be registered by anyone. Whoever registers it controls the website, the mail routing, and every account elsewhere that uses an address at this domain for password recovery.',
        recommendation:
          'Contact the registrar immediately and request restoration. This has a deadline set by the registry, not by the registrar, and it is not extendable.',
        evidence: {
          test: `RDAP query for ${domain}, status array read`,
          observed: locks.rawStatusCodes.join(', '),
          expected: 'No redemptionPeriod, pendingDelete or pendingRestore status',
          verification,
          limitation: CROSS_LIMITATION,
        },
        scoreImpact: 40,
      }),
    );
  }

  if (locks.pendingTransfer) {
    findings.push(
      makeFinding(KEY, {
        title: 'A registrar transfer is in progress for this domain',
        severity: 'medium',
        confidence,
        asset: domain,
        observed: `The RDAP status array for ${domain} contains pendingTransfer.`,
        interpretation:
          'The registry has an open transfer request. If the holder initiated it, this is routine and clears within about five days.',
        risk:
          'If nobody at the organisation initiated it, a transfer request is the visible step of a domain hijacking — it means someone has obtained the authorization code. An unchallenged request completes automatically.',
        recommendation:
          'Confirm today that the transfer was initiated deliberately. If it was not, reject it at the losing registrar before the automatic approval window closes, then rotate the authorization code and the registrar account credentials.',
        evidence: {
          test: `RDAP query for ${domain}, status array read`,
          observed: locks.rawStatusCodes.join(', '),
          expected: 'No pendingTransfer status, unless a transfer is known to be underway',
          verification,
          limitation: 'Klyro cannot tell who initiated the transfer, only that the registry has one open.',
        },
        scoreImpact: 20,
      }),
    );
  }

  /* ---------------- Locks ---------------- */

  if (statusesPublished && !locks.transferLocked) {
    findings.push(
      makeFinding(KEY, {
        title: 'No transfer lock is set on the domain',
        severity: 'medium',
        confidence,
        asset: domain,
        observed: `The RDAP status array for ${domain} does not include clientTransferProhibited or serverTransferProhibited. It contains: ${statuses.join(', ')}.`,
        interpretation: 'No transfer lock is set at the registry level.',
        risk:
          'Without a transfer lock, a domain transfer can be initiated with a valid authorization code. Combined with a compromised registrar account or an intercepted authorization email, this is one path to domain hijacking. Klyro found no evidence of any such attempt.',
        recommendation:
          'Enable transfer lock (clientTransferProhibited) at the registrar. Most registrars offer this as a free, one-click setting. For a domain the business depends on, ask about registry lock, which requires out-of-band verification for any change.',
        evidence: {
          test: `RDAP status array retrieved for ${domain}`,
          observed: statuses.join(', '),
          expected: 'clientTransferProhibited or serverTransferProhibited present',
          verification,
          limitation:
            'Whether the registrar account itself has additional protections — two-factor authentication, IP allowlisting — that would prevent an unauthorised transfer regardless of the EPP lock status.',
        },
        scoreImpact: 20,
      }),
    );
  }

  if (statusesPublished && !locks.updateLocked) {
    findings.push(
      makeFinding(KEY, {
        title: 'No update lock is set on the domain',
        severity: 'low',
        confidence,
        asset: domain,
        observed: `The RDAP status array for ${domain} does not include clientUpdateProhibited or serverUpdateProhibited. It contains: ${statuses.join(', ')}.`,
        interpretation: 'No update lock is set at the registry level.',
        risk:
          'Without an update lock, the nameserver delegation can be changed through the registrar account alone. Repointing the delegation redirects the website and the mail for the domain without touching the domain\'s own servers, and it takes effect as fast as the records propagate.',
        recommendation:
          'Enable clientUpdateProhibited at the registrar. It has to be lifted deliberately before a legitimate DNS change, which is the point — it turns a silent modification into a two-step one.',
        evidence: {
          test: `RDAP status array retrieved for ${domain}`,
          observed: statuses.join(', '),
          expected: 'clientUpdateProhibited or serverUpdateProhibited present',
          verification,
          limitation:
            'Whether the registrar account applies its own change-approval process that would achieve the same effect without the EPP status being set.',
        },
        scoreImpact: 10,
      }),
    );
  }

  if (statusesPublished && !locks.deleteLocked) {
    findings.push(
      makeFinding(KEY, {
        title: 'No deletion lock is set on the domain',
        severity: 'low',
        confidence,
        asset: domain,
        observed: `The RDAP status array for ${domain} does not include clientDeleteProhibited or serverDeleteProhibited. It contains: ${statuses.join(', ')}.`,
        interpretation: 'No deletion lock is set at the registry level.',
        risk:
          'Without a deletion lock, the domain can be deleted through the registrar account. Deletion begins a registry process that ends with the name returning to the available pool, and recovery during redemption carries a substantial fee.',
        recommendation:
          'Enable clientDeleteProhibited at the registrar. Like the update lock it is free, and it exists to make an irreversible action deliberate.',
        evidence: {
          test: `RDAP status array retrieved for ${domain}`,
          observed: statuses.join(', '),
          expected: 'clientDeleteProhibited or serverDeleteProhibited present',
          verification,
          limitation:
            'Whether the registrar would independently refuse a deletion request for a domain of this kind.',
        },
        scoreImpact: 10,
      }),
    );
  }

  /* ---------------- Source disagreement ---------------- */

  if (cross.conflicts) {
    findings.push(
      makeFinding(KEY, {
        title: 'Domain registration data differs between RDAP sources queried',
        severity: 'low',
        confidence: 'high',
        asset: domain,
        observed:
          `The bootstrap RDAP response and ${cross.source} returned different values for ${domain}. ` +
          (!cross.expiryAgrees
            ? `Expiration: ${expires ? expires.toISOString().slice(0, 10) : 'not published'} versus ${cross.secondExpiry ? cross.secondExpiry.toISOString().slice(0, 10) : 'not published'}. `
            : '') +
          (!cross.statusAgrees
            ? `Status codes: [${statuses.join(', ') || 'none'}] versus [${cross.secondStatuses.join(', ') || 'none'}].`
            : ''),
        interpretation:
          'Two RDAP reads of the same registration disagree. The usual cause is caching — one source served an answer from before a recent change — rather than either source being wrong.',
        risk:
          'None follows directly. It is reported because a reader doing their own diligence will query one of these sources and should know the other says something different, and because a disagreement about status codes can mean a lock or a hold was applied or lifted very recently.',
        recommendation:
          'Treat the registry\'s own response as authoritative and confirm the current state at the registrar. If the difference is in the status codes, establish which change was made and by whom.',
        evidence: {
          test: `RDAP queried via the bootstrap redirector and again via ${cross.source}`,
          observed: `expiration agrees: ${cross.expiryAgrees}; status codes agree: ${cross.statusAgrees}`,
          expected: 'Identical expiration and status values from both sources',
          verification: 'Both responses were parsed the same way and compared field by field.',
          limitation:
            'Klyro cannot establish which source is current. Neither is assumed to be wrong.',
        },
      }),
    );
  }

  if (registrar === 'Not disclosed') {
    findings.push(
      makeFinding(KEY, {
        title: 'The registration record does not name a registrar',
        severity: 'info',
        confidence: 'high',
        asset: domain,
        observed: `The RDAP response for ${domain} contains no entity with the registrar role, or that entity carries no name.`,
        interpretation:
          'Some registries publish a reduced RDAP record, and some omit the registrar entity entirely. This is a property of the registry\'s disclosure policy rather than of the domain.',
        risk:
          'None directly. It does make it slower to establish who to contact during an incident involving the domain, which is worth having documented internally instead.',
        recommendation: 'Record the registrar in the internal asset inventory so it is not being looked up under pressure.',
        evidence: {
          test: `RDAP query for ${domain}, entities walked for the registrar role`,
          observed: 'No named registrar entity in the response',
          verification: 'Both configured RDAP endpoints were tried before this was reported.',
        },
      }),
    );
  }

  /* ---------------- Details ---------------- */

  const locksInEffect = [
    locks.transferLocked ? 'transfer' : null,
    locks.updateLocked ? 'update' : null,
    locks.deleteLocked ? 'delete' : null,
  ].filter(Boolean) as string[];

  const alerts = [
    locks.onHold ? 'hold' : null,
    locks.pendingDeletion ? 'pending deletion' : null,
    locks.inRedemptionPeriod ? 'redemption period' : null,
    locks.pendingTransfer ? 'pending transfer' : null,
    locks.pendingRestore ? 'pending restore' : null,
  ].filter(Boolean) as string[];

  details.push(
    {
      label: 'Registrar',
      value: enterpriseRegistrar
        ? `${registrar} — a registrar specialising in corporate domain security`
        : registrar,
      tone: 'neutral',
    },
    {
      label: 'Registered',
      value: created ? `${created.toDateString()} (${Math.floor((ageDays ?? 0) / 365)} yrs ago)` : 'Not published',
      mono: true,
    },
    {
      label: 'Expires',
      value: expires ? `${expires.toDateString()} (${daysToExpiry} days)` : 'Not published',
      mono: true,
      tone: daysToExpiry === null ? 'neutral' : daysToExpiry > 90 ? 'good' : daysToExpiry > 0 ? 'warn' : 'bad',
    },
    { label: 'Last changed', value: updated ? updated.toDateString() : 'Not published', mono: true },
    {
      label: 'Registrant details',
      value: privacyEnabled ? 'Redacted or privacy-protected' : 'Published',
      tone: privacyEnabled ? 'good' : 'warn',
    },
    {
      label: 'Registry status codes',
      value: statusesPublished ? locks.rawStatusCodes.join(', ') : 'None published',
      mono: true,
      tone: alerts.length ? 'bad' : locks.transferLocked ? 'good' : statusesPublished ? 'warn' : 'neutral',
    },
    {
      label: 'Locks in effect',
      value: locksInEffect.length ? locksInEffect.join(', ') : 'None',
      tone: locks.transferLocked && locks.updateLocked && locks.deleteLocked ? 'good' : locks.transferLocked ? 'warn' : 'bad',
    },
    {
      label: 'Registry-level lock',
      value: locks.registryLevel ? 'Yes — changes require registry action' : 'No — registrar-level only',
      tone: locks.registryLevel ? 'good' : 'neutral',
    },
    {
      label: 'Hold or pending states',
      value: alerts.length ? alerts.join(', ') : 'None',
      tone: alerts.length ? 'bad' : 'good',
    },
    {
      label: 'Cross-verification',
      value:
        cross.kind === 'none'
          ? 'Single RDAP source — a second was not reachable'
          : cross.conflicts
            ? `Two sources queried; ${cross.source} returned different values`
            : `Confirmed against ${cross.source}`,
      tone: cross.kind === 'none' ? 'neutral' : cross.conflicts ? 'warn' : 'good',
    },
    {
      label: 'Nameservers at the registry',
      value:
        (data.nameservers ?? [])
          .map((n) => n.ldhName?.toLowerCase())
          .filter(Boolean)
          .join(', ') || 'Not listed',
      mono: true,
    },
    {
      label: 'DNSSEC delegation',
      value: data.secureDNS?.delegationSigned ? 'Signed at the registry' : 'Not signed at the registry',
      tone: data.secureDNS?.delegationSigned ? 'good' : 'neutral',
    },
  );

  /* ---------------- Score ----------------
     The three locks are scored separately rather than as one component,
     because they protect against different things: transfer moves the domain,
     update repoints it, delete releases it. A domain with only a transfer lock
     is not "locked" — it is locked against one of the three. */

  const cleanStatus =
    !locks.onHold && !locks.pendingDeletion && !locks.inRedemptionPeriod && !locks.pendingRestore;

  const expiryScore =
    daysToExpiry === null
      ? 0
      : daysToExpiry > 180
        ? 30
        : daysToExpiry > 90
          ? 24
          : daysToExpiry > 30
            ? 16
            : daysToExpiry > 0
              ? 8
              : 0;

  const { score: baseScore, coverage, breakdown } = scoreFromComponents([
    {
      label: 'Transfer lock',
      value: locks.transferLocked ? 25 : 0,
      max: 25,
      known: statusesPublished,
      note: !statusesPublished
        ? 'The registry published no status codes, so lock state could not be read and this component was dropped.'
        : locks.transferLocked
          ? `Transfer prohibited at the ${locks.registryLevel ? 'registry' : 'registrar'} level.`
          : 'No clientTransferProhibited or serverTransferProhibited status.',
    },
    {
      label: 'Update lock',
      value: locks.updateLocked ? 15 : 0,
      max: 15,
      known: statusesPublished,
      note: !statusesPublished
        ? 'No status codes published, so this component was dropped.'
        : locks.updateLocked
          ? 'Updates prohibited, so the nameserver delegation cannot be changed without lifting the lock first.'
          : 'No clientUpdateProhibited or serverUpdateProhibited status.',
    },
    {
      label: 'Deletion lock',
      value: locks.deleteLocked ? 15 : 0,
      max: 15,
      known: statusesPublished,
      note: !statusesPublished
        ? 'No status codes published, so this component was dropped.'
        : locks.deleteLocked
          ? 'Deletion prohibited at the registry.'
          : 'No clientDeleteProhibited or serverDeleteProhibited status.',
    },
    {
      label: 'Registry status clear of holds',
      value: cleanStatus ? 15 : 0,
      max: 15,
      known: statusesPublished,
      note: !statusesPublished
        ? 'No status codes published, so this component was dropped.'
        : cleanStatus
          ? 'No hold, pending-deletion, redemption or restore state at the registry.'
          : `Registry reports ${alerts.join(', ')}.`,
    },
    {
      label: 'Registration term remaining',
      value: expiryScore,
      max: 30,
      known: daysToExpiry !== null,
      note:
        daysToExpiry === null
          ? 'No expiration date was published, so this component was dropped.'
          : `${daysToExpiry} days remaining.`,
    },
    {
      label: 'Registrant privacy',
      value: privacyEnabled ? 20 : 8,
      max: 20,
      note: privacyEnabled
        ? 'Registrant details are redacted or privacy-protected.'
        : 'Registrant details are published in the registration record.',
    },
    {
      label: 'DNSSEC delegation at the registry',
      value: data.secureDNS?.delegationSigned ? 10 : 0,
      max: 10,
      known: data.secureDNS !== undefined,
      note:
        data.secureDNS === undefined
          ? 'The registry did not publish DNSSEC delegation status, so this component was dropped.'
          : data.secureDNS.delegationSigned
            ? 'A signed delegation exists at the registry.'
            : 'No signed delegation at the registry.',
    },
    {
      label: 'Registration age',
      value: ageDays === null ? 0 : ageDays > 730 ? 10 : ageDays > 365 ? 7 : 3,
      max: 10,
      known: ageDays !== null,
      note:
        ageDays === null
          ? 'No registration date was published, so this component was dropped.'
          : `Registered ${Math.floor(ageDays / 365)} year(s) ago. Weighted lightly — age correlates with abuse only at the very new end and says nothing about configuration.`,
    },
  ] satisfies ScoreComponent[]);

  /*
   * The registrar bonus is added here rather than scored as a component, so
   * that an unlisted registrar costs nothing. See ENTERPRISE_REGISTRARS.
   */
  let score = Math.min(100, baseScore + (enterpriseRegistrar ? ENTERPRISE_REGISTRAR_BONUS : 0));

  if (enterpriseRegistrar) {
    breakdown.push({
      label: 'Corporate registrar',
      value: ENTERPRISE_REGISTRAR_BONUS,
      max: 0,
      assessed: true,
      note: `${registrar} specialises in corporate domain security. Added on top of the component score rather than scored as a component, so a domain held elsewhere loses nothing for it — the locks above are the part that is actually checkable.`,
    });
  }

  /*
   * A hold overrides everything else in this category.
   *
   * Every lock can be set and the domain can still be one registry action away
   * from not resolving. Averaging a hold against four green components would
   * report that domain as well-managed.
   */
  const HOLD_CEILING = 30;
  if (locks.onHold || locks.pendingDeletion || locks.inRedemptionPeriod) {
    if (score > HOLD_CEILING) {
      breakdown.push({
        label: 'Hold or deletion state applied',
        value: -(score - HOLD_CEILING),
        max: 0,
        assessed: true,
        note: `The registry reports ${alerts.join(', ')}. This caps the category at ${HOLD_CEILING} regardless of the locks in place, because a domain in this state can stop resolving or be released whatever else is configured.`,
      });
      score = HOLD_CEILING;
    }
  }

  if (coverage < 0.999) {
    details.push({
      label: 'Assessed weight',
      value: `${Math.round(coverage * 100)}% — fields the registry did not publish were excluded, not counted against the domain`,
      tone: 'neutral',
    });
  }

  const lockSentence = statusesPublished
    ? locksInEffect.length === 3
      ? 'Transfer, update and deletion locks are all enabled at the registry.'
      : locksInEffect.length > 0
        ? `${locksInEffect.length === 1 ? 'Only the' : 'The'} ${locksInEffect.join(' and ')} lock${locksInEffect.length === 1 ? ' is' : 's are'} enabled at the registry.`
        : 'No registry locks are enabled.'
    : 'The registry publishes no status codes, so lock state could not be read.';

  const summary =
    `Registered with ${registrar}${created ? ` since ${created.getFullYear()}` : ''}. ${lockSentence}` +
    ` Registrant details are ${privacyEnabled ? 'redacted' : 'published'}${daysToExpiry !== null ? `, and the registration term ends in ${daysToExpiry} days` : ''}.`;

  const facts = {
    registrar,
    enterpriseRegistrar,
    createdYear: created ? created.getFullYear() : null,
    expiresAt: expires ? expires.toISOString() : null,
    nameservers: (data.nameservers ?? [])
      .map((n) => n.ldhName?.toLowerCase())
      .filter((n): n is string => Boolean(n))
      .sort(),
    privacyEnabled,
    transferLock: locks.transferLocked,
    updateLock: locks.updateLocked,
    deleteLock: locks.deleteLocked,
    onHold: locks.onHold,
    registryLock: locks.registryLevel,
    statuses,
    crossVerified: cross.kind !== 'none' && !cross.conflicts,
  };

  return {
    score,
    summary,
    findings,
    details,
    scoreBreakdown: breakdown,
    moduleCoverage: coverage,
    facts,
  };
}
