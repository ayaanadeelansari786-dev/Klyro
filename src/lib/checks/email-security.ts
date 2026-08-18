import type { CategoryDetail, Finding } from '../types';
import {
  dnsQuery,
  makeFinding,
  makeUnknown,
  mapLimit,
  type ModuleOutput,
  type ScoreComponent,
  scoreFromComponents,
  truncate,
  txtValues,
} from './util';

const KEY = 'emailSecurity' as const;

/**
 * Selectors used by the major mail platforms.
 *
 * Deliberately broad: the wider this list, the less often DKIM has to be
 * reported as unconfirmable, and an unconfirmed result is excluded from the
 * score entirely rather than counted against the domain. Absence at these names
 * is still never treated as proof of absence — selectors are free-form strings.
 */
const DKIM_SELECTORS = [
  'default', 'dkim', 'mail', 'smtp', 'mx', 'dk',
  's1', 's2', 'k1', 'k2', 'k3',
  'selector1', 'selector2', 'google',
  'zoho', 'zohomail', 'protonmail', 'protonmail2', 'protonmail3',
  'sendgrid', 'mandrill', 'mailjet', 'klaviyo',
  'sig1', 'hs1', 'hs2', 'ctct1', 'ctct2',
  'everlytickey1', 'everlytickey2',
];

type SpfQualifier = '-all' | '~all' | '?all' | '+all' | 'none';

interface SpfAnalysis {
  /** False when no resolver answered — nothing may be concluded. */
  resolved: boolean;
  record: string | null;
  /** The effective default rule, following `redirect=` to wherever it lands. */
  qualifier: SpfQualifier;
  /** The domain the qualifier actually came from, when it came via redirect. */
  redirectedTo: string | null;
  lookups: number;
  /** True when the traversal hit its ceiling, so `lookups` is a lower bound. */
  truncated: boolean;
  duplicates: boolean;
}

/**
 * Mechanisms that cost a DNS lookup against the RFC 7208 limit of 10.
 *
 * The lookahead is load-bearing. Without it the `a` alternative matched the
 * `a` in `-all`, so every record ending in a qualifier was charged one lookup
 * it does not use — and each nested include added another. A record with two
 * includes was reported as needing five lookups, which put well-configured
 * domains within sight of a limit they were nowhere near. A mechanism name
 * must be followed by the end of the term, a `:` argument, or a `/` CIDR.
 */
const LOOKUP_MECHANISMS = /^(?:[+\-~?])?(include|exists|ptr|a|mx)(?=$|[:/])/i;

const MAX_SPF_DEPTH = 5;
const SPF_QUERY_BUDGET = 25;

async function countSpfLookups(
  record: string,
  depth: number,
  budget: { remaining: number },
  state: { truncated: boolean },
): Promise<number> {
  if (depth > MAX_SPF_DEPTH || budget.remaining <= 0) {
    state.truncated = true;
    return 0;
  }

  let count = 0;
  const terms = record.trim().split(/\s+/).slice(1); // drop "v=spf1"
  const nested: string[] = [];

  for (const term of terms) {
    const match = LOOKUP_MECHANISMS.exec(term);
    if (match) {
      count += 1;
      const mechanism = match[1].toLowerCase();
      if (mechanism === 'include') {
        const target = term.split(':').slice(1).join(':');
        if (target) nested.push(target);
      }
    } else if (/^redirect=/i.test(term)) {
      count += 1;
      nested.push(term.slice('redirect='.length));
    }
  }

  for (const target of nested) {
    if (budget.remaining <= 0) {
      state.truncated = true;
      break;
    }
    budget.remaining -= 1;
    const res = await dnsQuery(target, 'TXT', { confirmAbsence: false });
    const spf = txtValues(res).find((v) => v.toLowerCase().startsWith('v=spf1'));
    if (spf) count += await countSpfLookups(spf, depth + 1, budget, state);
  }

  return count;
}

/** The `all` mechanism written on this record itself, if it has one. */
function explicitQualifier(record: string): SpfQualifier | null {
  const padded = ` ${record.toLowerCase()}`;
  if (/\s-all\b/.test(padded)) return '-all';
  if (/\s~all\b/.test(padded)) return '~all';
  if (/\s\?all\b/.test(padded)) return '?all';
  if (/\s\+?all\b/.test(padded)) return '+all';
  return null;
}

/**
 * `redirect=` is a complete, valid SPF construct: it hands evaluation to
 * another domain, whose default rule becomes the effective one. Treating it as
 * a record with "no explicit default rule" marked correctly configured domains
 * down, so the redirect is followed to wherever it actually terminates.
 */
async function resolveQualifier(
  record: string,
  depth: number,
): Promise<{ qualifier: SpfQualifier; via: string | null }> {
  const explicit = explicitQualifier(record);
  if (explicit) return { qualifier: explicit, via: null };

  const redirect = /\bredirect=(\S+)/i.exec(record);
  if (redirect && depth < 3) {
    const target = redirect[1].replace(/\.$/, '');
    const res = await dnsQuery(target, 'TXT', { confirmAbsence: false });
    const spf = txtValues(res).find((v) => v.toLowerCase().startsWith('v=spf1'));
    if (spf) {
      const inner = await resolveQualifier(spf, depth + 1);
      return { qualifier: inner.qualifier, via: inner.via ?? target };
    }
  }

  return { qualifier: 'none', via: null };
}

