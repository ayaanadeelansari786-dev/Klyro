import type { CategoryDetail, Finding } from '../types';
import { makeFinding, type ModuleOutput, penaltyBreakdown, safeFetch, truncate } from './util';

const KEY = 'cors' as const;

/** A domain that does not exist, so a policy echoing it is echoing anything. */
const PROBE_ORIGIN = 'https://klyro-cors-probe.example';

interface CorsProbe {
  method: 'GET' | 'OPTIONS';
  status: number;
  allowOrigin: string | null;
  allowCredentials: boolean;
  allowMethods: string | null;
  allowHeaders: string | null;
  vary: string | null;
}

async function probe(url: string, method: 'GET' | 'OPTIONS'): Promise<CorsProbe | null> {
  const res = await safeFetch(
    url,
    {
      method,
      redirect: 'follow',
      headers:
        method === 'OPTIONS'
          ? {
              origin: PROBE_ORIGIN,
              'access-control-request-method': 'GET',
              'access-control-request-headers': 'authorization,content-type',
            }
          : { origin: PROBE_ORIGIN },
    },
    9_000,
  );
  if (!res) return null;

  return {
    method,
    status: res.status,
    allowOrigin: res.headers.get('access-control-allow-origin'),
    allowCredentials:
      (res.headers.get('access-control-allow-credentials') ?? '').toLowerCase() === 'true',
    allowMethods: res.headers.get('access-control-allow-methods'),
    allowHeaders: res.headers.get('access-control-allow-headers'),
    vary: res.headers.get('vary'),
  };
}

