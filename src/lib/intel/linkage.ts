import type { ScanResult } from '../types';
import type { OwnershipRecord } from './ownership';

/**
 * Parent-influence assessment.
 *
 * The question a due-diligence reader actually needs answered is not "who owns
 * this company" but "does the owner's security posture reach this product?"
 * Those are different questions, and the second one is usually assumed rather
 * than tested.
 *
 * Being owned by a large, well-governed group tells you nothing on its own.
 * Acquired subsidiaries routinely run their own DNS, their own mail, their own
 * certificates and their own registrar for years after acquisition — the
 * parent's controls simply do not apply to them. So instead of inheriting the
 * parent's reputation, this module measures how much infrastructure the two
 * actually share, and states plainly what that does and does not imply.
 */

export type LinkageVerdict = 'integrated' | 'partially_integrated' | 'independent' | 'unknown';

export interface LinkageSignal {
  label: string;
  shared: boolean | null;
  vendorValue: string;
  parentValue: string;
}

export interface ParentInfluenceAssessment {
  vendorDomain: string;
  parentDomain: string | null;
  parentName: string | null;
  verdict: LinkageVerdict;
  signalsShared: number;
  signalsTested: number;
  signals: LinkageSignal[];
  vendorScore: number | null;
  parentScore: number | null;
  scoreDelta: number | null;
  /** Plain-English explanation, assembled from the measured signals. */
  narrative: string;
  assessedAt: string;
}

const MULTIPART = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'com.au', 'co.nz', 'co.za', 'com.br', 'co.jp',
  'co.kr', 'co.in', 'com.cn', 'com.sg', 'com.tr', 'com.sa', 'com.mx',
]);

/**
 * Operators that publish across several registrable domains, where reducing to
 * the registrable domain splits one provider into several.
 *
 * Route 53 hands `awsdns-07.org` to one zone and `awsdns-52.com` to the next,
 * and Google Workspace answers on both `google.com` and `googlemail.com` — the
 * general rule below would report one operator as four, and two domains hosted
 * side by side as sharing nothing. Listed explicitly rather than guessed by
 * pattern, because merging two genuinely separate operators is the worse error.
 */
const PROVIDER_FAMILIES: { test: RegExp; name: string }[] = [
  { test: /(^|\.)awsdns-\d+\.(com|net|org|co\.uk)$/, name: 'Amazon Route 53' },
  { test: /(^|\.)azure-dns\.(com|net|org|info)$/, name: 'Azure DNS' },
  { test: /(^|\.)ultradns\.(com|net|org|biz|info|co\.uk)$/, name: 'UltraDNS' },
  { test: /(^|\.)(google|googlemail)\.com$/, name: 'Google' },
];

/** Reduce a host to the organisation that operates it. */
export function provider(host: string): string {
  const clean = host.toLowerCase().replace(/\.$/, '');

  const family = PROVIDER_FAMILIES.find((f) => f.test.test(clean));
  if (family) return family.name;

  const parts = clean.split('.');
  if (parts.length <= 2) return parts.join('.');
  const lastTwo = parts.slice(-2).join('.');
  return MULTIPART.has(lastTwo) ? parts.slice(-3).join('.') : lastTwo;
}

export function providerSet(hosts: unknown): Set<string> {
  if (!Array.isArray(hosts)) return new Set();
  return new Set(
    hosts.filter((h): h is string => typeof h === 'string' && h.length > 0).map(provider),
  );
}

function overlaps(a: Set<string>, b: Set<string>): boolean {
  for (const x of a) if (b.has(x)) return true;
  return false;
}

/** The providers present on both sides, sorted so output is stable. */
export function intersect(a: Set<string>, b: Set<string>): string[] {
  return [...a].filter((x) => b.has(x)).sort();
}

/** Reads naturally in a sentence: "<domain> <relation>." */
function describeRelation(type: string, parentName: string): string {
  switch (type) {
    case 'acquired':
      return `was acquired by ${parentName}`;
    case 'subsidiary':
      return `is a subsidiary of ${parentName}`;
    case 'division':
      return `is a division of ${parentName}`;
    case 'joint_venture':
      return `is a joint venture in which ${parentName} holds a stake`;
    default:
      return `is corporately connected to ${parentName}`;
  }
}

function factsOf(scan: ScanResult, key: string): Record<string, unknown> {
  return (scan.categories.find((c) => c.key === key)?.facts ?? {}) as Record<string, unknown>;
}

