import { CATEGORY_LABELS, CATEGORY_ORDER } from '../constants';
import type {
  CategoryGap,
  CategoryKey,
  CategoryResult,
  ConcernLevel,
  RelationshipAssessment,
  RelationshipConcern,
  SharedDependency,
} from '../types';
import { intersect, providerSet } from './linkage';

/**
 * Buyer-context assessment.
 *
 * The ten checks answer "how exposed is this vendor?". A procurement reader is
 * asking a different question: "what does that mean for *us*?" Those diverge in
 * two ways this module can actually measure.
 *
 * First, a gap is only meaningful against a standard. A vendor scoring 62 on
 * HTTP headers is unremarkable next to an organisation scoring 58, and is a
 * conversation next to one scoring 95 — the second reader is being asked to
 * accept less than they already enforce on themselves.
 *
 * Second, and less obvious: two organisations that share an upstream provider
 * fail together. That is invisible in either report on its own. It is not a
 * weakness in either party — it is a property of the pair — and it is exactly
 * the thing a continuity plan gets wrong, because the plan usually assumes you
 * can reach your supplier during your own incident.
 *
 * Everything here is reported and never scored. The vendor's composite is
 * measured on the vendor's domain; a second party's evidence has no business
 * moving it.
 */

/** The minimum shape needed to compare a domain — `ScanResult` satisfies it. */
export interface PostureSnapshot {
  domain: string;
  compositeScore: number;
  coverage: number;
  categories: CategoryResult[];
}

/* ------------------------------------------------------------------ *
 * Copy
 * ------------------------------------------------------------------ */

/**
 * What a gap on each check costs the *reader*, not the vendor. The vendor-side
 * consequence is already in the main report; repeating it here would waste the
 * one section written from the buyer's chair.
 */
const GAP_COPY: Record<CategoryKey, { consequence: string; ask: string }> = {
  emailSecurity: {
    consequence:
      'Mail claiming to come from them can be forged, and your own sender policy does nothing about it — it governs your name, not theirs.',
    ask: 'Ask when they will publish an enforcing DMARC policy, and put a date on it.',
  },
  ssl: {
    consequence:
      'Traffic between your people and their service is protected by a certificate configuration weaker than the one you require of yourself.',
    ask: 'Ask for their TLS configuration standard and their certificate renewal process, including who is paged when one lapses.',
  },
  dns: {
    consequence:
      'The records that route your staff and customers to their service carry less tamper protection than your own. A hijack there redirects your users, and it will look to them like your problem.',
    ask: 'Ask whether DNSSEC and registrar locking are on their roadmap for the domain serving your integration.',
  },
  headers: {
    consequence:
      'Their application leaves browser-side defences switched off that you switch on. Anything your staff do inside their product runs with fewer protections than inside yours.',
    ask: 'Ask for their application security testing cadence — headers are cheap, and a gap here usually indicates the review that would have caught it is not happening.',
  },
  subdomains: {
    consequence:
      'Their public estate is broader than yours. Every additional published host is another way in to an organisation that may hold your data.',
    ask: 'Ask who owns decommissioning of retired hosts, and when the estate was last inventoried.',
  },
  exposedPaths: {
    consequence:
      'Administrative or developer resources on their side answer to the open internet. This is the closest thing in the report to a live foothold on a supplier.',
    ask: 'Raise the specific paths in the finding register directly and ask for confirmation they are intentional.',
  },
  whois: {
    consequence:
      'Their domain registration is less protected than yours. Expiry, transfer or ownership failures on their side interrupt a service you depend on, with no warning to you.',
    ask: 'Ask for their domain renewal ownership and whether registrar transfer lock is enabled.',
  },
  cookies: {
    consequence:
      'Session cookies on their site carry fewer theft protections than yours. If your staff hold accounts there, those are the weaker sessions.',
    ask: 'Ask whether their authenticated application applies stricter cookie flags than the public site assessed here.',
  },
  cors: {
    consequence:
      'Their site permits other origins to read its responses more freely than yours does, which widens who can pull data out of a system you feed.',
    ask: 'Ask which origins are permitted against their API hosts, not just the marketing site.',
  },
  robotsSecurity: {
    consequence:
      'They publish no route for a researcher to report a vulnerability. Problems found in a system you depend on have nowhere to land.',
    ask: 'Ask for a named security contact and add it to the contract, not just to a wiki page.',
  },
  technologies: {
    consequence:
      'Their public site loads code from more outside companies than yours does, or publishes more about the software it runs. Anyone who can change what one of those suppliers serves can change what runs for your staff while they are using their product.',
    ask: 'Ask which third-party scripts run on pages your staff authenticate through, and whether they enforce Subresource Integrity or a script-src policy on them.',
  },
};

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function factsOf(snapshot: PostureSnapshot, key: CategoryKey): Record<string, unknown> {
  return (snapshot.categories.find((c) => c.key === key)?.facts ?? {}) as Record<string, unknown>;
}