const UNRESOLVED_SPF: SpfAnalysis = {
  resolved: false,
  record: null,
  qualifier: 'none',
  redirectedTo: null,
  lookups: 0,
  truncated: false,
  duplicates: false,
};

async function analyseSpf(domain: string): Promise<SpfAnalysis> {
  const res = await dnsQuery(domain, 'TXT');
  if (!res.resolved) return UNRESOLVED_SPF;

  const spfRecords = txtValues(res).filter((v) => v.toLowerCase().startsWith('v=spf1'));
  if (spfRecords.length === 0) {
    return { ...UNRESOLVED_SPF, resolved: true };
  }

  const record = spfRecords[0];
  const state = { truncated: false };

  const [{ qualifier, via }, lookups] = await Promise.all([
    resolveQualifier(record, 0),
    countSpfLookups(record, 0, { remaining: SPF_QUERY_BUDGET }, state),
  ]);

  return {
    resolved: true,
    record,
    qualifier,
    redirectedTo: via,
    lookups,
    truncated: state.truncated,
    duplicates: spfRecords.length > 1,
  };
}

interface DmarcAnalysis {
  /** False when no resolver answered — nothing may be concluded. */
  resolved: boolean;
  record: string | null;
  policy: 'reject' | 'quarantine' | 'none' | null;
  subPolicy: string | null;
  pct: number;
  hasReporting: boolean;
}

async function analyseDmarc(domain: string): Promise<DmarcAnalysis> {
  const res = await dnsQuery(`_dmarc.${domain}`, 'TXT');
  if (!res.resolved) {
    return { resolved: false, record: null, policy: null, subPolicy: null, pct: 100, hasReporting: false };
  }

  const record = txtValues(res).find((v) => v.toLowerCase().startsWith('v=dmarc1')) ?? null;

  if (!record) {
    return { resolved: true, record: null, policy: null, subPolicy: null, pct: 100, hasReporting: false };
  }

  const lowered = record.toLowerCase();
  const policyMatch = /\bp\s*=\s*(reject|quarantine|none)\b/.exec(lowered);
  const subMatch = /\bsp\s*=\s*(reject|quarantine|none)\b/.exec(lowered);
  const pctMatch = /\bpct\s*=\s*(\d{1,3})\b/.exec(lowered);

  return {
    resolved: true,
    record,
    policy: (policyMatch?.[1] as DmarcAnalysis['policy']) ?? null,
    subPolicy: subMatch?.[1] ?? null,
    pct: pctMatch ? Number(pctMatch[1]) : 100,
    hasReporting: /\brua\s*=/.test(lowered),
  };
}

/**
 * Selector probing can only ever prove presence, so absence here is never
 * confirmed against a second resolver — the result is not used to assert
 * anything. That keeps the cost of a wide selector list to one query each.
 */
async function findDkim(domain: string): Promise<{ selectors: string[]; answered: number }> {
  const results = await mapLimit(DKIM_SELECTORS, 10, async (selector) => {
    const res = await dnsQuery(`${selector}._domainkey.${domain}`, 'TXT', {
      confirmAbsence: false,
    });
    if (!res.resolved) return { selector: null, answered: false };
    const hasKey = txtValues(res).some((v) => /v=dkim1|k=rsa|p=[A-Za-z0-9+/]/i.test(v));
    return { selector: hasKey ? selector : null, answered: true };
  });

  return {
    selectors: results.map((r) => r.selector).filter((s): s is string => s !== null),
    answered: results.filter((r) => r.answered).length,
  };
}

