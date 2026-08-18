import type { CategoryDetail, Finding } from '../types';
import {
  makeFinding,
  type ModuleOutput,
  pct,
  plural,
  safeFetch,
  type ScoreComponent,
  scoreFromComponents,
  truncate,
} from './util';

const KEY = 'cookies' as const;

interface ParsedCookie {
  name: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: string | null;
  path: string;
  domainScope: string | null;
  session: boolean;
}

function parseCookie(raw: string): ParsedCookie {
  const [pair, ...attrs] = raw.split(';');
  const name = pair.split('=')[0]?.trim() ?? '(unnamed)';

  const lower = attrs.map((a) => a.trim().toLowerCase());
  const attr = (key: string): string | null => {
    const found = lower.find((a) => a === key || a.startsWith(`${key}=`));
    if (!found) return null;
    const idx = found.indexOf('=');
    return idx === -1 ? '' : found.slice(idx + 1).trim();
  };

  return {
    name,
    secure: lower.includes('secure'),
    httpOnly: lower.includes('httponly'),
    sameSite: attr('samesite'),
    path: attr('path') ?? '/',
    domainScope: attr('domain'),
    session: attr('expires') === null && attr('max-age') === null,
  };
}

/** Names that suggest the cookie carries a session or authentication token. */
const SENSITIVE_NAME = /(sess|sid|auth|token|jwt|login|remember|csrf|xsrf)/i;

/**
 * Names belonging to well-known client-side analytics libraries. These are
 * *meant* to be readable by JavaScript — that is how they function — so
 * reporting a missing HttpOnly flag on them is reporting the product working
 * as designed.
 */
const CLIENT_SIDE_BY_DESIGN =
  /^(_ga|_gid|_gat|_gcl_|_fbp|_fbc|_hj|_uet|__utm|ajs_|amplitude_|mp_|intercom-|optimizely|_clck|_clsk|_pk_|__hs)/i;

/**
 * Klyro is unauthenticated, so it only ever sees cookies a site hands to an
 * anonymous visitor. The cookies that carry real risk — session and
 * authentication tokens — are issued after sign-in and are invisible here.
 * Both the score and the report state that explicitly rather than implying
 * full coverage.
 */
const SCOPE_CAVEAT: CategoryDetail = {
  label: 'Scope of this check',
  value:
    'Unauthenticated homepage only. Session and login cookies are issued after sign-in and were not observed.',
  tone: 'neutral',
};

function scopeFinding(landed: string): Finding {
  return makeFinding(KEY, {
    title: 'Cookie review covers the pre-login response only',
    severity: 'info',
    confidence: 'high',
    asset: landed,
    observed: `A single unauthenticated GET to ${landed} was made, and the Set-Cookie headers on that one response were parsed. No sign-in was attempted.`,
    interpretation:
      'What is visible here is the set of cookies a site gives an anonymous visitor. The cookie that actually protects an account — the session token issued at sign-in — is not among them and cannot be observed from outside.',
    risk:
      'None follows from this observation. It is recorded so that a clean result in this category is not read as assurance that the authenticated session is equally well configured.',
    recommendation:
      'Ask the vendor to confirm their session cookie carries Secure, HttpOnly and SameSite, or check it directly in browser developer tools while signed in to a test account.',
    evidence: {
      test: `GET ${landed}, Set-Cookie headers parsed`,
      observed: 'Pre-login response only',
      verification: 'Scope is stated directly rather than inferred.',
      limitation: 'Klyro performs no authentication and inspects no post-login response.',
    },
  });
}