function str(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

export function assessParentInfluence(
  vendor: ScanResult,
  parent: ScanResult | null,
  ownership: OwnershipRecord,
): ParentInfluenceAssessment {
  const assessedAt = new Date().toISOString();

  const base: ParentInfluenceAssessment = {
    vendorDomain: vendor.domain,
    parentDomain: ownership.parentDomain,
    parentName: ownership.parentName,
    verdict: 'unknown',
    signalsShared: 0,
    signalsTested: 0,
    signals: [],
    vendorScore: vendor.compositeScore,
    parentScore: null,
    scoreDelta: null,
    narrative: '',
    assessedAt,
  };

  if (!ownership.parentName) {
    return {
      ...base,
      verdict: 'independent',
      narrative:
        'No parent or controlling owner was identified for this organisation, so its security posture stands entirely on its own. The scores in this report reflect systems this company operates and controls directly.',
    };
  }

  if (!parent) {
    return {
      ...base,
      narrative:
        `${vendor.domain} ${describeRelation(ownership.ownershipType, ownership.parentName)}, but the parent's own domain was not assessed in this run. ` +
        `Ownership alone does not tell you whether the parent's controls apply here — that depends on whether this product actually runs on the parent's infrastructure, which could not be tested. Treat the scores in this report as reflecting ${vendor.domain} on its own.`,
    };
  }

  /* ---------------- Measure shared infrastructure ---------------- */

  const vDns = factsOf(vendor, 'dns');
  const pDns = factsOf(parent, 'dns');
  const vSsl = factsOf(vendor, 'ssl');
  const pSsl = factsOf(parent, 'ssl');
  const vWho = factsOf(vendor, 'whois');
  const pWho = factsOf(parent, 'whois');

  const signals: LinkageSignal[] = [];

  const vNs = providerSet(vDns.nameservers);
  const pNs = providerSet(pDns.nameservers);
  if (vNs.size && pNs.size) {
    signals.push({
      label: 'DNS hosting',
      shared: overlaps(vNs, pNs),
      vendorValue: [...vNs].join(', '),
      parentValue: [...pNs].join(', '),
    });
  }

  const vMx = providerSet(vDns.mailHosts);
  const pMx = providerSet(pDns.mailHosts);
  if (vMx.size && pMx.size) {
    signals.push({
      label: 'Email platform',
      shared: overlaps(vMx, pMx),
      vendorValue: [...vMx].join(', '),
      parentValue: [...pMx].join(', '),
    });
  }

  const vIssuer = str(vSsl.issuer);
  const pIssuer = str(pSsl.issuer);
  if (vIssuer && pIssuer) {
    signals.push({
      label: 'Certificate authority',
      shared: vIssuer.toLowerCase() === pIssuer.toLowerCase(),
      vendorValue: vIssuer,
      parentValue: pIssuer,
    });
  }

  const vReg = str(vWho.registrar);
  const pReg = str(pWho.registrar);
  if (vReg && pReg && vReg !== 'Not disclosed' && pReg !== 'Not disclosed') {
    signals.push({
      label: 'Domain registrar',
      shared: vReg.toLowerCase() === pReg.toLowerCase(),
      vendorValue: vReg,
      parentValue: pReg,
    });
  }

  const tested = signals.length;
  const shared = signals.filter((s) => s.shared === true).length;

  let verdict: LinkageVerdict = 'unknown';
  if (tested >= 2) {
    const ratio = shared / tested;
    verdict = ratio >= 0.6 ? 'integrated' : ratio > 0 ? 'partially_integrated' : 'independent';
  }

  const delta = vendor.compositeScore - parent.compositeScore;

  /* ---------------- Narrative ---------------- */

  const relation = describeRelation(ownership.ownershipType, ownership.parentName);

  const sharedLabels = signals.filter((s) => s.shared).map((s) => s.label.toLowerCase());
  const separateLabels = signals.filter((s) => s.shared === false).map((s) => s.label.toLowerCase());

  const list = (items: string[]) =>
    items.length <= 1
      ? items[0] ?? ''
      : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;

  let linkage: string;
  switch (verdict) {
    case 'integrated':
      linkage =
        `Measured against the parent's own domain, the two share ${list(sharedLabels)}. ` +
        `That is meaningful: it indicates the parent's platform teams operate the infrastructure behind ${vendor.domain}, so group-level standards and controls plausibly do apply here` +
        (separateLabels.length ? `, although ${list(separateLabels)} remain separate.` : '.');
      break;
    case 'partially_integrated':
      linkage =
        `The two share ${list(sharedLabels)}, but ${list(separateLabels)} are operated separately. ` +
        `This is the common pattern after an acquisition: some services migrate to the parent while others stay on the original stack. The parent's standards reach part of this estate, not all of it.`;
      break;
    case 'independent':
      linkage =
        `Every infrastructure signal tested — ${list(signals.map((s) => s.label.toLowerCase()))} — is operated separately from ${ownership.parentName}. ` +
        `On the evidence, this business runs its own stack. The parent's security programme, however strong, is not visibly applied to the systems assessed here.`;
      break;
    default:
      linkage =
        `Not enough infrastructure signals could be compared to judge how closely the two are integrated.`;
  }

  const comparison =
    delta === 0
      ? `Both domains score ${vendor.compositeScore}.`
      : delta > 0
        ? `${vendor.domain} scores ${vendor.compositeScore}, ${delta} points above the parent's own domain (${parent.compositeScore}).`
        : `${vendor.domain} scores ${vendor.compositeScore}, ${Math.abs(delta)} points below the parent's own domain (${parent.compositeScore}).`;

  const caution =
    verdict === 'independent' || verdict === 'partially_integrated'
      ? `Do not read the parent's reputation as assurance for this vendor. ${comparison} You are contracting with the entity that operates these systems, and the evidence above is what that entity actually does.`
      : `${comparison} Even where infrastructure is shared, a parent's brand strength is not evidence of the subsidiary's controls — the shared platform is. Assess the group's security programme directly if it materially affects your decision.`;

  return {
    ...base,
    verdict,
    signalsShared: shared,
    signalsTested: tested,
    signals,
    parentScore: parent.compositeScore,
    scoreDelta: delta,
    narrative: `${vendor.domain} ${relation}. ${linkage} ${caution}`,
  };
}
