import { registrableDomain, registrableDomainIsCertain } from '../domain';
import type { CategoryDetail, Finding } from '../types';
import {
  answersOfType,
  dnsQuery,
  makeFinding,
  makeUnknown,
  type ModuleOutput,
  type ScoreComponent,
  scoreFromComponents,
  truncate,
} from './util';

const KEY = 'dns' as const;

/**
 * Whether a nameserver's operator domain looks like the assessed domain's own
 * organisation, as opposed to a third-party DNS provider.
 *
 * Strict equality is not enough. `boschaishield.com` delegates to
 * `gwa.fe.bosch.de` — a different registrable domain, plainly the same
 * organisation. Comparing the leading labels catches that, and the finding
 * states it as an appearance rather than a fact, because from outside the DNS
 * there is no way to establish corporate ownership.
 *
 * The four-character floor keeps short generic labels (`ns`, `dns`, `aws`)
 * from matching anything that happens to contain them.
 */
/**
 * Managed DNS providers that publish their nameservers across several
 * registrable domains on purpose.
 *
 * Route 53 hands out `ns-81.awsdns-10.com`, `ns-659.awsdns-18.net`,
 * `ns-1372.awsdns-43.org` and `ns-1984.awsdns-56.co.uk` for a single hosted
 * zone — four TLDs so that the loss of one TLD's infrastructure does not take
 * the delegation with it. Grouping by registrable domain alone counts that as
 * four independent operators, which is the opposite of true: it is one
 * provider, and a reader could take the report to mean the domain has four
 * independent DNS suppliers when it has one.
 *
 * Observed live on netflix.com (reported as 4 operators) and github.com
 * (reported as 5, actually AWS plus NS1).
 */
const DNS_PROVIDER_FAMILIES: { pattern: RegExp; name: string }[] = [
  { pattern: /(^|\.)awsdns-\d+\.[a-z.]+$/i, name: 'Amazon Route 53' },
  { pattern: /(^|\.)ns\.cloudflare\.com$/i, name: 'Cloudflare' },
  { pattern: /(^|\.)nsone\.net$/i, name: 'NS1' },
  { pattern: /(^|\.)azure-dns\.(com|net|org|info)$/i, name: 'Azure DNS' },
  { pattern: /(^|\.)googledomains\.com$/i, name: 'Google Cloud DNS' },
  { pattern: /(^|\.)(akam|akamaiedge|akamaitech|akadns)\.(net|com)$/i, name: 'Akamai' },
  { pattern: /(^|\.)dynect\.net$/i, name: 'Oracle Dyn' },
  { pattern: /(^|\.)ultradns\.(com|net|org|info|biz|co\.uk)$/i, name: 'UltraDNS' },
  { pattern: /(^|\.)dnsmadeeasy\.com$/i, name: 'DNS Made Easy' },
  { pattern: /(^|\.)constellix\.(com|net)$/i, name: 'Constellix' },
  { pattern: /(^|\.)domaincontrol\.com$/i, name: 'GoDaddy' },
  { pattern: /(^|\.)registrar-servers\.com$/i, name: 'Namecheap' },
  { pattern: /(^|\.)worldnic\.com$/i, name: 'Network Solutions' },
  { pattern: /(^|\.)dnsimple\.com$/i, name: 'DNSimple' },
  { pattern: /(^|\.)nsone\.info$/i, name: 'NS1' },
];

/**
 * Which operator a nameserver belongs to.
 *
 * A named provider where the host matches a known family, and the registrable
 * domain otherwise. The provider name is what gets deduplicated, so four
 * Route 53 names collapse to one operator rather than four.
 */
export function dnsOperatorOf(nameserver: string): string {
  const host = (nameserver ?? '').trim().toLowerCase().replace(/\.$/, '');
  for (const family of DNS_PROVIDER_FAMILIES) {
    if (family.pattern.test(host)) return family.name;
  }
  return registrableDomain(host);
}

/** True when the operator was resolved to a known provider rather than a domain. */
function isNamedProvider(operator: string): boolean {
  return DNS_PROVIDER_FAMILIES.some((f) => f.name === operator);
}

export function looksSameOrganisation(nsOperator: string, domain: string): boolean {
  const nsLabel = nsOperator.split('.')[0] ?? '';
  const ownLabel = registrableDomain(domain).split('.')[0] ?? '';
  if (!nsLabel || !ownLabel) return false;
  if (nsLabel === ownLabel) return true;
  if (nsLabel.length < 4 || ownLabel.length < 4) return false;
  return ownLabel.includes(nsLabel) || nsLabel.includes(ownLabel);
}

// CDNs legitimately publish 30–60s TTLs on proxied records, so the floor sits
// below that rather than flagging a normal Cloudflare or Akamai setup.
const MIN_SANE_TTL = 30;
const MAX_SANE_TTL = 172_800; // 48h

/** A label no zone would define, used to detect a wildcard A record. */
function wildcardProbeLabel(): string {
  return `klyro-wildcard-${Math.random().toString(36).slice(2, 10)}`;
}