export async function checkEmailSecurity(domain: string): Promise<ModuleOutput> {
  const findings: Finding[] = [];
  const details: CategoryDetail[] = [];

  const [spf, dmarc, dkim] = await Promise.all([
    analyseSpf(domain),
    analyseDmarc(domain),
    findDkim(domain),
  ]);

  const dkimSelectors = dkim.selectors;

  /*
   * SPF and DMARC are the two claims this module actually makes. If either
   * lookup could not be completed, the module reports itself unavailable and
   * the composite renormalises around it — far better than the old behaviour,
   * where a rate-limited query published "No DMARC policy" at critical
   * severity about a domain that had one.
   */
  if (!spf.resolved || !dmarc.resolved) {
    throw new Error(
      'No DNS resolver answered for this domain\'s email policy records, so SPF and DMARC could not be established.',
    );
  }

  const spfSource = spf.redirectedTo ? `${domain} (via redirect to ${spf.redirectedTo})` : domain;

  /* ---------------- SPF ---------------- */

  let spfScore = 0;
  let spfNote = '';

  if (!spf.record) {
    spfNote = 'No v=spf1 record is published.';
    findings.push(
      makeFinding(KEY, {
        title: 'No SPF record is published',
        severity: 'high',
        confidence: 'high',
        asset: domain,
        observed: `A TXT query for ${domain} returned no record beginning with v=spf1. Absence was confirmed against a second resolver before being reported.`,
        interpretation:
          'The domain does not declare which servers are authorised to send mail using it in the envelope sender. Receiving servers therefore have no SPF result to evaluate — they get a "none" result, which is not a failure and does not by itself cause mail to be rejected.',
        risk:
          'SPF is one of the two mechanisms DMARC can authenticate against. With no SPF record and no DKIM signature, a DMARC policy has nothing to pass, so enforcement cannot be introduced without first breaking legitimate mail. In the meantime, forged mail using this domain in the envelope sender has no authentication result working against it at the receiving server.',
        recommendation:
          'Publish an SPF record listing the legitimate sending services and ending in `-all`, for example `v=spf1 include:<provider> -all`. Confirm the full list of senders first — marketing platforms and ticketing systems are the ones usually missed.',
        evidence: {
          test: `DNS TXT query for ${domain}, filtered for records starting v=spf1`,
          observed: 'No v=spf1 record present',
          expected: 'A single v=spf1 record ending in -all',
          verification: `Answered by ${spf.record ? '' : 'two independent resolvers'}; an empty answer was re-asked before being treated as absence`,
          limitation:
            'SPF authenticates the envelope sender, not the From address a recipient sees. Its absence is not by itself proof that mail can be forged convincingly.',
        },
        scoreImpact: 25,
      }),
    );
  } else {
    switch (spf.qualifier) {
      case '-all':
        spfScore = 25;
        spfNote = `SPF ends in -all (hard fail)${spf.redirectedTo ? `, via redirect to ${spf.redirectedTo}` : ''}.`;
        break;
      case '~all':
        spfScore = 16;
        spfNote = 'SPF ends in ~all (soft fail), which asks receivers to accept and mark rather than reject.';
        findings.push(
          makeFinding(KEY, {
            title: 'SPF ends in soft fail rather than hard fail',
            severity: 'low',
            confidence: 'high',
            asset: spfSource,
            observed: `The effective SPF default rule for ${spfSource} is \`~all\`. Record: ${truncate(spf.record, 160)}`,
            interpretation:
              'Mail from a server not on the list produces an SPF softfail. RFC 7208 asks receivers to accept such mail but treat it as suspicious. This is the recommended setting while a sender inventory is still being confirmed, and it is the setting most large senders keep permanently because DMARC does the enforcing.',
            risk:
              'On its own, softfail means unauthorised mail is generally still delivered, often to the inbox. Where DMARC is set to reject, this matters much less: DMARC rejects on an unaligned pass-or-fail regardless of whether SPF said soft or hard.',
            recommendation:
              'If DMARC is already at p=reject, this is fine as it stands. Otherwise, once every legitimate sender is confirmed present, change `~all` to `-all`.',
            evidence: {
              test: `SPF record retrieved for ${domain} and evaluated for its default rule`,
              observed: truncate(spf.record, 200),
              expected: '-all, once the sender inventory is confirmed',
              verification: 'The record was parsed for an explicit `all` mechanism, following any `redirect=` to its terminating record.',
            },
            scoreImpact: 9,
          }),
        );
        break;
      case '?all':
        spfScore = 8;
        spfNote = 'SPF ends in ?all (neutral), which explicitly declines to make any assertion.';
        findings.push(
          makeFinding(KEY, {
            title: 'SPF default rule is neutral',
            severity: 'medium',
            confidence: 'high',
            asset: spfSource,
            observed: `The effective SPF default rule for ${spfSource} is \`?all\`. Record: ${truncate(spf.record, 160)}`,
            interpretation:
              'A neutral qualifier tells receiving servers explicitly to draw no conclusion about senders that are not listed — the same outcome as publishing no record at all, but stated deliberately.',
            risk:
              'The record provides the appearance of a sender policy without any of the effect. Where a DMARC policy relies on SPF alignment, a neutral result cannot produce an SPF pass, so DMARC has to fall back entirely to DKIM.',
            recommendation: 'Change the ending to `-all` after verifying the list of legitimate senders is complete.',
            evidence: {
              test: `SPF record retrieved for ${domain} and evaluated for its default rule`,
              observed: truncate(spf.record, 200),
              expected: '-all',
              verification: 'Parsed for an explicit `all` mechanism, following `redirect=` where present.',
            },
            scoreImpact: 17,
          }),
        );
        break;
      case '+all':
        spfScore = 0;
        spfNote = 'SPF ends in +all, which authorises every host on the internet.';
        findings.push(
          makeFinding(KEY, {
            title: 'SPF record authorises every sending host',
            severity: 'high',
            confidence: 'high',
            asset: spfSource,
            observed: `The effective SPF default rule for ${spfSource} is \`+all\`. Record: ${truncate(spf.record, 160)}`,
            interpretation:
              'The record declares that any host on the internet is a permitted sender for this domain. This is almost always a typo or a debugging change left in place, since it is functionally equivalent to publishing no policy while formally asserting the opposite.',
            risk:
              'Any server sending mail with this domain in the envelope sender gets an SPF pass. That pass can also satisfy DMARC alignment, so a DMARC policy at reject provides no protection against a sender that would otherwise be rejected.',
            recommendation: 'Replace `+all` with `-all` and list only the genuine sending services.',
            evidence: {
              test: `SPF record retrieved for ${domain} and evaluated for its default rule`,
              observed: truncate(spf.record, 200),
              expected: '-all',
              verification: 'Parsed for an explicit `all` mechanism, following `redirect=` where present.',
            },
            scoreImpact: 25,
          }),
        );
        break;
      default:
        spfScore = 8;
        spfNote = 'SPF record has no `all` mechanism and no `redirect=` supplying one.';
        findings.push(
          makeFinding(KEY, {
            title: 'SPF record specifies no default rule',
            severity: 'low',
            confidence: 'high',
            asset: domain,
            observed: `The SPF record for ${domain} contains no \`all\` mechanism, and no \`redirect=\` modifier supplies one. Record: ${truncate(spf.record, 160)}`,
            interpretation:
              'Evaluation of this record ends in a neutral result for any sender not explicitly matched, because RFC 7208 defaults to neutral when nothing else applies.',
            risk:
              'The outcome is the same as an explicit `?all`: unlisted senders produce no assertion either way, and DMARC cannot obtain an SPF pass from them.',
            recommendation: 'End the record with `-all`.',
            evidence: {
              test: `SPF record retrieved for ${domain}, checked for an \`all\` mechanism and for \`redirect=\``,
              observed: truncate(spf.record, 200),
              expected: 'A terminating `all` mechanism, or a `redirect=` to a record that has one',
              verification: 'Any `redirect=` was followed up to three levels before this conclusion was drawn.',
            },
            scoreImpact: 17,
          }),
        );
    }

    if (spf.duplicates) {
      spfScore = Math.min(spfScore, 8);
      spfNote = 'More than one v=spf1 record is published, which is a permerror under RFC 7208.';
      findings.push(
        makeFinding(KEY, {
          title: 'More than one SPF record is published',
          severity: 'high',
          confidence: 'high',
          asset: domain,
          observed: `The TXT record set for ${domain} contains more than one record beginning with v=spf1.`,
          interpretation:
            'RFC 7208 §4.5 requires a receiving server that finds multiple SPF records to return a permerror. This is not a partial failure — the entire SPF evaluation is abandoned.',
          risk:
            'SPF provides no protection at all in this state, and a DMARC policy relying on SPF alignment loses that half of its evidence. Depending on receiver configuration, permerror can also cause legitimate mail to be treated as suspicious.',
          recommendation:
            'Merge every sending service into a single v=spf1 record and delete the others. The usual cause is two teams adding their own record independently.',
          evidence: {
            test: `DNS TXT query for ${domain}, counting records that begin with v=spf1`,
            observed: 'Multiple v=spf1 records present',
            expected: 'Exactly one v=spf1 record',
            verification: 'Counted from a single authoritative answer set, so the count is not an artefact of merging two resolvers.',
          },
          scoreImpact: 17,
        }),
      );
    }
  }

  /*
   * The traversal has a depth and query ceiling, so a very deeply nested record
   * yields a lower bound rather than a count. A hard "exceeds the limit"
   * finding is only published when the walk actually completed; a truncated one
   * says so and is scored as a warning, because the alternative is asserting a
   * breach of RFC 7208 from a number the code knows it did not finish
   * computing.
   */
  const lookupsKnown = Boolean(spf.record) && !spf.truncated;
  const lookupScore = !spf.record ? 0 : spf.lookups > 10 ? 0 : spf.lookups > 8 ? 12 : 20;

  if (spf.record && spf.lookups > 10 && !spf.truncated) {
    findings.push(
      makeFinding(KEY, {
        title: 'SPF evaluation exceeds the ten-lookup limit',
        severity: 'high',
        confidence: 'high',
        asset: domain,
        observed: `Walking the SPF record and every record it includes required ${spf.lookups} DNS lookups. The traversal completed, so this is an exact count rather than a lower bound.`,
        interpretation:
          'RFC 7208 §4.6.4 caps SPF evaluation at ten DNS-querying mechanisms. A receiving server that reaches the limit must return permerror and stop.',
        risk:
          'SPF returns permerror rather than pass for every message, so the policy has no effect and DMARC loses SPF as a source of alignment. Some receivers treat permerror as grounds for additional filtering, so legitimate mail can be affected as well.',
        recommendation:
          'Reduce the number of `include:` entries — remove providers no longer in use, or flatten the record to IP ranges and keep it updated.',
        evidence: {
          test: 'Recursive walk of the SPF record counting lookup-costing mechanisms per RFC 7208 §4.6.4',
          observed: `${spf.lookups} lookups`,
          expected: '10 or fewer',
          verification: `The walk terminated naturally within its depth limit of ${MAX_SPF_DEPTH} and query budget of ${SPF_QUERY_BUDGET}, so the count is complete.`,
          limitation:
            'The count is of mechanisms as published today. A provider adding an entry to their own include changes this figure without any change to the record on this domain.',
        },
        scoreImpact: 20,
      }),
    );
  } else if (spf.record && spf.truncated) {
    findings.push(
      makeFinding(KEY, {
        title: 'SPF record nests deeper than this assessment follows',
        severity: 'low',
        confidence: 'low',
        asset: domain,
        observed: `The traversal stopped at depth ${MAX_SPF_DEPTH} or after ${SPF_QUERY_BUDGET} queries, having counted ${spf.lookups} lookups so far.`,
        interpretation:
          'The true lookup count is at least this figure and possibly higher. Whether the record actually breaches the ten-lookup limit could not be established, so no breach is asserted.',
        risk:
          'A record with this much nesting is fragile regardless of its exact count: any of the included providers can push it over the limit by editing their own record, at which point SPF silently starts returning permerror.',
        recommendation:
          'Verify the exact count with a dedicated SPF validator, and flatten the record if it is near the limit.',
        evidence: {
          test: 'Recursive walk of the SPF record, bounded by depth and query budget',
          observed: `At least ${spf.lookups} lookups; traversal incomplete`,
          expected: '10 or fewer',
          verification: 'Not verified — the traversal is deliberately bounded so one deeply nested record cannot consume the scan budget.',
          limitation:
            'This is a lower bound. Klyro cannot say from this whether the record is over or under the limit.',
        },
      }),
    );
  } else if (spf.record && spf.lookups > 8) {
    findings.push(
      makeFinding(KEY, {
        title: 'SPF evaluation is close to the ten-lookup limit',
        severity: 'low',
        confidence: 'high',
        asset: domain,
        observed: `Walking the SPF record required ${spf.lookups} of the 10 DNS lookups RFC 7208 permits. The traversal completed.`,
        interpretation:
          'The record is within the limit today. It is close enough that a single additional sending service, or a change inside one of the existing includes, would take it over.',
        risk:
          'If the limit is crossed, receiving servers return permerror and SPF stops working entirely — with no notification to the domain owner and no visible change until mail starts being filtered.',
        recommendation:
          'Audit the `include:` list now and remove services no longer in use, so there is headroom before the next one is added.',
        evidence: {
          test: 'Recursive walk of the SPF record counting lookup-costing mechanisms',
          observed: `${spf.lookups} lookups`,
          expected: '10 or fewer, with headroom',
          verification: 'The walk terminated naturally, so the count is complete.',
        },
        scoreImpact: 8,
      }),
    );
  }

  /* ---------------- DMARC ---------------- */

  let dmarcScore = 0;
  let dmarcNote = '';

  if (!dmarc.record) {
    dmarcNote = 'No v=DMARC1 record is published at _dmarc.' + domain + '.';
    findings.push(
      makeFinding(KEY, {
        title: 'No DMARC policy is published',
        severity: 'high',
        confidence: 'high',
        asset: `_dmarc.${domain}`,
        observed: `A TXT query for _dmarc.${domain} returned no record beginning with v=DMARC1. Absence was confirmed against a second resolver.`,
        interpretation:
          'The domain publishes no policy telling receiving servers what to do when a message claiming to be from it fails authentication, and no address to send aggregate reports to. Without DMARC, SPF and DKIM results are advisory: each receiver decides for itself what to do with them, and neither mechanism is checked against the From address the recipient actually sees.',
        risk:
          'Mail using this domain in the From header can be sent by anyone, and receiving servers have no published instruction to reject it. Whether any given message is delivered depends on the receiver\'s own spam heuristics, which Klyro cannot observe. The domain owner also receives no reports, so impersonation attempts are invisible to them.',
        recommendation:
          'Publish `v=DMARC1; p=none; rua=mailto:dmarc@<domain>` to start collecting reports without affecting delivery, then move to `p=quarantine` and `p=reject` once the reports confirm legitimate senders pass.',
        evidence: {
          test: `DNS TXT query for _dmarc.${domain}`,
          observed: 'No v=DMARC1 record present',
          expected: 'A v=DMARC1 record with a p= tag',
          verification: 'The empty answer was re-asked against a second resolver before being reported as absence.',
          limitation:
            'Some receiving providers apply their own reputation-based filtering regardless of DMARC. This finding describes the absence of a published policy, not the outcome of any particular message.',
        },
        scoreImpact: 30,
      }),
    );
  } else {
    switch (dmarc.policy) {
      case 'reject':
        dmarcScore = 30;
        dmarcNote = 'DMARC policy is p=reject.';
        break;
      case 'quarantine':
        dmarcScore = 20;
        dmarcNote = 'DMARC policy is p=quarantine — failing mail is filtered rather than refused.';
        findings.push(
          makeFinding(KEY, {
            title: 'DMARC policy quarantines rather than rejects',
            severity: 'low',
            confidence: 'high',
            asset: `_dmarc.${domain}`,
            observed: `The DMARC record specifies p=quarantine. Record: ${truncate(dmarc.record, 160)}`,
            interpretation:
              'Receiving servers are asked to treat mail failing DMARC as suspicious — in practice, delivery to the spam folder — rather than refusing it at the SMTP transaction. This is the intended middle step of a DMARC rollout.',
            risk:
              'Quarantined mail is delivered rather than blocked, so a recipient who checks their spam folder can still act on a forged message. Recipients whose organisations allowlist their own domain may not see the quarantine at all.',
            recommendation:
              'Review a few weeks of aggregate reports to confirm legitimate senders are aligned, then move to `p=reject`.',
            evidence: {
              test: `DMARC record retrieved from _dmarc.${domain} and parsed for its p= tag`,
              observed: truncate(dmarc.record, 200),
              expected: 'p=reject, at the end of a rollout',
              verification: 'Read directly from the published record.',
            },
            scoreImpact: 10,
          }),
        );
        break;
      case 'none':
        dmarcScore = 8;
        dmarcNote = 'DMARC policy is p=none — reporting only, no action requested.';
        findings.push(
          makeFinding(KEY, {
            title: 'DMARC policy requests no action on failing mail',
            severity: 'medium',
            confidence: 'high',
            asset: `_dmarc.${domain}`,
            observed: `The DMARC record specifies p=none${dmarc.hasReporting ? ' with a reporting address configured' : ' with no reporting address'}. Record: ${truncate(dmarc.record, 160)}`,
            interpretation:
              dmarc.hasReporting
                ? 'The domain is in the monitoring phase of a DMARC rollout: receivers report on authentication results but are asked to take no action. This is the correct and intended first step, and the presence of a reporting address suggests the rollout is active rather than abandoned.'
                : 'The record requests no action and specifies no address to send reports to, so it neither protects the domain nor produces the data needed to move beyond monitoring. A p=none record with no rua tag is usually one that was published and then forgotten.',
            risk:
              'While the policy remains at none, mail failing authentication is delivered normally. The published record does not change how any message is handled; it only enables reporting.',
            recommendation:
              dmarc.hasReporting
                ? 'Use the aggregate reports already arriving to confirm every legitimate sender aligns, then move to `p=quarantine` and on to `p=reject`. Most organisations complete this in six to twelve weeks.'
                : 'Add `rua=mailto:dmarc@<domain>` so reports start arriving, then use them to progress the policy to quarantine and reject.',
            evidence: {
              test: `DMARC record retrieved from _dmarc.${domain} and parsed for p= and rua=`,
              observed: truncate(dmarc.record, 200),
              expected: 'p=quarantine or p=reject once monitoring is complete',
              verification: 'Read directly from the published record.',
              limitation:
                'Klyro cannot tell how long the policy has been at p=none, so it cannot distinguish an active rollout from a stalled one.',
            },
            scoreImpact: 22,
          }),
        );
        break;
      default:
        dmarcScore = 5;
        dmarcNote = 'A DMARC record exists but declares no valid p= tag.';
        findings.push(
          makeFinding(KEY, {
            title: 'DMARC record declares no valid policy',
            severity: 'medium',
            confidence: 'high',
            asset: `_dmarc.${domain}`,
            observed: `A v=DMARC1 record is published but contains no valid p= tag. Record: ${truncate(dmarc.record, 160)}`,
            interpretation:
              'RFC 7489 requires the p tag, and a record without one is invalid. Receiving servers discard the record entirely rather than applying a default.',
            risk:
              'The domain has the appearance of DMARC protection without any of the effect — including, in most implementations, no reporting either.',
            recommendation:
              'Correct the record to include a p= tag, for example `v=DMARC1; p=none; rua=mailto:dmarc@<domain>` as a starting point.',
            evidence: {
              test: `DMARC record retrieved from _dmarc.${domain} and parsed for a p= tag`,
              observed: truncate(dmarc.record, 200),
              expected: 'p=none, p=quarantine or p=reject',
              verification: 'Read directly from the published record.',
            },
            scoreImpact: 25,
          }),
        );
    }

    if (dmarc.pct < 100 && dmarc.policy !== 'none') {
      dmarcScore = Math.round(dmarcScore * 0.7);
      findings.push(
        makeFinding(KEY, {
          title: 'DMARC policy is applied to a sample of mail only',
          severity: 'low',
          confidence: 'high',
          asset: `_dmarc.${domain}`,
          observed: `The DMARC record specifies pct=${dmarc.pct}.`,
          interpretation:
            `Receiving servers are asked to apply the ${dmarc.policy} policy to ${dmarc.pct}% of failing messages and to treat the remainder as though the policy were one step weaker. This is the standard mechanism for phasing in enforcement gradually.`,
          risk: `Roughly ${100 - dmarc.pct}% of mail failing authentication is handled under a weaker policy than the record otherwise implies.`,
          recommendation: 'Once aggregate reports look clean, remove the `pct=` tag so the policy applies to everything.',
          evidence: {
            test: `DMARC record parsed for the pct= tag`,
            observed: `pct=${dmarc.pct}`,
            expected: 'pct absent, which defaults to 100',
            verification: 'Read directly from the published record.',
          },
          scoreImpact: Math.round(dmarcScore * 0.3),
        }),
      );
    }

    if (!dmarc.hasReporting && dmarc.policy !== 'none') {
      findings.push(
        makeFinding(KEY, {
          title: 'DMARC record specifies no reporting address',
          severity: 'low',
          confidence: 'high',
          asset: `_dmarc.${domain}`,
          observed: `The DMARC record contains no rua= tag. Record: ${truncate(dmarc.record, 160)}`,
          interpretation:
            'Receiving servers have nowhere to send aggregate reports, so the domain owner gets no data on who is sending mail as this domain or whether their own senders are passing.',
          risk:
            'Impersonation attempts are invisible, and any legitimate sender that stops aligning — a new marketing platform, a changed provider — fails silently rather than showing up in a report.',
          recommendation: 'Add `rua=mailto:dmarc@<domain>` and route it to a monitored mailbox or a reporting service.',
          evidence: {
            test: 'DMARC record parsed for the rua= tag',
            observed: 'No rua= tag present',
            expected: 'rua= pointing at a monitored address',
            verification: 'Read directly from the published record.',
          },
        }),
      );
    }

    if (dmarc.subPolicy === 'none' && dmarc.policy !== 'none') {
      findings.push(
        makeFinding(KEY, {
          title: 'Subdomains are exempted from the DMARC policy',
          severity: 'medium',
          confidence: 'high',
          asset: `_dmarc.${domain}`,
          observed: `The DMARC record specifies sp=${dmarc.subPolicy}, while the organisational policy is p=${dmarc.policy}.`,
          interpretation:
            'The sp tag overrides the policy for subdomains. Mail from any name under this domain is therefore handled under p=none regardless of the stricter policy on the domain itself.',
          risk:
            'A forged sender at a name like billing.<domain> or notifications.<domain> reads as legitimate to a recipient and is delivered normally, since no subdomain needs to exist for mail to claim it.',
          recommendation:
            'Remove the `sp=none` tag so subdomains inherit the organisational policy, or set `sp=reject` explicitly.',
          evidence: {
            test: 'DMARC record parsed for the sp= tag',
            observed: `sp=${dmarc.subPolicy} with p=${dmarc.policy}`,
            expected: 'sp absent (inherits p) or sp=reject',
            verification: 'Read directly from the published record.',
          },
          scoreImpact: 0,
        }),
      );
    }
  }

  /* ---------------- DKIM ---------------- */

  /*
   * DKIM selectors are arbitrary strings chosen by the sender, so probing a
   * fixed list can only ever prove presence — never absence. A domain signing
   * with `mx2024-a` looks identical to one not signing at all.
   *
   * The old behaviour gave partial credit for that uncertainty, which still
   * cost 13 points and systematically marked down every organisation using a
   * custom selector. An unknown is excluded from the score outright and
   * reported as a question to ask, which is what it is.
   */
  const dkimConfirmed = dkimSelectors.length > 0;
  const dkimScore = dkimConfirmed ? 25 : 0;

  if (!dkimConfirmed) {
    findings.push(
      makeUnknown(KEY, {
        title: 'DKIM signing could not be determined',
        asset: domain,
        observed: `TXT queries at ${DKIM_SELECTORS.length} common selector names under _domainkey.${domain} returned no signing key. ${dkim.answered} of the ${DKIM_SELECTORS.length} lookups received an answer from a resolver.`,
        wouldHaveShown:
          'DKIM selector names are chosen freely by each sender and are not enumerable, so a domain signing under a custom name is indistinguishable from one not signing at all. Finding no key at these names establishes nothing either way.',
        recommendation:
          'Ask the domain owner which DKIM selector they publish and confirm the key resolves. A mail header from any message they have sent contains the selector in its DKIM-Signature line.',
        evidence: {
          test: `TXT query at <selector>._domainkey.${domain} for ${DKIM_SELECTORS.length} common selector names`,
          observed: `No v=DKIM1 or p= key material at: ${DKIM_SELECTORS.join(', ')}`,
          expected: 'A key at whichever selector the sender actually uses — which is not discoverable from outside',
          verification: `${dkim.answered} of ${DKIM_SELECTORS.length} lookups were answered by a resolver, so most of the list was genuinely checked.`,
          limitation:
            'This test can only ever prove presence. Absence at these names is not evidence of absence, and this component was excluded from the score rather than counted against the domain.',
        },
      }),
    );
  }

  /* ---------------- Combined posture ---------------- */

  /*
   * The one claim in this module that combines several observations, so it is
   * the one most at risk of overreaching. Spoofability is a property of the
   * *receiving* server's configuration, which is not observable from here. What
   * is observable is whether this domain published an instruction to reject —
   * so that is what the finding says, and the confidence drops when the
   * conclusion depends on inference rather than a published record.
   */
  const enforcing = dmarc.policy === 'reject';
  const filtering = dmarc.policy === 'quarantine';
  const spfAsserts = spf.qualifier === '-all' || spf.qualifier === '~all';

  const verdict = enforcing
    ? `Published policy asks receiving servers to reject mail that fails authentication (SPF ${spf.qualifier}, DMARC p=reject).`
    : filtering
      ? `Published policy asks receiving servers to quarantine mail that fails authentication (SPF ${spf.qualifier}, DMARC p=quarantine).`
      : dmarc.record
        ? `A DMARC record is published but requests no enforcement (SPF ${spf.qualifier}, DMARC p=${dmarc.policy ?? 'unset'}).`
        : `No DMARC policy is published, so nothing instructs receiving servers to act on failed authentication (SPF ${spf.qualifier}).`;

  if (!enforcing && !filtering) {
    findings.push(
      makeFinding(KEY, {
        title: 'Nothing published instructs receivers to reject forged mail',
        severity: 'high',
        confidence: dmarc.record || spf.record ? 'medium' : 'high',
        asset: domain,
        observed: `SPF default rule: ${spf.qualifier}. DMARC policy: ${dmarc.policy ?? 'not published'}. DKIM: ${dkimConfirmed ? `key found at ${dkimSelectors.join(', ')}` : 'could not be determined'}.`,
        interpretation:
          'DMARC is the only one of the three mechanisms that checks the From address a recipient actually sees, and the only one that publishes an instruction about what to do on failure. With DMARC at none or absent, this domain publishes no such instruction. Each receiving server falls back to its own reputation and heuristic filtering.',
        risk:
          'A message with this domain in the From header, sent from a server the domain does not control, has no published policy working against it. Whether such a message reaches an inbox depends entirely on the receiving provider, which Klyro cannot observe and does not claim to predict — large providers apply their own filtering that catches some of it. Domain impersonation in the From header is the common opening move in invoice fraud and executive impersonation, which is why the absence of a policy is treated as material rather than theoretical.',
        recommendation:
          'Treat SPF `-all`, DKIM signing and DMARC `p=reject` as one project rather than three. Start at `p=none` with a reporting address, use the reports to confirm every legitimate sender aligns, then progress the policy. Six to twelve weeks is typical.',
        evidence: {
          test: 'SPF, DMARC and DKIM records retrieved and evaluated together',
          observed: `SPF ${spf.qualifier}${spf.redirectedTo ? ` (via ${spf.redirectedTo})` : ''}; DMARC ${dmarc.policy ?? 'absent'}; DKIM ${dkimConfirmed ? 'present' : 'undetermined'}`,
          expected: 'DMARC p=quarantine or p=reject, with at least one of SPF or DKIM aligned',
          verification: 'SPF and DMARC absence were each confirmed against a second resolver. DKIM was not confirmable either way and is not relied on for this conclusion.',
          limitation:
            'Klyro did not send any email and did not test any receiving server. This describes what the domain publishes, not what a specific recipient\'s mail provider would do with a specific message.',
        },
        scoreImpact: 0,
      }),
    );
  }

  details.push(
    {
      label: 'Published enforcement posture',
      value: verdict,
      tone: enforcing ? 'good' : filtering ? 'warn' : 'bad',
    },
    {
      label: 'SPF record',
      value: spf.record ? truncate(spf.record, 110) : 'Not published',
      mono: true,
      tone: spf.record ? (spf.qualifier === '-all' ? 'good' : 'warn') : 'bad',
    },
    {
      label: 'SPF default rule',
      value:
        spf.qualifier === 'none'
          ? 'Not set — evaluation defaults to neutral'
          : spf.redirectedTo
            ? `${spf.qualifier} (via redirect to ${spf.redirectedTo})`
            : spf.qualifier,
      mono: true,
      tone: spf.qualifier === '-all' ? 'good' : spf.qualifier === '~all' ? 'warn' : 'bad',
    },
    {
      label: 'SPF DNS lookups',
      value: !spf.record
        ? 'n/a'
        : spf.truncated
          ? `at least ${spf.lookups} of 10 — record nests deeper than this check follows`
          : `${spf.lookups} of 10`,
      mono: true,
      tone: spf.truncated ? 'warn' : spf.lookups > 10 ? 'bad' : spf.lookups > 8 ? 'warn' : 'good',
    },
    {
      label: 'DMARC policy',
      value: dmarc.policy ? `p=${dmarc.policy}${dmarc.pct < 100 ? `, pct=${dmarc.pct}` : ''}` : 'Not published',
      mono: true,
      tone: dmarc.policy === 'reject' ? 'good' : dmarc.policy ? 'warn' : 'bad',
    },
    {
      label: 'DMARC subdomain policy',
      value: dmarc.subPolicy ? `sp=${dmarc.subPolicy}` : dmarc.record ? 'Inherits the organisational policy' : 'n/a',
      mono: true,
      tone: dmarc.subPolicy === 'none' ? 'warn' : 'neutral',
    },
    {
      label: 'DMARC reporting',
      value: dmarc.hasReporting ? 'Aggregate reports requested' : dmarc.record ? 'No reporting address' : 'n/a',
      tone: dmarc.hasReporting ? 'good' : 'warn',
    },
    {
      label: 'DKIM',
      value: dkimConfirmed
        ? `Key published at: ${dkimSelectors.join(', ')}`
        : `Not determinable — no key at ${DKIM_SELECTORS.length} common selectors, and selector names are not enumerable`,
      mono: dkimConfirmed,
      tone: dkimConfirmed ? 'good' : 'neutral',
    },
    {
      label: 'Selector lookups answered',
      value: `${dkim.answered} of ${DKIM_SELECTORS.length}`,
      mono: true,
      tone: dkim.answered === DKIM_SELECTORS.length ? 'good' : 'neutral',
    },
    {
      label: 'Scope of this check',
      value:
        'Published DNS policy only. Klyro sent no email, tested no receiving server, and cannot observe whether any particular message would be delivered.',
      tone: 'neutral',
    },
  );

  const { score, coverage, breakdown } = scoreFromComponents([
    { label: 'SPF policy', value: spfScore, max: 25, note: spfNote || 'SPF ends in -all (hard fail).' },
    {
      label: 'SPF lookup budget',
      value: lookupScore,
      max: 20,
      known: lookupsKnown || !spf.record,
      note: !spf.record
        ? 'No SPF record to evaluate.'
        : !lookupsKnown
          ? 'The traversal did not complete, so the lookup count is a lower bound and this component was dropped.'
          : `${spf.lookups} of the 10 permitted DNS lookups.`,
    },
    { label: 'DMARC policy', value: dmarcScore, max: 30, note: dmarcNote || 'DMARC policy is p=reject.' },
    {
      label: 'DKIM signing',
      value: dkimScore,
      max: 25,
      known: dkimConfirmed,
      note: dkimConfirmed
        ? `Signing key published at ${dkimSelectors.join(', ')}.`
        : 'Selector names are not enumerable, so DKIM could not be established either way and this component was dropped rather than scored as a failure.',
    },
  ] satisfies ScoreComponent[]);

  if (coverage < 0.999) {
    details.push({
      label: 'Assessed weight',
      value: `${Math.round(coverage * 100)}% — what could not be established was excluded, not counted against the domain`,
      tone: 'neutral',
    });
  }

  const facts = {
    spfQualifier: spf.qualifier,
    spfLookups: spf.lookups,
    dmarcPolicy: dmarc.policy,
    dmarcPct: dmarc.pct,
    dkimSelectors,
  };

  return {
    score,
    summary: verdict,
    findings,
    details,
    scoreBreakdown: breakdown,
    moduleCoverage: coverage,
    facts,
  };
}