/** Score for a check, or null when that check could not be assessed. */
function scoreOf(snapshot: PostureSnapshot, key: CategoryKey): number | null {
  const category = snapshot.categories.find((c) => c.key === key);
  return category && category.status === 'assessed' ? category.score : null;
}

function str(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function list(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

const LEVEL_RANK: Record<ConcernLevel, number> = { high: 0, medium: 1, low: 2, note: 3 };

/* ------------------------------------------------------------------ *
 * Shared upstream providers
 * ------------------------------------------------------------------ */

function sharedDependencies(you: PostureSnapshot, vendor: PostureSnapshot): SharedDependency[] {
  const found: SharedDependency[] = [];

  const yDns = factsOf(you, 'dns');
  const vDns = factsOf(vendor, 'dns');

  const ns = intersect(providerSet(yDns.nameservers), providerSet(vDns.nameservers));
  if (ns.length) found.push({ key: 'dns', label: 'DNS hosting', provider: list(ns) });

  const mx = intersect(providerSet(yDns.mailHosts), providerSet(vDns.mailHosts));
  if (mx.length) found.push({ key: 'mail', label: 'Email platform', provider: list(mx) });

  const yIssuer = str(factsOf(you, 'ssl').issuer);
  const vIssuer = str(factsOf(vendor, 'ssl').issuer);
  if (yIssuer && vIssuer && yIssuer.toLowerCase() === vIssuer.toLowerCase()) {
    found.push({ key: 'ca', label: 'Certificate authority', provider: vIssuer });
  }

  const yReg = str(factsOf(you, 'whois').registrar);
  const vReg = str(factsOf(vendor, 'whois').registrar);
  if (
    yReg &&
    vReg &&
    yReg !== 'Not disclosed' &&
    vReg !== 'Not disclosed' &&
    yReg.toLowerCase() === vReg.toLowerCase()
  ) {
    found.push({ key: 'registrar', label: 'Domain registrar', provider: vReg });
  }

  return found;
}

function concentrationConcern(
  dep: SharedDependency,
  vendorDomain: string,
  heavy: boolean,
): RelationshipConcern {
  const base = { id: `shared-${dep.key}`, kind: 'concentration' as const, evidence: dep.provider };

  switch (dep.key) {
    case 'dns':
      return {
        ...base,
        level: heavy ? 'high' : 'medium',
        title: `You and ${vendorDomain} both resolve through ${dep.provider}`,
        detail:
          `Your domain and theirs are served by the same DNS provider. That is not a weakness in either party — it is a property of the pair. ` +
          `An outage or compromise at ${dep.provider} takes both of you off the internet in the same minute, which is precisely the minute you would want to reach them.`,
        watchFor: `Agree an out-of-band contact route with this supplier now, while everything is working. A support portal that resolves through ${dep.provider} is not one.`,
      };
    case 'mail':
      return {
        ...base,
        level: heavy ? 'high' : 'medium',
        title: `Both organisations receive mail through ${dep.provider}`,
        detail:
          `You and ${vendorDomain} depend on the same email platform. A platform-wide incident removes the channel you would use to coordinate with this supplier at exactly the moment you need it, ` +
          `and a compromise there reaches both sets of mailboxes through one door.`,
        watchFor: `Record a phone number and a named contact for this vendor somewhere that does not depend on ${dep.provider}.`,
      };
    case 'ca':
      return {
        ...base,
        level: 'low',
        title: `Both certificates are issued by ${dep.provider}`,
        detail:
          `Your site and theirs are certified by the same authority. Mass revocation events are rare but real, and when one happens you and this vendor would be re-issuing at the same time, from the same queue.`,
        watchFor:
          'Confirm they can re-issue certificates without waiting on a third party, and how long it takes them.',
      };
    case 'registrar':
      return {
        ...base,
        level: 'low',
        title: `Both domains are registered through ${dep.provider}`,
        detail:
          `You and ${vendorDomain} hold your domain names at the same registrar. Account compromise, a billing lapse or a policy suspension there is a single event that can affect both names.`,
        watchFor:
          'Check that registrar transfer lock and multi-factor authentication are enabled on your own account — it is the cheapest control on this page.',
      };
  }
}

/* ------------------------------------------------------------------ *
 * Assessment
 * ------------------------------------------------------------------ */

/** Below this the comparison is noise rather than a standards difference. */
const MATERIAL_GAP = 20;

/** Concern counts, capped so the section stays readable. */
const MAX_GAP_CONCERNS = 4;
const MAX_RECIPROCAL_CONCERNS = 2;

export function assessRelationship(
  vendor: PostureSnapshot,
  you: PostureSnapshot,
): RelationshipAssessment {
  const assessedAt = new Date().toISOString();
  const scoreDelta = you.compositeScore - vendor.compositeScore;

  /* ---------------- Divergence per check ---------------- */

  /** Checks where the vendor is behind the reader. */
  const behind: CategoryGap[] = [];
  /** Checks where the reader is behind the vendor. */
  const ahead: CategoryGap[] = [];

  for (const key of CATEGORY_ORDER) {
    const yourScore = scoreOf(you, key);
    const vendorScore = scoreOf(vendor, key);
    if (yourScore === null || vendorScore === null) continue;

    const delta = yourScore - vendorScore;
    const entry: CategoryGap = { key, label: CATEGORY_LABELS[key], yourScore, vendorScore, delta };

    // A gap only counts when the vendor is both behind you *and* not already
    // in good shape — being 25 points behind an outstanding score is not a
    // procurement problem.
    if (delta >= MATERIAL_GAP && vendorScore < 80) behind.push(entry);
    else if (-delta >= MATERIAL_GAP && yourScore < 80) ahead.push(entry);
  }

  behind.sort((a, b) => b.delta - a.delta);
  ahead.sort((a, b) => a.delta - b.delta);

  // Reported together and sorted by direction, so the ledger reads as one
  // comparison rather than as two lists that happen to share a table.
  const gaps = [...behind, ...ahead].sort((a, b) => b.delta - a.delta);

  /* ---------------- Shared upstream ---------------- */

  const sharedDeps = sharedDependencies(you, vendor);
  const heavy = sharedDeps.length >= 3;

  /* ---------------- Concerns ---------------- */

  const concerns: RelationshipConcern[] = [];

  // Impersonation first: it is the one exposure on this page that reaches the
  // reader's own staff directly rather than through the vendor's systems.
  const vendorEmail = scoreOf(vendor, 'emailSecurity');
  const yourEmail = scoreOf(you, 'emailSecurity');

  if (vendorEmail !== null && vendorEmail < 70) {
    concerns.push({
      id: 'impersonation',
      kind: 'impersonation',
      level: vendorEmail < 50 ? 'high' : 'medium',
      title: `Email claiming to come from ${vendor.domain} can be forged`,
      detail:
        yourEmail !== null && yourEmail >= 80
          ? `Your own domain publishes a strong sender policy, and that is the trap: it governs mail claiming to be from ${you.domain}, not from ${vendor.domain}. ` +
            `Their sender authentication scores ${vendorEmail}, so an outsider can put a convincing message in front of your finance team from a supplier they already trust, and nothing in your setup will mark it.`
          : `Their sender authentication scores ${vendorEmail}, so an outsider can send mail that appears to come from this supplier and your staff have no reliable way to tell. ` +
            `Your own domain scores ${yourEmail ?? 0} on the same check, so neither side is currently closing this off.`,
      watchFor:
        'Treat any change of bank details, invoice address or payment instruction arriving by email from this supplier as unverified until confirmed by voice — on a number you already held, never one contained in the message.',
      evidence: `emailSecurity ${vendor.domain} ${vendorEmail} / ${you.domain} ${yourEmail ?? 'n/a'}`,
    });
  }

  for (const dep of sharedDeps) {
    concerns.push(concentrationConcern(dep, vendor.domain, heavy));
  }

  for (const gap of behind.slice(0, MAX_GAP_CONCERNS)) {
    // Email is already covered above, and in sharper terms.
    if (gap.key === 'emailSecurity' && concerns.some((c) => c.kind === 'impersonation')) continue;

    const copy = GAP_COPY[gap.key];
    concerns.push({
      id: `gap-${gap.key}`,
      kind: 'standards-gap',
      level: gap.delta >= 40 || gap.vendorScore < 50 ? 'high' : 'medium',
      title: `${gap.label} sits ${gap.delta} points behind your own`,
      detail: `You score ${gap.yourScore} on this check; ${vendor.domain} scores ${gap.vendorScore}. ${copy.consequence}`,
      watchFor: copy.ask,
      evidence: `${gap.key} ${gap.vendorScore} vs ${gap.yourScore}`,
    });
  }

  for (const gap of ahead.slice(0, MAX_RECIPROCAL_CONCERNS)) {
    concerns.push({
      id: `reciprocal-${gap.key}`,
      kind: 'reciprocal',
      level: 'note',
      title: `They are ahead of you on ${gap.label}`,
      detail:
        `${vendor.domain} scores ${gap.vendorScore} here against your ${gap.yourScore}. This is not a risk the vendor brings to you — it is one you bring to them, ` +
        `and it is on this page because a comparison that only ran in one direction would not be worth reading.`,
      watchFor:
        'If this supplier issues its own security questionnaire, this is where you would answer badly. Cheaper to fix before the relationship makes it visible.',
      evidence: `${gap.key} ${gap.vendorScore} vs ${gap.yourScore}`,
    });
  }

  concerns.sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level]);

  /* ---------------- Narrative ---------------- */

  const headline =
    scoreDelta >= 15
      ? `${vendor.domain} scores ${vendor.compositeScore} against your ${you.compositeScore} — ${scoreDelta} points below the standard you hold yourself to.`
      : scoreDelta <= -15
        ? `${vendor.domain} scores ${vendor.compositeScore} against your ${you.compositeScore}. On public exposure, this supplier is the stronger of the two.`
        : `${vendor.domain} scores ${vendor.compositeScore} against your ${you.compositeScore}. On public exposure the two of you are closely matched.`;

  const material = concerns.filter((c) => c.level !== 'note');
  const highCount = material.filter((c) => c.level === 'high').length;

  const opening =
    material.length === 0
      ? 'Nothing in the public evidence changes how this relationship should be handled.'
      : `${material.length} thing${material.length === 1 ? '' : 's'} ${material.length === 1 ? 'is' : 'are'} worth raising before this relationship is signed` +
        `${highCount > 0 ? `, ${highCount} of them pressing` : ''}.`;

  const gapSentence = behind.length
    ? `They fall behind your own posture on ${list(behind.slice(0, 3).map((g) => g.label.toLowerCase()))}` +
      `${behind.length > 3 ? `, and on ${behind.length - 3} further check${behind.length - 3 === 1 ? '' : 's'}` : ''}.`
    : 'They do not fall materially behind your own posture on any check that could be assessed on both domains.';

  const sharedSentence = sharedDeps.length
    ? `You also share ${list(sharedDeps.map((d) => d.label.toLowerCase()))} with them. That is reported as concentration rather than as a fault — two well-run organisations on one platform still fail together.`
    : 'You share no upstream provider with them, so an incident at one of your providers does not automatically take the other offline.';

  const closing =
    'None of this describes what they actually hold for you. Impact depends on the data and the integration, and neither is visible from outside.';

  return {
    yourDomain: you.domain,
    vendorDomain: vendor.domain,
    yourScore: you.compositeScore,
    vendorScore: vendor.compositeScore,
    scoreDelta,
    yourCoverage: you.coverage,
    sharedDependencies: sharedDeps,
    gaps,
    concerns,
    headline,
    narrative: `${opening} ${gapSentence} ${sharedSentence} ${closing}`,
    limits: [
      'Klyro does not know what data this vendor holds for you, which of your systems it connects to, or how much of your operation depends on it. Those decide impact, and none of them are visible from outside.',
      'Both sides were assessed from public information only. The controls that usually decide whether a vendor incident becomes your incident — access management, encryption at rest, backup integrity, incident response — leave no external trace and are not represented here.',
      'A shared provider is reported as concentration, not as a criticism of either party. The finding is that you would lose both at once, not that either chose badly.',
      'Your own domain was assessed to produce this comparison and was not scored, ranked, stored, or added to any benchmark pool.',
    ],
    assessedAt,
  };
}