export async function checkCookies(domain: string): Promise<ModuleOutput> {
  const findings: Finding[] = [];
  const details: CategoryDetail[] = [];

  let target = `https://${domain}/`;
  let res = await safeFetch(target, { method: 'GET', redirect: 'follow' }, 10_000);
  if (!res) {
    target = `https://www.${domain}/`;
    res = await safeFetch(target, { method: 'GET', redirect: 'follow' }, 10_000);
  }
  if (!res) {
    throw new Error('The site did not respond to an HTTPS request.');
  }

  const landed = res.url || target;

  // Node's fetch exposes the un-merged Set-Cookie list via getSetCookie().
  const rawCookies =
    typeof (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie === 'function'
      ? (res.headers as unknown as { getSetCookie: () => string[] }).getSetCookie()
      : res.headers.get('set-cookie')
        ? [res.headers.get('set-cookie') as string]
        : [];

  if (rawCookies.length === 0) {
    details.push(
      { label: 'Cookies set on first visit', value: 'None', tone: 'good' },
      {
        label: 'Observation',
        value: 'The response set no cookies before any consent interaction.',
        tone: 'good',
      },
      { label: 'URL inspected', value: landed, mono: true },
      SCOPE_CAVEAT,
    );
    findings.push(scopeFinding(landed));
    return {
      score: 100,
      summary:
        'The pre-login response sets no cookies. Cookies issued after sign-in were not observed.',
      findings,
      details,
      scoreBreakdown: [
        {
          label: 'Cookie attributes',
          value: 100,
          max: 100,
          assessed: true,
          note: 'No cookies were set, so there are no attributes to assess. Scored as full marks rather than dropped, because "sets no cookies" is a real and favourable observation.',
        },
      ],
      facts: { cookieCount: 0 },
    };
  }

  const cookies = rawCookies.map(parseCookie);

  const sensitive = cookies.filter((c) => SENSITIVE_NAME.test(c.name));
  const analytics = cookies.filter((c) => CLIENT_SIDE_BY_DESIGN.test(c.name));

  const missingSecure = cookies.filter((c) => !c.secure);
  const missingHttpOnly = cookies.filter(
    (c) => !c.httpOnly && !CLIENT_SIDE_BY_DESIGN.test(c.name),
  );
  const weakSameSite = cookies.filter(
    (c) => !c.sameSite || !['strict', 'lax'].includes(c.sameSite.toLowerCase()),
  );
  const sameSiteNoneInsecure = cookies.filter(
    (c) => c.sameSite?.toLowerCase() === 'none' && !c.secure,
  );
  const broadDomain = cookies.filter(
    (c) => c.domainScope && c.domainScope.replace(/^\./, '') !== domain,
  );
  const sensitiveInsecure = sensitive.filter((c) => !c.httpOnly || !c.secure);

  const nameList = (list: ParsedCookie[], limit = 8) =>
    list
      .map((c) => c.name)
      .slice(0, limit)
      .join(', ') + (list.length > limit ? ` (+${list.length - limit} more)` : '');

  if (missingSecure.length > 0) {
    const anySensitive = missingSecure.some((c) => SENSITIVE_NAME.test(c.name));
    findings.push(
      makeFinding(KEY, {
        title: `${plural(missingSecure.length, 'cookie')} set without the Secure attribute`,
        severity: anySensitive ? 'medium' : 'low',
        confidence: 'high',
        asset: landed,
        observed: `${missingSecure.length} of ${cookies.length} Set-Cookie headers on ${landed} omit the \`Secure\` attribute: ${nameList(missingSecure)}.`,
        interpretation:
          'These cookies are not restricted to encrypted connections, so a browser will include them on a plain HTTP request to the same host.',
        risk: anySensitive
          ? 'At least one of these carries a name suggesting session or authentication material. If the site can be reached over HTTP at all — even a redirect — that request carries the cookie in clear text before the redirect happens, where anyone on the network path can read it.'
          : 'None of these carry names suggesting session material, so the practical exposure is limited to whatever the cookie itself contains. The attribute is free to add regardless.',
        recommendation:
          'Add `Secure` to every cookie the application sets. There is no case for omitting it on a site served over HTTPS.',
        evidence: {
          test: `Set-Cookie headers from GET ${landed}, parsed for the Secure attribute`,
          observed: nameList(missingSecure, 12),
          expected: 'Secure on every cookie',
          verification: 'Read from the un-merged Set-Cookie list, so multi-cookie responses are counted individually.',
          limitation: 'Whether any of these cookies actually carries sensitive content was not determined — only its name and attributes are visible.',
        },
        scoreImpact: Math.round((missingSecure.length / cookies.length) * 33),
      }),
    );
  }

  if (missingHttpOnly.length > 0) {
    const anySensitive = missingHttpOnly.some((c) => SENSITIVE_NAME.test(c.name));
    findings.push(
      makeFinding(KEY, {
        title: `${plural(missingHttpOnly.length, 'cookie')} readable by page JavaScript`,
        severity: anySensitive ? 'medium' : 'info',
        confidence: anySensitive ? 'high' : 'medium',
        asset: landed,
        observed: `${missingHttpOnly.length} cookie(s) omit \`HttpOnly\`: ${nameList(missingHttpOnly)}.${analytics.length ? ` A further ${analytics.length} analytics cookie(s) also omit it and were excluded, since client-side readability is how those work.` : ''}`,
        interpretation: anySensitive
          ? 'At least one of these carries a name associated with session or authentication material, and any script running on the page can read it — including third-party tags and anything injected into the page.'
          : 'These cookies are readable by scripts on the page. None carries a name associated with session material, so this may well be deliberate — many first-party features legitimately need to read their own cookie.',
        risk: anySensitive
          ? 'A single compromised or malicious script on any page of this site can read the cookie and replay it elsewhere. HttpOnly is the control that makes a script-level compromise stop short of session theft.'
          : 'Limited, and conditional on the cookie carrying something worth reading. Klyro cannot see cookie contents and is not asserting that it does.',
        recommendation:
          'Add `HttpOnly` to any cookie the front-end code does not genuinely need to read. Audit which ones actually are read before changing them.',
        evidence: {
          test: `Set-Cookie headers from GET ${landed}, parsed for the HttpOnly attribute`,
          observed: nameList(missingHttpOnly, 12),
          expected: 'HttpOnly on every cookie not read by front-end code',
          verification: 'Well-known analytics cookie names were excluded first, so the count reflects cookies where the flag would be appropriate.',
          limitation:
            'Klyro cannot tell which cookies the site\'s own JavaScript reads, so some of these may need to stay readable.',
        },
        scoreImpact: Math.round((missingHttpOnly.length / cookies.length) * 33),
      }),
    );
  }

  if (weakSameSite.length > 0) {
    findings.push(
      makeFinding(KEY, {
        title: `${plural(weakSameSite.length, 'cookie')} set without an explicit SameSite attribute`,
        severity: 'low',
        confidence: 'medium',
        asset: landed,
        observed: `${weakSameSite.length} cookie(s) either omit SameSite or set it to None: ${weakSameSite.map((c) => `${c.name} (${c.sameSite ?? 'unset'})`).slice(0, 8).join(', ')}.`,
        interpretation:
          'Current Chrome and Edge default an omitted SameSite to `Lax`, which already blocks the cross-site sends that matter most. Firefox and Safari have not made that change universally, so behaviour differs by browser. An explicit value removes the ambiguity.',
        risk:
          'Where a browser applies the older `None` default, these cookies are sent on cross-site requests. Combined with an endpoint that changes state on a simple request and no anti-forgery token, that is what makes cross-site request forgery work. Klyro tested neither of those preconditions.',
        recommendation:
          'Set `SameSite=Lax` as a baseline and `SameSite=Strict` on anything carrying a session. Where `None` is genuinely required for a cross-site embed, pair it with `Secure`.',
        evidence: {
          test: `Set-Cookie headers from GET ${landed}, parsed for the SameSite attribute`,
          observed: weakSameSite.map((c) => `${c.name}: SameSite=${c.sameSite ?? 'unset'}`).slice(0, 10).join('; '),
          expected: 'An explicit SameSite=Lax or Strict',
          verification: 'Read from the un-merged Set-Cookie list.',
          limitation:
            'The effective default depends on the visitor\'s browser, which Klyro cannot observe. No cross-site request was attempted.',
        },
        scoreImpact: Math.round((weakSameSite.length / cookies.length) * 33),
      }),
    );
  }

  if (sameSiteNoneInsecure.length > 0) {
    findings.push(
      makeFinding(KEY, {
        title: 'SameSite=None is set without Secure',
        severity: 'low',
        confidence: 'high',
        asset: landed,
        observed: `${sameSiteNoneInsecure.map((c) => c.name).join(', ')} carry \`SameSite=None\` with no \`Secure\` attribute.`,
        interpretation:
          'Every current browser rejects this combination outright and refuses to store the cookie. Whatever cross-site feature these cookies support is therefore already broken.',
        risk:
          'No exposure follows, because the cookie is never stored. It is reported because a cookie that silently fails to set usually surfaces as an intermittent functional bug rather than as a security event, and can go unnoticed for a long time.',
        recommendation: 'Add `Secure` to any cookie carrying `SameSite=None`.',
        evidence: {
          test: `Set-Cookie headers parsed for the SameSite and Secure attributes together`,
          observed: sameSiteNoneInsecure.map((c) => c.name).join(', '),
          expected: 'SameSite=None always accompanied by Secure',
          verification: 'Both attributes were read from the same header.',
        },
        scoreImpact: 10,
      }),
    );
  }

  if (broadDomain.length > 0) {
    findings.push(
      makeFinding(KEY, {
        title: 'Cookies are scoped to the whole domain rather than this host',
        severity: 'low',
        confidence: 'high',
        asset: landed,
        observed: `${broadDomain.map((c) => `${c.name} → Domain=${c.domainScope}`).slice(0, 6).join('; ')}`,
        interpretation:
          'A `Domain` attribute broader than the setting host means every subdomain receives these cookies on every request, including subdomains operated by other teams or third parties.',
        risk:
          'Any host under this domain — a marketing microsite, a partner-run portal, a staging server — receives these cookies. A compromise or misconfiguration on any of them exposes whatever the cookies contain.',
        recommendation:
          'Scope cookies to the exact host that needs them. For session cookies, the `__Host-` name prefix enforces this at the browser level.',
        evidence: {
          test: 'Set-Cookie headers parsed for the Domain attribute',
          observed: broadDomain.map((c) => `${c.name}: Domain=${c.domainScope}`).join('; '),
          expected: 'No Domain attribute, which scopes the cookie to the setting host',
          verification: 'Compared against the host actually requested.',
        },
        scoreImpact: 5,
      }),
    );
  }

  /* ---------------- Details ---------------- */

  const fullySecured = cookies.filter(
    (c) =>
      c.secure &&
      c.httpOnly &&
      c.sameSite &&
      ['strict', 'lax'].includes(c.sameSite.toLowerCase()),
  );

  details.push(
    { label: 'Cookies set on first visit', value: String(cookies.length), mono: true },
    {
      label: 'Carrying all three attributes',
      value: `${fullySecured.length} of ${cookies.length} (${pct(fullySecured.length, cookies.length)}%)`,
      mono: true,
      tone: fullySecured.length === cookies.length ? 'good' : fullySecured.length ? 'warn' : 'bad',
    },
    { label: 'Missing Secure', value: missingSecure.length ? nameList(missingSecure, 6) : 'None', mono: true, tone: missingSecure.length ? 'warn' : 'good' },
    { label: 'Missing HttpOnly', value: missingHttpOnly.length ? nameList(missingHttpOnly, 6) : 'None', mono: true, tone: missingHttpOnly.length ? 'warn' : 'good' },
    { label: 'SameSite unset or None', value: weakSameSite.length ? nameList(weakSameSite, 6) : 'None', mono: true, tone: weakSameSite.length ? 'warn' : 'good' },
    {
      label: 'Session-named cookies',
      value: sensitive.length ? nameList(sensitive, 6) : 'None observed pre-login',
      mono: true,
      tone: sensitiveInsecure.length ? 'warn' : 'neutral',
    },
    {
      label: 'Analytics cookies excluded from HttpOnly check',
      value: analytics.length ? nameList(analytics, 6) : 'None',
      mono: true,
      tone: 'neutral',
    },
    { label: 'URL inspected', value: landed, mono: true },
    SCOPE_CAVEAT,
  );

  findings.push(scopeFinding(landed));

  /* ---------------- Score ----------------
     The three attributes are not equally meaningful on a cookie whose contents
     cannot be seen, so they are not weighted equally.

     `Secure` is unconditional: there is no cookie on an HTTPS site that is
     better off without it, so it carries the most weight and applies to every
     cookie observed.

     `HttpOnly` only matters for a cookie carrying something a script should not
     read — which, pre-login, means a session token. This module states plainly
     that session cookies are issued after sign-in and are invisible to it, and
     it used to then score as though it had seen them: a site setting one
     locale-preference cookie lost two thirds of this category for the cookie
     working exactly as intended. Where no session-named cookie is observed, the
     component is dropped as unmeasured rather than failed, and the module
     coverage says so.

     `SameSite` sits between the two: current Chrome and Edge already default an
     omitted value to Lax, so its absence is a missing declaration rather than a
     missing protection, and it is weighted accordingly. */

  const secureEarned = cookies.filter((c) => c.secure).length;
  const sameSiteEarned = cookies.filter(
    (c) => c.sameSite && ['strict', 'lax'].includes(c.sameSite.toLowerCase()),
  ).length;

  const httpOnlyApplicable = sensitive.filter((c) => !CLIENT_SIDE_BY_DESIGN.test(c.name));
  const httpOnlyEarned = httpOnlyApplicable.filter((c) => c.httpOnly).length;

  const { score: baseScore, coverage, breakdown } = scoreFromComponents([
    {
      label: 'Secure attribute',
      value: (pct(secureEarned, cookies.length) / 100) * 45,
      max: 45,
      note: `${secureEarned} of ${cookies.length} cookies carry Secure. Weighted heaviest because there is no case for omitting it on an HTTPS site.`,
    },
    {
      label: 'HttpOnly on session-carrying cookies',
      value: httpOnlyApplicable.length
        ? (pct(httpOnlyEarned, httpOnlyApplicable.length) / 100) * 30
        : 0,
      max: 30,
      known: httpOnlyApplicable.length > 0,
      note: httpOnlyApplicable.length
        ? `${httpOnlyEarned} of ${httpOnlyApplicable.length} session-named cookies carry HttpOnly.`
        : 'No session-carrying cookie was issued before sign-in, so there was nothing to assess. Dropped rather than scored — the cookie that matters is issued after authentication and is not visible to an outside assessment.',
    },
    {
      label: 'SameSite declaration',
      value: (pct(sameSiteEarned, cookies.length) / 100) * 25,
      max: 25,
      note: `${sameSiteEarned} of ${cookies.length} cookies declare SameSite=Lax or Strict. Weighted below Secure because current Chrome and Edge already default an omitted value to Lax.`,
    },
  ] satisfies ScoreComponent[]);

  let score = baseScore;
  const extraPenalties: typeof breakdown = [];

  if (sensitiveInsecure.length > 0) {
    score = Math.max(0, score - 10);
    extraPenalties.push({
      label: 'Session-named cookie missing an attribute',
      value: -10,
      max: 0,
      assessed: true,
      note: `${nameList(sensitiveInsecure, 4)} carry a session-suggesting name and are missing Secure or HttpOnly.`,
    });
  }
  if (sameSiteNoneInsecure.length > 0) {
    score = Math.max(0, score - 10);
    extraPenalties.push({
      label: 'SameSite=None without Secure',
      value: -10,
      max: 0,
      assessed: true,
      note: 'The browser refuses to store these cookies at all.',
    });
  }

  const scoreBreakdown = [...breakdown, ...extraPenalties];

  if (coverage < 0.999) {
    details.push({
      label: 'Assessed weight',
      value: `${Math.round(coverage * 100)}% — what could not be observed before sign-in was excluded, not counted against the domain`,
      tone: 'neutral',
    });
  }

  const summary =
    fullySecured.length === cookies.length
      ? `All ${cookies.length} pre-login cookies carry Secure, HttpOnly and SameSite. Cookies issued after sign-in were not observed.`
      : `${fullySecured.length} of ${cookies.length} pre-login cookies carry all three protective attributes. Cookies issued after sign-in were not observed.`;

  const facts = {
    cookieCount: cookies.length,
    names: cookies.map((c) => c.name).sort(),
    fullySecured: fullySecured.length,
  };

  return { score, summary, findings, details, scoreBreakdown, moduleCoverage: coverage, facts };
}