export async function checkDns(domain: string): Promise<ModuleOutput> {
  const findings: Finding[] = [];
  const details: CategoryDetail[] = [];

  const wildcardLabel = wildcardProbeLabel();

  const [a, aaaa, wwwAaaa, mx, ns, txt, soa, cname, caa, wildcard, dnssecProbe] = await Promise.all([
    dnsQuery(domain, 'A'),
    dnsQuery(domain, 'AAAA'),
    // `www` separately: plenty of estates publish IPv6 on the host that serves
    // the site and not at the apex, and reporting "no IPv6" for those would be
    // wrong.
    dnsQuery(`www.${domain}`, 'AAAA'),
    dnsQuery(domain, 'MX'),
    dnsQuery(domain, 'NS'),
    dnsQuery(domain, 'TXT'),
    dnsQuery(domain, 'SOA'),
    dnsQuery(`www.${domain}`, 'CNAME'),
    dnsQuery(domain, 'CAA'),
    // A name nobody would have registered. If it answers, the zone has a
    // wildcard, and every host-name-based conclusion in this report needs
    // qualifying — including our own subdomain liveness checks.
    dnsQuery(`${wildcardLabel}.${domain}`, 'A'),
    // Only the AD flag is read from this one, so an empty answer needs no
    // second opinion.
    dnsQuery(domain, 'A', { dnssec: true, confirmAbsence: false }),
  ]);

  if (!a.resolved && !ns.resolved && !soa.resolved) {
    throw new Error('No DNS resolver answered for this domain.');
  }

  const aRecords = answersOfType(a, 'A');
  const aaaaRecords = answersOfType(aaaa, 'AAAA');
  const mxRecords = answersOfType(mx, 'MX');
  const nsRecords = answersOfType(ns, 'NS');
  const soaRecords = answersOfType(soa, 'SOA');
  const txtRecords = answersOfType(txt, 'TXT');

  if (a.resolved && aaaa.resolved && aRecords.length === 0 && aaaaRecords.length === 0) {
    findings.push(
      makeFinding(KEY, {
        title: 'Domain publishes no web address record',
        severity: 'low',
        confidence: 'high',
        asset: domain,
        observed: `A and AAAA queries for ${domain} returned NOERROR with no answer records, confirmed across ${[...new Set([...a.resolvers, ...aaaa.resolvers])].join(' and ')}.`,
        interpretation:
          'The domain is delegated and its zone answers, but nothing maps it to a web server. That is the normal configuration for a domain used only for email, held defensively, or serving its website from www only.',
        risk:
          'None follows from this on its own. It is recorded because a domain that is expected to host a website and does not is usually a delegation or migration mistake rather than a deliberate choice.',
        recommendation:
          'If this domain is meant to host a website, add an A or AAAA record at the apex or a redirect from the apex to wherever the site lives. If it is deliberately parked, no action is needed.',
        evidence: {
          test: `DNS A and AAAA query for ${domain}`,
          observed: 'NOERROR, zero answer records',
          expected: 'One or more A or AAAA records, for a domain that serves a website at its apex',
          verification: `Both record types queried; absence re-asked against a second resolver before being reported`,
          limitation:
            'This says nothing about www or any other host under the domain, which are assessed separately.',
        },
      }),
    );
  }

  /* ---------------- Wildcard DNS ---------------- */

  /*
   * Checked early because it qualifies other conclusions rather than standing
   * on its own. A zone with a wildcard answers for every name ever asked, so
   * "this host resolves" stops being evidence that the host exists.
   */
  const wildcardAnswers = answersOfType(wildcard, 'A');
  const wildcardKnown = wildcard.resolved;
  const hasWildcard = wildcardKnown && wildcardAnswers.length > 0;

  if (hasWildcard) {
    findings.push(
      makeFinding(KEY, {
        title: 'Zone answers for host names that were never defined',
        severity: 'info',
        confidence: 'high',
        asset: domain,
        observed: `A query for ${wildcardLabel}.${domain} — a random name generated for this scan — returned ${wildcardAnswers.map((r) => r.data).join(', ')}.`,
        interpretation:
          'The zone contains a wildcard record, so any name under this domain resolves whether or not it was ever configured. This is a deliberate and common setup for platforms that give customers their own subdomain.',
        risk:
          'No exposure follows from the wildcard itself. It does affect what can be concluded elsewhere in this report: a host name resolving under this domain is no longer evidence that a system exists behind it, and phishing pages hosted on typo-subdomains will resolve normally.',
        recommendation:
          'No action is required if the wildcard is intentional. Treat the subdomain section of this report as a list of names that were certified rather than a confirmed inventory.',
        evidence: {
          test: `DNS A query for a randomly generated label under ${domain}`,
          observed: `${wildcardLabel}.${domain} → ${wildcardAnswers.map((r) => r.data).join(', ')}`,
          expected: 'NXDOMAIN, for a zone without a wildcard',
          verification: 'The label is generated per scan, so it cannot have been registered in advance.',
        },
      }),
    );
  }

  details.push({
    label: 'Wildcard DNS',
    value: !wildcardKnown
      ? 'Could not be checked'
      : hasWildcard
        ? 'Present — every name under this domain resolves'
        : 'Not present — undefined names return NXDOMAIN',
    tone: !wildcardKnown ? 'neutral' : hasWildcard ? 'warn' : 'good',
  });

  /* ---------------- DNSSEC ---------------- */

  /*
   * Three outcomes, not two. "A resolver said no" and "no resolver answered"
   * used to collapse into the same "DNSSEC is not enabled" finding, so a
   * rate-limited lookup was enough to publish that claim about a domain that
   * was in fact signed.
   */
  type DnssecState = 'validating' | 'broken' | 'absent' | 'unknown';
  let dnssec: DnssecState = 'unknown';
  let dnssecScore = 0;
  let dnssecNote = 'The DNSSEC probe did not resolve, so this component was dropped.';
  let dnssecReason = dnssecProbe.reason ?? 'the DNSSEC-enabled lookup did not resolve';

  if (dnssecProbe.resolved && dnssecProbe.ad) {
    dnssec = 'validating';
    dnssecScore = 25;
    dnssecNote = 'A validating resolver set the Authenticated Data flag, so the signature chain checked out.';
  } else if (dnssecProbe.resolved) {
    // Signed-but-broken and never-signed look identical from the AD flag
    // alone; the DS record in the parent zone tells them apart.
    const ds = await dnsQuery(domain, 'DS');
    if (!ds.resolved) {
      dnssecReason = ds.reason ?? dnssecReason;
    } else if (answersOfType(ds, 'DS').length > 0) {
      dnssec = 'broken';
      dnssecScore = 10;
      dnssecNote = 'A DS record exists in the parent zone but the resolver did not authenticate the answer.';
      findings.push(
        makeFinding(KEY, {
          title: 'DNSSEC is published but the chain did not authenticate',
          severity: 'high',
          confidence: 'high',
          asset: domain,
          observed: `A DS record is present in the parent zone (confirmed via ${ds.resolvers.join(' and ')}), but a DNSSEC-enabled query returned without the Authenticated Data flag set.`,
          interpretation:
            'The domain is signed as far as the registry is concerned, but the validating resolver could not verify the chain from that DS record to the zone\'s current signing key. The usual cause is a key rotated in the zone without the matching DS being updated at the registrar.',
          risk:
            'Resolvers that enforce DNSSEC may refuse to answer for this domain entirely, which presents to users as the site and email being unreachable rather than as a security warning. The protection the signing was meant to provide is not in effect.',
          recommendation:
            'Ask the DNS provider or registrar to confirm the DS record in the parent zone matches the current DNSKEY, and re-publish it if the key has been rotated.',
          evidence: {
            test: `DNSSEC-enabled A query for ${domain}, followed by a DS query`,
            observed: `DS record present; AD flag absent on the signed query`,
            expected: 'AD flag set, indicating the resolver validated the chain',
            verification: `DS presence confirmed against ${ds.resolvers.join(' and ')}`,
            limitation:
              'Klyro reads the resolver\'s verdict rather than validating the chain itself, so it can tell you validation failed but not which record in the chain is at fault.',
          },
        }),
      );
    } else {
      dnssec = 'absent';
      dnssecScore = 0;
      dnssecNote = 'No DS record in the parent zone and no authenticated answer — the zone is unsigned.';
      findings.push(
        makeFinding(KEY, {
          title: 'DNS records are not signed with DNSSEC',
          severity: 'low',
          confidence: 'high',
          asset: domain,
          observed: `No DS record exists in the parent zone for ${domain}, and a DNSSEC-enabled query returned without the Authenticated Data flag. Confirmed via ${ds.resolvers.join(' and ')}.`,
          interpretation:
            'The zone is not signed. DNS answers for this domain are therefore not cryptographically authenticated by the domain itself; a resolver has no way to verify that an answer it received is the one the zone published.',
          risk:
            'If an attacker is positioned to tamper with DNS traffic or poison a resolver cache, unsigned answers give the resolver nothing to check the forgery against. Klyro observed no evidence of any such tampering — this describes the absence of a defence, not an attack. Most of the internet is in the same position, and transport security (HTTPS with a valid certificate) blocks the majority of what DNSSEC would otherwise prevent.',
          recommendation:
            'Enable DNSSEC at the registrar and DNS host if both support it. It is usually a one-time configuration and does not change how the site behaves. Treat it as hardening rather than remediation.',
          evidence: {
            test: `DS query at the parent zone, plus a DNSSEC-enabled A query for ${domain}`,
            observed: 'No DS records; AD flag not set',
            expected: 'A DS record and an authenticated answer, for a signed zone',
            verification: `Absence confirmed against ${ds.resolvers.join(' and ')} before being reported`,
            limitation:
              'Absence of signing is not evidence of tampering, and Klyro made no attempt to detect tampering.',
          },
        }),
      );
    }
  }

  if (dnssec === 'unknown') {
    findings.push(
      makeUnknown(KEY, {
        title: 'DNSSEC status could not be determined',
        asset: domain,
        observed: `The lookup needed to establish whether this zone is signed did not complete: ${dnssecReason}`,
        wouldHaveShown:
          'A completed lookup would have shown whether the zone is signed, signed but failing validation, or unsigned.',
        recommendation:
          'Re-run the assessment. If it keeps failing, confirm the domain resolves normally from a public resolver.',
        evidence: {
          test: `DNSSEC-enabled A query for ${domain}`,
          observed: dnssecReason,
          verification: 'Both configured resolvers were tried.',
        },
      }),
    );
  }

  details.push({
    label: 'DNSSEC',
    value:
      dnssec === 'validating'
        ? 'Signed and validating'
        : dnssec === 'broken'
          ? 'Signed but not validating'
          : dnssec === 'absent'
            ? 'Not signed'
            : 'Could not be determined',
    tone: dnssec === 'validating' ? 'good' : dnssec === 'unknown' ? 'neutral' : 'warn',
  });

  /* ---------------- CAA ---------------- */

  const caaAnswers = answersOfType(caa, 'CAA');
  const caaKnown = caa.resolved;
  const caaIssuers = caaAnswers
    .map((r) => /"([^"]+)"/.exec(r.data)?.[1] ?? r.data.split(/\s+/).slice(2).join(' '))
    .filter(Boolean);
  const hasCaa = caaAnswers.length > 0;

  if (caaKnown && !hasCaa) {
    findings.push(
      makeFinding(KEY, {
        title: 'No CAA record restricts who may issue certificates',
        severity: 'low',
        confidence: 'high',
        asset: domain,
        observed: `A CAA query for ${domain} returned no records, confirmed via ${caa.resolvers.join(' and ')}.`,
        interpretation:
          'The zone does not name which certificate authorities are permitted to issue for it. Under the CA/Browser Forum baseline requirements, an absent CAA record means every publicly trusted authority is permitted to issue, subject only to its own domain validation.',
        risk:
          'If an attacker can pass any single authority\'s domain validation — through a DNS compromise, an email interception, or a validation flaw at that authority — a certificate can be issued without the zone owner\'s involvement. A CAA record narrows that from roughly a hundred authorities to the one or two actually in use. Klyro found no evidence of mis-issuance; this is a missing constraint, not an incident.',
        recommendation:
          'Publish a CAA record naming the authorities actually used, for example `0 issue "digicert.com"`, and add `0 iodef "mailto:security@<domain>"` so attempted violations are reported to you.',
        evidence: {
          test: `DNS CAA query for ${domain}`,
          observed: 'NOERROR, zero CAA records',
          expected: 'One or more CAA records naming the permitted issuing authorities',
          verification: `Absence confirmed against ${caa.resolvers.join(' and ')}`,
          limitation:
            'CAA is only checked at issuance time by the authority itself. It constrains future issuance and does nothing about certificates already issued.',
        },
      }),
    );
  }

  details.push({
    label: 'Certificate issuance policy (CAA)',
    value: !caaKnown
      ? 'Could not be checked'
      : hasCaa
        ? truncate(caaIssuers.join(', ') || 'Published', 90)
        : 'Not published — any public CA may issue',
    tone: !caaKnown ? 'neutral' : hasCaa ? 'good' : 'warn',
    mono: hasCaa,
  });

  /* ---------------- Dangling records ---------------- */

  const cnameTargets: { host: string; target: string }[] = [];
  for (const record of answersOfType(cname, 'CNAME')) {
    cnameTargets.push({ host: `www.${domain}`, target: record.data.replace(/\.$/, '') });
  }
  // A CNAME on the apex is unusual but happens with flattening providers.
  for (const record of answersOfType(a, 'CNAME')) {
    cnameTargets.push({ host: domain, target: record.data.replace(/\.$/, '') });
  }

  const dangling: string[] = [];
  let danglingKnown = true;

  await Promise.all(
    cnameTargets.map(async ({ host, target }) => {
      const resolved = await dnsQuery(target, 'A');
      if (!resolved.resolved) {
        // Cannot see the target, so cannot call it abandoned.
        danglingKnown = false;
        return;
      }

      const hasAddress =
        answersOfType(resolved, 'A').length > 0 || answersOfType(resolved, 'CNAME').length > 0;

      // Status 3 == NXDOMAIN. A target that simply has no A record but exists
      // (Status 0, empty answer) is not necessarily takeover-able.
      if (resolved.status === 3) {
        dangling.push(`${host} → ${target} (NXDOMAIN)`);
      } else if (!hasAddress && resolved.status === 0) {
        const aaaaResolved = await dnsQuery(target, 'AAAA');
        if (!aaaaResolved.resolved) {
          danglingKnown = false;
        } else if (answersOfType(aaaaResolved, 'AAAA').length === 0) {
          dangling.push(`${host} → ${target} (no address)`);
        }
      }
    }),
  );

  const noDangling = dangling.length === 0;
  if (!noDangling) {
    const nxdomain = dangling.filter((d) => d.includes('NXDOMAIN'));
    findings.push(
      makeFinding(KEY, {
        title: 'A CNAME points at a name that does not resolve',
        severity: nxdomain.length > 0 ? 'high' : 'medium',
        confidence: 'high',
        asset: cnameTargets.map((t) => t.host).join(', '),
        observed: `${dangling.join('; ')}. Each target was queried for both A and AAAA records.`,
        interpretation:
          nxdomain.length > 0
            ? 'The alias target does not exist in DNS at all. That is the signature of a service that was deprovisioned at its hosting platform while the record pointing at it was left in place.'
            : 'The alias target exists as a name but carries no address, so the alias currently leads nowhere.',
        risk:
          'Several hosting platforms allocate names on a first-come basis. If this target sits in such a namespace and is still claimable, whoever claims it serves content on a host name belonging to this domain, with a certificate the domain\'s own DNS entitles them to obtain. Klyro did not attempt to determine whether the specific target is claimable — establishing that would mean interacting with the hosting provider, which is outside passive assessment.',
        recommendation:
          'Remove the CNAME if the service is genuinely retired. If it should still be live, re-create the resource at the provider before removing anything, and check the rest of the zone for records created alongside it.',
        evidence: {
          test: 'CNAME targets resolved for A, then AAAA where A returned empty',
          observed: dangling.join('; '),
          expected: 'Each CNAME target resolving to at least one address',
          verification: 'Both record types were queried, and unresolved lookups were treated as unknown rather than absent.',
          limitation:
            'Whether the abandoned name can actually be re-registered by a third party depends on the hosting provider and was not tested.',
        },
      }),
    );
  }

  details.push({
    label: 'CNAME targets',
    value:
      cnameTargets.length === 0
        ? 'No CNAME records at the apex or www'
        : !danglingKnown && noDangling
          ? 'Could not be checked'
          : noDangling
            ? `${cnameTargets.length} checked, all resolve`
            : dangling.join('; '),
    tone: cnameTargets.length === 0 ? 'neutral' : !danglingKnown && noDangling ? 'neutral' : noDangling ? 'good' : 'bad',
    mono: !noDangling,
  });

  /* ---------------- TTLs ---------------- */

  const ttls = [...aRecords, ...aaaaRecords, ...mxRecords, ...nsRecords]
    .map((r) => r.TTL)
    .filter((t) => Number.isFinite(t));
  const minTtl = ttls.length ? Math.min(...ttls) : null;
  const maxTtl = ttls.length ? Math.max(...ttls) : null;
  const ttlSane =
    minTtl !== null && maxTtl !== null && minTtl >= MIN_SANE_TTL && maxTtl <= MAX_SANE_TTL;

  if (ttls.length > 0 && !ttlSane) {
    const tooShort = minTtl !== null && minTtl < MIN_SANE_TTL;
    findings.push(
      makeFinding(KEY, {
        title: tooShort ? 'DNS records expire from caches almost immediately' : 'DNS records stay cached for an unusually long time',
        severity: 'low',
        confidence: 'high',
        asset: domain,
        observed: `Observed TTLs across A, AAAA, MX and NS records range from ${minTtl}s to ${maxTtl}s.`,
        interpretation: tooShort
          ? `The shortest TTL is ${minTtl}s, below the ${MIN_SANE_TTL}s floor this check uses. Very short TTLs are normal during a migration and for some traffic-steering products, so this is an observation about configuration rather than a defect.`
          : `The longest TTL is ${maxTtl}s, roughly ${Math.round((maxTtl ?? 0) / 3600)} hours. Long TTLs are a deliberate performance choice and are only a problem when something needs to change quickly.`,
        risk: tooShort
          ? 'Every cache miss becomes a fresh lookup, so a DNS outage becomes visible to users almost at once rather than being absorbed by caches.'
          : 'If a service has to be moved in an emergency — a compromised host, a failed provider — some resolvers will keep sending users to the old address until the cached record expires.',
        recommendation:
          'Aim for TTLs between 5 minutes and 24 hours on records that may need to change under pressure. Neither extreme is a security defect on its own.',
        evidence: {
          test: 'TTL read from the A, AAAA, MX and NS answers',
          observed: `${minTtl}s – ${maxTtl}s`,
          expected: `${MIN_SANE_TTL}s – ${MAX_SANE_TTL}s`,
          verification: 'Read directly from the DNS answers used elsewhere in this module.',
          limitation:
            'A resolver reports the remaining lifetime of its cached copy, not the value published in the zone, so the figure can read lower than what is actually configured.',
        },
      }),
    );
  }

  details.push({
    label: 'TTL range',
    value: ttls.length ? `${minTtl}s – ${maxTtl}s` : 'Not observed',
    tone: ttls.length === 0 ? 'neutral' : ttlSane ? 'good' : 'warn',
    mono: true,
  });

  /* ---------------- MX ---------------- */

  const mxKnown = mx.resolved;
  const hasMx = mxRecords.length > 0;
  const nullMx = mxRecords.length === 1 && /\s\.$/.test(mxRecords[0].data.trim());

  if (mxKnown && !hasMx) {
    findings.push(
      makeFinding(KEY, {
        title: 'No mail routing is published for this domain',
        severity: 'low',
        confidence: 'high',
        asset: domain,
        observed: `An MX query for ${domain} returned NOERROR with no answer records, confirmed via ${mx.resolvers.join(' and ')}.`,
        interpretation:
          'The domain cannot receive email. Where that is deliberate, the standards-conformant way to say so is a null MX record (`0 .`), which this domain does not publish either — so receiving servers will fall back to trying the A record instead of refusing immediately.',
        risk:
          'Bounce messages, abuse reports and security disclosures addressed to this domain have nowhere to arrive. A domain with no mail routing and no restrictive SPF is also a convenient forgery target, since nothing about it looks unusual to a recipient.',
        recommendation:
          'If the domain should never handle mail, publish `0 .` as its only MX record and `v=spf1 -all` as its SPF record. If it should handle mail, the MX records are missing.',
        evidence: {
          test: `DNS MX query for ${domain}`,
          observed: 'NOERROR, zero MX records',
          expected: 'Either mail exchanger records, or the null MX record `0 .`',
          verification: `Absence confirmed against ${mx.resolvers.join(' and ')}`,
        },
      }),
    );
  }

  details.push({
    label: 'Mail routing (MX)',
    value: nullMx
      ? 'Null MX — domain declares it accepts no mail'
      : hasMx
        ? mxRecords
            .map((r) => r.data.split(' ').slice(-1)[0].replace(/\.$/, ''))
            .slice(0, 4)
            .join(', ')
        : mxKnown
          ? 'None published'
          : 'Could not be checked',
    tone: hasMx ? 'good' : mxKnown ? 'warn' : 'neutral',
    mono: true,
  });

  /* ---------------- Nameservers ---------------- */

  /*
   * Two things are checkable from outside without touching the nameservers
   * directly: how many there are, and whether each published name resolves. A
   * delegation naming a host that does not resolve is a real defect — the
   * parent zone is sending resolvers somewhere that cannot be reached.
   */
  const nsNames = nsRecords.map((r) => r.data.replace(/\.$/, '').toLowerCase()).sort();
  const nsResolution = await Promise.all(
    nsNames.slice(0, 8).map(async (name) => {
      const res = await dnsQuery(name, 'A', { confirmAbsence: false });
      if (!res.resolved) return { name, state: 'unknown' as const };
      const v4 = answersOfType(res, 'A').length > 0;
      if (v4) return { name, state: 'resolves' as const };
      const v6 = await dnsQuery(name, 'AAAA', { confirmAbsence: false });
      if (!v6.resolved) return { name, state: 'unknown' as const };
      return {
        name,
        state: answersOfType(v6, 'AAAA').length > 0 ? ('resolves' as const) : ('missing' as const),
      };
    }),
  );

  const unresolvableNs = nsResolution.filter((n) => n.state === 'missing');
  const nsCheckedFully =
    nsResolution.length > 0 && nsResolution.every((n) => n.state !== 'unknown');
  const nsKnown = ns.resolved && (nsRecords.length === 0 || nsCheckedFully);
  const nsHealthy = nsRecords.length >= 2 && unresolvableNs.length === 0;

  if (unresolvableNs.length > 0) {
    findings.push(
      makeFinding(KEY, {
        title: 'A published nameserver does not resolve to an address',
        severity: 'medium',
        confidence: 'high',
        asset: unresolvableNs.map((n) => n.name).join(', '),
        observed: `${unresolvableNs.map((n) => n.name).join(', ')} ${unresolvableNs.length === 1 ? 'is' : 'are'} listed as authoritative for ${domain}, but A and AAAA queries for ${unresolvableNs.length === 1 ? 'that name' : 'those names'} return no address.`,
        interpretation:
          'The delegation points at a host that cannot be reached, which is the classic signature of a lame delegation — usually a nameserver decommissioned or renamed without the delegation being updated.',
        risk:
          'Resolvers will spend time on the unreachable server before falling back to a working one, which shows up as intermittent slow lookups. If a name in the delegation ever becomes registrable by someone else, they inherit authority over this zone for any resolver that picks them.',
        recommendation:
          'Remove the stale nameserver from the delegation at the registrar, and confirm the remaining set matches what the DNS provider expects.',
        evidence: {
          test: 'Each published NS name queried for A, then AAAA',
          observed: unresolvableNs.map((n) => `${n.name} → no address`).join('; '),
          expected: 'Every nameserver in the delegation resolving to at least one address',
          verification: 'Both address families were queried before a name was reported as unresolvable.',
          limitation:
            'Klyro did not query these nameservers directly, so it cannot say whether the ones that do resolve are actually serving the zone consistently.',
        },
      }),
    );
  }

  if (ns.resolved && nsRecords.length === 1) {
    findings.push(
      makeFinding(KEY, {
        title: 'Only one nameserver is published for this domain',
        severity: 'medium',
        confidence: 'high',
        asset: domain,
        observed: `The NS query for ${domain} returned exactly one record: ${nsRecords[0]?.data ?? ''}.`,
        interpretation:
          'The delegation has no redundancy. RFC 1034 expects at least two authoritative nameservers so that the loss of one does not remove the zone from the internet.',
        risk:
          'If that single server becomes unreachable — an outage, a network partition, a denial-of-service against the provider — the website and email for this domain stop resolving worldwide until it returns. There is no failover path.',
        recommendation:
          'Publish at least two nameservers, ideally on separate networks or from separate providers. Every managed DNS provider includes this by default.',
        evidence: {
          test: `DNS NS query for ${domain}`,
          observed: nsRecords[0]?.data ?? '',
          expected: 'Two or more NS records',
          verification: `Answered by ${ns.resolvers.join(' and ')}`,
        },
      }),
    );
  }

  /* ---------------- Nameserver operator diversity ----------------
     Distinct from the count. Two nameservers are redundancy against one
     machine failing; two *operators* are redundancy against one company
     failing. `gwa.fe.bosch.de` and `gwa2.fe.bosch.de` are two of the first and
     one of the second.

     Low severity throughout, and deliberately so. Plenty of organisations
     self-host DNS on genuinely redundant anycast infrastructure that is
     invisible from the outside, so this is a resilience note rather than a
     misconfiguration — and the finding says as much. */

  const nsOperators = [...new Set(nsNames.map((name) => dnsOperatorOf(name)))].sort();
  /*
   * The eTLD+1 reduction is a heuristic, not the Public Suffix List. Where a
   * nameserver name ends in a two-label suffix the heuristic does not know,
   * two unrelated operators can collapse into one — so the conclusion is only
   * drawn where every name reduced unambiguously. Names matched to a known
   * provider family skip that concern entirely: the provider is identified,
   * not inferred from the suffix.
   */
  const operatorsCertain = nsNames.every(
    (name) => isNamedProvider(dnsOperatorOf(name)) || registrableDomainIsCertain(name),
  );
  const diversityKnown = ns.resolved && nsNames.length >= 2 && operatorsCertain;
  const singleOperator = diversityKnown && nsOperators.length === 1;
  const selfHosted =
    singleOperator && !isNamedProvider(nsOperators[0]) && looksSameOrganisation(nsOperators[0], domain);

  if (singleOperator) {
    findings.push(
      makeFinding(KEY, {
        title: 'All nameservers are operated by a single provider',
        severity: 'low',
        confidence: 'high',
        asset: domain,
        observed: `All ${nsNames.length} nameservers for ${domain} (${nsNames.join(', ')}) belong to a single DNS operator, ${nsOperators[0]}.`,
        interpretation:
          `DNS resolution for this domain depends on one operator's infrastructure. There is no secondary provider that would continue answering queries if this operator has an outage.` +
          (selfHosted
            ? ` The operator domain appears to belong to the same organisation as ${domain} rather than to a third-party DNS provider, so this is self-hosted DNS.`
            : ''),
        risk:
          'If the nameserver operator experiences downtime or is targeted directly — a denial-of-service against their DNS infrastructure, for instance — this domain becomes unreachable at the same moment, since there is no independent secondary path. Nothing here suggests that has happened or is likely.',
        recommendation:
          'Consider adding a secondary DNS provider, or confirm the current operator\'s own infrastructure has redundancy — anycast, multiple physical locations — even though it presents as a single domain here.',
        evidence: {
          test: `NS records retrieved for ${domain}, each nameserver hostname resolved to its operator — a known managed-DNS provider where the name matches one, otherwise the registrable domain`,
          observed: nsNames.map((name) => `${name} → ${dnsOperatorOf(name)}`).join('; '),
          expected: 'Nameservers spanning more than one distinct operator domain',
          verification: `Read directly from DNS NS records, answered by ${ns.resolvers.join(' and ')}.`,
          limitation:
            'Whether the single operator\'s own infrastructure has internal redundancy — multiple physical sites, anycast routing — is not visible from the nameserver hostnames alone. The operator grouping uses a heuristic list of public suffixes rather than the full Public Suffix List, so an unusual suffix could group two unrelated operators together.',
        },
      }),
    );
  }

  details.push(
    {
      label: 'Nameservers',
      value: nsNames.length
        ? `${nsNames.join(', ')}${unresolvableNs.length ? ` — ${unresolvableNs.length} do not resolve` : ''}`
        : ns.resolved
          ? 'None published'
          : 'Could not be checked',
      tone: nsHealthy ? 'good' : ns.resolved ? 'warn' : 'neutral',
      mono: true,
    },
    {
      label: 'Nameserver operators',
      value: !diversityKnown
        ? nsNames.length < 2
          ? 'Not applicable — fewer than two nameservers published'
          : 'Could not be established'
        : singleOperator
          ? `1 — ${nsOperators[0]}${selfHosted ? ' (appears self-hosted)' : ''}`
          : `${nsOperators.length} — ${nsOperators.join(', ')}`,
      tone: !diversityKnown ? 'neutral' : singleOperator ? 'warn' : 'good',
      mono: true,
    },
  );

  /* ---------------- SOA ---------------- */

  const soaKnown = soa.resolved;
  const soaRecord = soaRecords[0];
  let soaOk = false;
  let soaDetail = soaKnown ? 'Not published' : 'Could not be checked';
  if (soaRecord) {
    // SOA rdata: mname rname serial refresh retry expire minimum
    const parts = soaRecord.data.trim().split(/\s+/);
    const refresh = Number(parts[3]);
    const retry = Number(parts[4]);
    const expire = Number(parts[5]);
    soaOk =
      parts.length >= 7 &&
      Number.isFinite(refresh) &&
      refresh >= 600 &&
      Number.isFinite(retry) &&
      retry >= 300 &&
      Number.isFinite(expire) &&
      expire >= 604_800;
    soaDetail = `${parts[0]?.replace(/\.$/, '') ?? '?'} (refresh ${refresh}s, expire ${expire}s)`;
    if (!soaOk) {
      findings.push(
        makeFinding(KEY, {
          title: 'Zone transfer timings sit outside common guidance',
          severity: 'low',
          confidence: 'high',
          asset: domain,
          observed: `The SOA record reads: ${soaRecord.data}`,
          interpretation:
            'The refresh, retry or expire values differ from the ranges RFC 1912 suggests. Many managed DNS providers do not use zone transfers between their own nodes at all, in which case these fields are inert and the deviation means nothing.',
          risk:
            'Where secondary nameservers do rely on zone transfers, a short expire value means a secondary stops answering sooner during an extended loss of contact with the primary, shortening the window in which the zone survives an outage.',
          recommendation:
            'Confirm with the DNS provider whether these values are used. If secondaries do transfer the zone, align refresh with at least 20 minutes and expire with at least 7 days.',
          evidence: {
            test: `DNS SOA query for ${domain}`,
            observed: soaRecord.data,
            expected: 'refresh ≥ 600s, retry ≥ 300s, expire ≥ 604800s (RFC 1912)',
            verification: `Answered by ${soa.resolvers.join(' and ')}`,
            limitation:
              'Whether these values are honoured depends on the provider\'s internal replication, which is not visible from outside.',
          },
        }),
      );
    }
  } else if (soaKnown) {
    findings.push(
      makeFinding(KEY, {
        title: 'No zone authority record was returned',
        severity: 'medium',
        confidence: 'high',
        asset: domain,
        observed: `An SOA query for ${domain} returned NOERROR with no answer, confirmed via ${soa.resolvers.join(' and ')}.`,
        interpretation:
          'Every DNS zone is required to have exactly one SOA record. Its absence usually means the name is not a zone apex in its own right — the domain may be delegated only partially, or the queried name sits inside a parent zone rather than owning one.',
        risk:
          'A zone in this state can behave inconsistently between resolvers, and DNSSEC signing and zone transfers both depend on the SOA being present.',
        recommendation:
          'Confirm with the DNS provider that the zone exists and is fully delegated, and that all nameservers in the delegation are serving it.',
        evidence: {
          test: `DNS SOA query for ${domain}`,
          observed: 'NOERROR, zero SOA records',
          expected: 'Exactly one SOA record at a zone apex',
          verification: `Absence confirmed against ${soa.resolvers.join(' and ')}`,
        },
      }),
    );
  }

  /* ---------------- IPv6 ----------------
     Reported, never scored.

     Absence of IPv6 is extremely common and is not a security weakness — it
     is a modernisation note. There is also no spare weight in this category:
     the components below already total 100, and funding an IPv6 component
     would mean taking points from DNSSEC or nameserver resilience, both of
     which describe real exposure. So it goes in the informational section
     alongside the other observations that carry no score. */

  const wwwAaaaRecords = answersOfType(wwwAaaa, 'AAAA');
  const ipv6Known = aaaa.resolved && wwwAaaa.resolved;
  const hasIpv6 = aaaaRecords.length > 0 || wwwAaaaRecords.length > 0;

  if (ipv6Known && !hasIpv6) {
    findings.push(
      makeFinding(KEY, {
        title: 'No IPv6 address record is published',
        severity: 'info',
        confidence: 'high',
        asset: domain,
        observed: `AAAA queries for ${domain} and www.${domain} returned NOERROR with no answer records. The domain is reachable over IPv4 only.`,
        interpretation:
          'The domain publishes no IPv6 address. This is the common case rather than the exception, and it is a modernisation note rather than a defect — nothing about a domain\'s security posture follows from it.',
        risk:
          'None is claimed. IPv6-only clients reach the site through their network provider\'s translation layer, which is normal and works. This is recorded for completeness and carries no score.',
        recommendation:
          'No action is required. If IPv6 is on the roadmap, most CDNs and load balancers enable it with a single setting and no change to the application.',
        evidence: {
          test: `DNS AAAA query for ${domain} and www.${domain}`,
          observed: 'NOERROR, zero AAAA answer records for both names',
          expected: 'Not applicable — IPv6 is optional and its absence is not a weakness',
          verification: `Both names queried; absence re-asked against a second resolver before being reported. Answered by ${[...new Set([...aaaa.resolvers, ...wwwAaaa.resolvers])].join(' and ')}.`,
          limitation:
            'Only the apex and www were checked. Other hosts under this domain may publish IPv6 independently.',
        },
      }),
    );
  }

  details.push(
    {
      label: 'IPv6 (AAAA)',
      value: !ipv6Known
        ? 'Could not be checked'
        : hasIpv6
          ? `Published${aaaaRecords.length ? ` at the apex${wwwAaaaRecords.length ? ' and www' : ''}` : ' at www'}`
          : 'Not published — IPv4 only (informational, not scored)',
      tone: !ipv6Known ? 'neutral' : hasIpv6 ? 'good' : 'neutral',
    },
    {
      label: 'Zone authority (SOA)',
      value: truncate(soaDetail, 90),
      tone: soaOk ? 'good' : soaKnown ? 'warn' : 'neutral',
      mono: true,
    },
    {
      label: 'Address records',
      value:
        [
          aRecords.length ? `${aRecords.length} IPv4` : null,
          aaaaRecords.length ? `${aaaaRecords.length} IPv6` : null,
        ]
          .filter(Boolean)
          .join(' · ') || (a.resolved && aaaa.resolved ? 'None' : 'Could not be checked'),
      tone:
        aRecords.length || aaaaRecords.length ? 'good' : a.resolved && aaaa.resolved ? 'warn' : 'neutral',
    },
    { label: 'TXT records', value: txt.resolved ? String(txtRecords.length) : 'Could not be checked', mono: true },
    {
      label: 'Resolvers consulted',
      value: [...new Set([...a.resolvers, ...ns.resolvers, ...soa.resolvers])].join(', ') || 'None',
    },
  );

  /* ---------------- Score ----------------
     Anything that could not be observed is dropped and the rest rescaled, so a
     resolver failure lowers confidence rather than the domain's score. */

  const components: ScoreComponent[] = [
    {
      label: 'DNSSEC signing',
      value: dnssecScore,
      max: 25,
      known: dnssec !== 'unknown',
      note: dnssecNote,
    },
    {
      label: 'Alias targets resolve',
      value: noDangling ? 20 : 0,
      max: 20,
      // With no CNAME to test, there is nothing to dangle — that is a real
      // negative, not an unknown one.
      known: danglingKnown || cnameTargets.length === 0,
      note:
        cnameTargets.length === 0
          ? 'No CNAME records at the apex or www, so there is nothing that could dangle.'
          : noDangling
            ? `All ${cnameTargets.length} alias targets resolve to an address.`
            : `${dangling.length} alias target(s) resolve to nothing.`,
    },
    {
      /*
       * Operator diversity is folded in here rather than given a component of
       * its own, for two reasons. It is the same property — how much has to
       * fail before the zone stops answering — and the category's components
       * already total 100, so a new one would have to take weight from DNSSEC
       * or CAA. The deduction is 4 of 20, matching the low severity of the
       * finding: a single competent operator is a normal, defensible choice.
       */
      label: 'Nameserver resilience',
      value: nsHealthy ? (singleOperator ? 16 : 20) : nsRecords.length >= 2 ? 8 : 0,
      max: 20,
      known: nsKnown,
      note: !nsKnown
        ? 'Nameserver resolution could not be completed, so this component was dropped.'
        : nsHealthy
          ? singleOperator
            ? `${nsRecords.length} nameservers published and all resolving, but all under one operator (${nsOperators[0]}) — 4 points held back for the absence of a second independent provider.`
            : `${nsRecords.length} nameservers published, all resolving${diversityKnown ? `, across ${nsOperators.length} distinct operators` : ''}.`
          : nsRecords.length >= 2
            ? `${nsRecords.length} nameservers published, ${unresolvableNs.length} of which do not resolve.`
            : `${nsRecords.length} nameserver published — no redundancy.`,
    },
    {
      label: 'Certificate issuance policy (CAA)',
      value: hasCaa ? 10 : 0,
      max: 10,
      known: caaKnown,
      note: !caaKnown
        ? 'The CAA lookup did not resolve, so this component was dropped.'
        : hasCaa
          ? `Issuance restricted to ${caaIssuers.join(', ') || 'the named authorities'}.`
          : 'No CAA record, so any publicly trusted authority may issue for this name.',
    },
    {
      label: 'Zone authority record',
      value: soaOk ? 10 : soaRecord ? 6 : 0,
      max: 10,
      known: soaKnown,
      note: !soaKnown
        ? 'The SOA lookup did not resolve, so this component was dropped.'
        : soaOk
          ? 'SOA present with timings inside RFC 1912 guidance.'
          : soaRecord
            ? 'SOA present, timings outside RFC 1912 guidance.'
            : 'No SOA record returned.',
    },
    {
      label: 'Cache lifetimes',
      value: ttlSane ? 8 : 4,
      max: 8,
      known: ttls.length > 0,
      note:
        ttls.length === 0
          ? 'No TTLs were observed, so this component was dropped.'
          : ttlSane
            ? `TTLs from ${minTtl}s to ${maxTtl}s, inside normal ranges.`
            : `TTLs from ${minTtl}s to ${maxTtl}s, outside the ${MIN_SANE_TTL}s–${MAX_SANE_TTL}s range.`,
    },
    {
      label: 'Mail routing declared',
      value: hasMx || nullMx ? 7 : 3,
      max: 7,
      known: mxKnown,
      note: !mxKnown
        ? 'The MX lookup did not resolve, so this component was dropped.'
        : nullMx
          ? 'Null MX published — the domain explicitly declares it accepts no mail.'
          : hasMx
            ? `${mxRecords.length} mail exchanger(s) published.`
            : 'Neither mail exchangers nor a null MX record are published.',
    },
  ];

  const { score, coverage, breakdown } = scoreFromComponents(components);

  if (coverage <= 0) {
    throw new Error('No DNS observation could be completed for this domain.');
  }

  if (coverage < 0.999) {
    details.push({
      label: 'Assessed weight',
      value: `${Math.round(coverage * 100)}% — unreachable checks were excluded, not counted against the domain`,
      tone: 'neutral',
    });
  }

  const summary =
    dnssec === 'validating'
      ? `The zone is signed with DNSSEC${noDangling ? ' and every alias target resolves' : ', but contains alias records pointing at nothing'}.`
      : dnssec === 'unknown'
        ? `DNS records are published${noDangling ? '' : ' but include alias records pointing at nothing'}; DNSSEC status could not be established in this run.`
        : `DNS records are published without DNSSEC signing${noDangling ? '' : ' and include alias records pointing at nothing'}.`;

  const facts = {
    nameservers: nsNames,
    mailHosts: mxRecords
      .map((r) => r.data.split(' ').slice(-1)[0].replace(/\.$/, '').toLowerCase())
      .sort(),
    ipv4: aRecords.map((r) => r.data),
    ipv6: aaaaRecords.map((r) => r.data),
    dnssec: dnssec === 'validating',
    caa: caaIssuers,
    wildcard: hasWildcard,
  };

  return { score, summary, findings, details, scoreBreakdown: breakdown, moduleCoverage: coverage, facts };
}