export async function checkCors(domain: string): Promise<ModuleOutput> {
  const findings: Finding[] = [];
  const details: CategoryDetail[] = [];

  const base = `https://${domain}`;

  const [simple, preflight] = await Promise.all([
    probe(`${base}/`, 'GET'),
    probe(`${base}/`, 'OPTIONS'),
  ]);

  if (!simple && !preflight) {
    throw new Error('The site did not respond to cross-origin probe requests.');
  }

  // Take the most permissive answer of the two — that is what a browser acts on.
  const results = [simple, preflight].filter((r): r is CorsProbe => r !== null);
  const reflects = results.some((r) => r.allowOrigin === PROBE_ORIGIN);
  const wildcard = results.some((r) => r.allowOrigin === '*');
  const credentials = results.some((r) => r.allowCredentials);
  const allowOrigin = results.find((r) => r.allowOrigin)?.allowOrigin ?? null;
  const varyOrigin = results.some((r) => (r.vary ?? '').toLowerCase().includes('origin'));
  const probedMethods = results.map((r) => r.method).join(' and ');

  /*
   * Score starts from a clean sheet and is reduced only for what was observed.
   * The single most important correction here: `Access-Control-Allow-Origin: *`
   * on a public marketing page is the *correct* configuration for public
   * content, not a data leak, and this module used to charge 80 points for it.
   */
  let score = 100;
  const penalties: { label: string; points: number; note: string }[] = [];

  if (reflects && credentials) {
    score -= 60;
    penalties.push({
      label: 'Origin reflection combined with credentials',
      points: 60,
      note: 'The response echoed an arbitrary origin and permitted credentials, which is the configuration that makes cross-origin reads of authenticated responses possible.',
    });
    findings.push(
      makeFinding(KEY, {
        title: 'Site echoes any requesting origin and permits credentials',
        severity: 'high',
        confidence: 'high',
        asset: `${base}/`,
        observed: `A request to ${base}/ carrying \`Origin: ${PROBE_ORIGIN}\` — a domain that does not exist — came back with \`Access-Control-Allow-Origin: ${allowOrigin}\` and \`Access-Control-Allow-Credentials: true\`. Probed with ${probedMethods}.`,
        interpretation:
          'The server computes the allow-origin header from whatever origin asked, rather than checking it against a list, and separately declares that credentialed requests are permitted. Together these instruct the browser to let any site read the response, with the visitor\'s cookies attached.',
        risk:
          'If any resource served under this policy returns content that differs per user, a page the visitor happens to open can read that content as them. Klyro tested the site root, which appears to be public content, and did not prove that any user-specific response is reachable this way. The configuration is nonetheless the one that makes such a read possible wherever it does apply.',
        recommendation:
          'Replace the reflection logic with a fixed allow-list, returning the caller\'s origin only when it matches an entry. Never pair a dynamically computed origin with `Access-Control-Allow-Credentials: true`.',
        evidence: {
          test: `${probedMethods} ${base}/ with header \`Origin: ${PROBE_ORIGIN}\``,
          observed: `Access-Control-Allow-Origin: ${allowOrigin}; Access-Control-Allow-Credentials: true`,
          expected: 'No allow-origin header, or an explicit origin that does not match the one sent',
          verification: 'The probe origin is a non-existent domain, so echoing it back cannot be the result of a legitimate allow-list match.',
          limitation:
            'Only the site root was tested. Whether the same policy applies to endpoints returning user data was not established, and no authenticated response was read.',
        },
        scoreImpact: 60,
      }),
    );
  } else if (wildcard && credentials) {
    score -= 20;
    penalties.push({
      label: 'Wildcard origin declared alongside credentials',
      points: 20,
      note: 'Browsers reject this combination, so the declaration is inert — but it indicates the access rules were not written deliberately.',
    });
    findings.push(
      makeFinding(KEY, {
        title: 'Wildcard origin is declared together with credentials',
        severity: 'low',
        confidence: 'high',
        asset: `${base}/`,
        observed: `The response carries \`Access-Control-Allow-Origin: *\` and \`Access-Control-Allow-Credentials: true\` simultaneously. Probed with ${probedMethods}.`,
        interpretation:
          'The Fetch specification requires browsers to fail any credentialed request whose response carries a wildcard origin. The combination therefore has no effect — whatever feature it was meant to enable does not work in any current browser.',
        risk:
          'No cross-origin exposure follows, because browsers refuse to act on it. It is reported because a configuration that cannot work as written suggests the cross-origin rules elsewhere in the application were not reviewed either.',
        recommendation:
          'Decide which of the two was intended. If credentialed cross-origin access is genuinely needed, name the specific origins; if not, remove the credentials header.',
        evidence: {
          test: `${probedMethods} ${base}/ with header \`Origin: ${PROBE_ORIGIN}\``,
          observed: 'Access-Control-Allow-Origin: *; Access-Control-Allow-Credentials: true',
          expected: 'One or the other, not both',
          verification: 'Both headers were read from the same response.',
        },
        scoreImpact: 20,
      }),
    );
  } else if (reflects) {
    score -= 35;
    penalties.push({
      label: 'Origin reflection without credentials',
      points: 35,
      note: 'An arbitrary origin was echoed back, though no credentials are currently permitted.',
    });
    findings.push(
      makeFinding(KEY, {
        title: 'Site echoes any requesting origin as permitted',
        severity: 'medium',
        confidence: 'high',
        asset: `${base}/`,
        observed: `A request carrying \`Origin: ${PROBE_ORIGIN}\` came back with \`Access-Control-Allow-Origin: ${allowOrigin}\`. No \`Access-Control-Allow-Credentials\` header was set. Probed with ${probedMethods}.`,
        interpretation:
          'The allow-origin header is derived from the request rather than checked against a list. Without credentials permitted, a cross-origin read is anonymous — it returns what any visitor would see anyway.',
        risk:
          'The immediate exposure is limited while credentials stay out of it. The concern is durability: the moment any part of this application adds credentialed cross-origin access, this reflection turns into a read of authenticated responses without anything else having to change.',
        recommendation:
          'Validate the incoming origin against a fixed allow-list and return it only on a match. If the content is genuinely public, `Access-Control-Allow-Origin: *` is both simpler and safer than reflection.',
        evidence: {
          test: `${probedMethods} ${base}/ with header \`Origin: ${PROBE_ORIGIN}\``,
          observed: `Access-Control-Allow-Origin: ${allowOrigin}`,
          expected: 'A fixed origin, a wildcard, or no header at all',
          verification: 'The probe origin does not exist, so the echo cannot be an allow-list match.',
          limitation: 'Site root only. Klyro did not enumerate API endpoints.',
        },
        scoreImpact: 35,
      }),
    );
  } else if (wildcard) {
    score -= 5;
    penalties.push({
      label: 'Wildcard origin on public content',
      points: 5,
      note: 'A wildcard is the correct configuration for genuinely public content; the small deduction reflects that its scope was not verified, not that it is wrong.',
    });
    findings.push(
      makeFinding(KEY, {
        title: 'Site root is readable cross-origin by any website',
        severity: 'info',
        confidence: 'high',
        asset: `${base}/`,
        observed: `The response carries \`Access-Control-Allow-Origin: *\` with no credentials permitted. Probed with ${probedMethods}.`,
        interpretation:
          'Any website may read this response. For public content — a marketing page, a public API, a static asset — this is the intended and correct configuration, and it is what a wildcard is for.',
        risk:
          'None for content that is public anyway, which the site root appears to be. A wildcard becomes a problem only if it is applied to a response that varies by user, and browsers block credentials on wildcard responses, which removes the usual way that would happen.',
        recommendation:
          'No action needed for the root. Confirm the wildcard is applied per-route rather than globally, so that adding an authenticated endpoint later does not inherit it.',
        evidence: {
          test: `${probedMethods} ${base}/ with header \`Origin: ${PROBE_ORIGIN}\``,
          observed: 'Access-Control-Allow-Origin: *',
          expected: 'A wildcard is acceptable here; the check is that credentials are not also permitted',
          verification: 'The credentials header was checked on the same responses and is absent.',
          limitation: 'Which routes the wildcard applies to was not determined — only the root was probed.',
        },
      }),
    );
  }

  if (reflects && !varyOrigin) {
    score -= 10;
    penalties.push({
      label: 'Dynamic allow-origin without Vary: Origin',
      points: 10,
      note: 'The header is computed per request but caches are not told so.',
    });
    findings.push(
      makeFinding(KEY, {
        title: 'Per-origin responses are not marked as varying by origin',
        severity: 'low',
        confidence: 'high',
        asset: `${base}/`,
        observed: `The allow-origin header is computed from the request, but the response carries \`Vary: ${results.find((r) => r.vary)?.vary ?? '(absent)'}\`, which does not include \`Origin\`.`,
        interpretation:
          'A shared cache treats these responses as interchangeable even though the allow-origin header differs between them. The specification requires `Vary: Origin` whenever the header is computed dynamically.',
        risk:
          'A CDN or shared proxy can serve a response containing one requester\'s allow-origin value to a different requester. That widens whatever the reflection already permits to origins that never asked.',
        recommendation: 'Add `Vary: Origin` to every response whose allow-origin header is computed rather than fixed.',
        evidence: {
          test: 'Vary header read from the same responses used for the reflection check',
          observed: `Vary: ${results.find((r) => r.vary)?.vary ?? '(absent)'}`,
          expected: 'Vary including Origin',
          verification: 'Read from the same responses, so the two observations are consistent with each other.',
        },
        scoreImpact: 10,
      }),
    );
  }

  const permissiveMethods = results.find(
    (r) =>
      (r.allowMethods ?? '').toLowerCase().includes('delete') ||
      (r.allowMethods ?? '').includes('*'),
  );
  if (permissiveMethods && (reflects || wildcard)) {
    score -= 10;
    penalties.push({
      label: 'State-changing methods advertised cross-origin',
      points: 10,
      note: `Access-Control-Allow-Methods advertises ${permissiveMethods.allowMethods}.`,
    });
    findings.push(
      makeFinding(KEY, {
        title: 'Cross-origin policy advertises state-changing methods',
        severity: 'low',
        confidence: 'medium',
        asset: `${base}/`,
        observed: `Access-Control-Allow-Methods: ${permissiveMethods.allowMethods}, alongside a ${reflects ? 'reflected' : 'wildcard'} allow-origin.`,
        interpretation:
          'The preflight response advertises methods that modify or delete data, in addition to permitting cross-origin access. This is the advertised policy of whichever handler answered the root request; it is not evidence that any endpoint implements those methods.',
        risk:
          'Where an endpoint under this policy does implement DELETE or similar, the cross-origin permission extends from reading data to changing it. Whether such an endpoint exists was not tested — Klyro sends no state-changing requests.',
        recommendation:
          'Restrict `Access-Control-Allow-Methods` to the verbs each route actually implements, rather than declaring a common list at the edge.',
        evidence: {
          test: `OPTIONS ${base}/ with Access-Control-Request-Method: GET`,
          observed: `Access-Control-Allow-Methods: ${permissiveMethods.allowMethods}`,
          expected: 'Only the methods the route implements',
          verification: 'Read from the preflight response. No request using any of these methods was sent.',
          limitation:
            'This is a declaration, not a demonstration. Klyro did not attempt any state-changing request.',
        },
        scoreImpact: 10,
      }),
    );
  }

  details.push(
    {
      label: 'Access-Control-Allow-Origin',
      value: allowOrigin ?? 'Not sent — no cross-origin sharing (the default)',
      mono: Boolean(allowOrigin),
      tone: !allowOrigin ? 'good' : reflects ? 'bad' : 'neutral',
    },
    {
      label: 'Echoes an arbitrary origin',
      value: reflects ? `Yes — ${PROBE_ORIGIN} was echoed back` : 'No',
      tone: reflects ? 'bad' : 'good',
    },
    { label: 'Wildcard origin', value: wildcard ? 'Yes' : 'No', tone: wildcard ? 'neutral' : 'good' },
    {
      label: 'Credentials permitted',
      value: credentials ? 'Yes' : 'No',
      tone: credentials && reflects ? 'bad' : credentials ? 'warn' : 'good',
    },
    {
      label: 'Access-Control-Allow-Methods',
      value: results.find((r) => r.allowMethods)?.allowMethods ?? 'Not advertised',
      mono: true,
    },
    {
      label: 'Access-Control-Allow-Headers',
      value: truncate(results.find((r) => r.allowHeaders)?.allowHeaders ?? 'Not advertised', 100),
      mono: true,
    },
    {
      label: 'Vary: Origin',
      value: varyOrigin ? 'Present' : 'Absent',
      tone: !reflects || varyOrigin ? 'good' : 'warn',
    },
    { label: 'Probe origin used', value: PROBE_ORIGIN, mono: true },
    { label: 'Requests made', value: `${probedMethods} against ${base}/`, mono: true },
    {
      label: 'Scope of this check',
      value:
        'Site root only. Cross-origin policy matters most on data endpoints, which are not publicly enumerable and were not tested. A clean result here is not assurance about an API.',
      tone: 'neutral',
    },
  );

  /*
   * Cross-origin misconfiguration lives on data endpoints, not marketing
   * pages. Probing `/` establishes very little either way, so the report says
   * so rather than letting a clean result read as assurance.
   */
  findings.push(
    makeFinding(KEY, {
      title: 'Cross-origin review covers the site root only',
      severity: 'info',
      confidence: 'high',
      asset: `${base}/`,
      observed: `Two requests were made — ${probedMethods} against ${base}/ — each carrying \`Origin: ${PROBE_ORIGIN}\`. No other path was requested.`,
      interpretation:
        'The result above describes the policy on one public page. API endpoints are not enumerable from outside, and their cross-origin policy is frequently set separately from the site root\'s.',
      risk:
        'None follows from this observation. It is recorded so that a clean root result is not read as assurance about endpoints that were never tested.',
      recommendation:
        'Ask the vendor to confirm the cross-origin allow-list on their authenticated API, or point this check at known API host names if you have documentation for them.',
      evidence: {
        test: `GET and OPTIONS ${base}/ with an Origin header`,
        observed: 'Two requests, one path',
        verification: 'Scope is stated directly rather than inferred.',
        limitation:
          'Klyro does not enumerate API paths, and sends no authenticated requests.',
      },
    }),
  );

  const finalScore = Math.max(0, score);

  const summary = !allowOrigin
    ? 'The site root shares nothing cross-origin, which is the safest default. API endpoints were not tested.'
    : reflects && credentials
      ? 'The site root echoes any requesting origin and permits credentials — the configuration that allows cross-origin reads of authenticated responses.'
      : reflects
        ? 'The site root echoes whichever origin asks, though no credentials are permitted today.'
        : wildcard
          ? 'The site root is readable cross-origin by any website, which is the correct configuration for public content.'
          : 'Cross-origin sharing on the site root names an explicit origin rather than a wildcard.';

  const facts = {
    allowOrigin,
    reflects,
    wildcard,
    credentials,
    varyOrigin,
  };

  return {
    score: finalScore,
    summary,
    findings,
    details,
    scoreBreakdown: penaltyBreakdown(100, penalties),
    facts,
  };
}
