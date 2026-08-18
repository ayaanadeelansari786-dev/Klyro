import type { CategoryDetail, Finding } from '../types';
import {
  makeFinding,
  type ModuleOutput,
  safeFetch,
  type ScoreComponent,
  scoreFromComponents,
  truncate,
} from './util';

const KEY = 'headers' as const;

/**
 * Reads the directive value out of a CSP, falling back to default-src the way
 * a browser does.
 */
function cspDirective(policy: string, directive: string): string | null {
  const parts = policy
    .split(';')
    .map((p) => p.trim())
    .filter(Boolean);
  const exact = parts.find((p) => p.toLowerCase().startsWith(`${directive} `) || p.toLowerCase() === directive);
  if (exact) return exact.slice(directive.length).trim();
  if (directive === 'default-src') return null;
  const fallback = parts.find((p) => p.toLowerCase().startsWith('default-src'));
  return fallback ? fallback.slice('default-src'.length).trim() : null;
}

/** A source list is wide open only when it contains a bare `*`, not `*.cdn.com`. */
function hasBareWildcard(sourceList: string | null): boolean {
  if (!sourceList) return false;
  return sourceList.split(/\s+/).some((token) => token === '*' || token === 'http:' || token === 'https:');
}

export async function checkHeaders(domain: string): Promise<ModuleOutput> {
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

  const headers = res.headers;
  const landed = res.url || target;

  const get = (name: string) => headers.get(name);

  /* ---------------- HSTS ---------------- */

  const hsts = get('strict-transport-security');
  const hstsMaxAge = hsts ? Number(/max-age\s*=\s*(\d+)/i.exec(hsts)?.[1] ?? '0') : 0;
  const hstsFull = hstsMaxAge >= 31_536_000;
  let hstsScore = 0;

  if (!hsts) {
    hstsScore = 0;
    findings.push(
      makeFinding(KEY, {
        title: 'No Strict-Transport-Security header is sent',
        severity: 'medium',
        confidence: 'high',
        asset: landed,
        observed: `The response from ${landed} contains no Strict-Transport-Security header.`,
        interpretation:
          'Browsers are not being told to use HTTPS automatically for this host. Each visit that begins without an explicit https:// prefix starts as a plain HTTP request, which is then redirected if the server is configured to redirect.',
        risk:
          'That first plain request is visible and modifiable to anyone on the network path. An attacker positioned between the visitor and the server can answer it themselves and keep the session on HTTP, which the visitor is unlikely to notice. HSTS closes this window after the first successful HTTPS visit; without it the window reopens every time.',
        recommendation:
          'Send `Strict-Transport-Security: max-age=31536000; includeSubDomains` once every subdomain is confirmed to work over HTTPS. Introduce it with a short max-age first, since the directive is not easily reversible.',
        evidence: {
          test: `GET ${target}, following redirects, response headers inspected`,
          observed: 'strict-transport-security header absent',
          expected: 'strict-transport-security with max-age of at least 31536000',
          verification: `Read from the response that ${landed} actually returned.`,
          limitation:
            'Headers are read from the site root only. Other paths on the same host may send different headers.',
        },
        scoreImpact: 20,
      }),
    );
    details.push({ label: 'Strict-Transport-Security', value: 'Not sent', tone: 'bad' });
  } else if (!hstsFull) {
    hstsScore = 12;
    findings.push(
      makeFinding(KEY, {
        title: 'Strict-Transport-Security max-age is below one year',
        severity: 'low',
        confidence: 'high',
        asset: landed,
        observed: `Strict-Transport-Security: ${truncate(hsts, 120)} — a max-age of ${hstsMaxAge} seconds, roughly ${Math.round(hstsMaxAge / 86_400)} days.`,
        interpretation:
          'HSTS is in effect, but the instruction expires sooner than the one-year value the browser preload lists require. A short max-age is the correct way to introduce HSTS, so this may simply be a rollout in progress.',
        risk:
          'A visitor who does not return within the max-age window loses the protection and their next visit starts on plain HTTP again.',
        recommendation:
          'Raise max-age to 31536000 once the shorter value has been in place without incident. Add `includeSubDomains` and consider preloading after that.',
        evidence: {
          test: `GET ${target}, Strict-Transport-Security header parsed for max-age`,
          observed: hsts,
          expected: 'max-age=31536000 or greater',
          verification: `Read from the response that ${landed} actually returned.`,
        },
        scoreImpact: 8,
      }),
    );
    details.push({ label: 'Strict-Transport-Security', value: truncate(hsts, 90), mono: true, tone: 'warn' });
  } else {
    hstsScore = 20;
    details.push({ label: 'Strict-Transport-Security', value: truncate(hsts, 90), mono: true, tone: 'good' });
  }

  /* ---------------- CSP ---------------- */

  const csp = get('content-security-policy');
  const cspReportOnly = get('content-security-policy-report-only');
  let cspScore = 0;

  if (!csp && !cspReportOnly) {
    findings.push(
      makeFinding(KEY, {
        title: 'No Content-Security-Policy is sent',
        severity: 'medium',
        confidence: 'high',
        asset: landed,
        observed: `The response from ${landed} contains neither a Content-Security-Policy nor a Content-Security-Policy-Report-Only header.`,
        interpretation:
          'The site places no restriction on where the browser may load scripts, styles, frames or other content from. Whatever the page markup references, the browser fetches and runs.',
        risk:
          'If script ever executes on a page that should not — through an injection flaw, a compromised third-party tag, or a supply-chain compromise of a dependency — nothing in the browser limits what it can do or where it can send data. CSP does not prevent injection; it limits the consequences. Klyro found no injection flaw and did not look for one.',
        recommendation:
          'Deploy in report-only mode first to collect violations without breaking anything, starting from `default-src \'self\'`, then enforce once the report is clean. Nonce-based script-src is the usual endpoint.',
        evidence: {
          test: `GET ${target}, response headers inspected for content-security-policy`,
          observed: 'Neither content-security-policy nor content-security-policy-report-only present',
          expected: 'A policy at least restricting default-src and script-src',
          verification: `Read from the response that ${landed} actually returned.`,
          limitation:
            'A CSP delivered by a <meta> tag in the HTML would not appear here. Only the header form was checked.',
        },
        scoreImpact: 20,
      }),
    );
    details.push({ label: 'Content-Security-Policy', value: 'Not sent', tone: 'bad' });
  } else if (!csp && cspReportOnly) {
    cspScore = 6;
    findings.push(
      makeFinding(KEY, {
        title: 'Content-Security-Policy is in report-only mode',
        severity: 'low',
        confidence: 'high',
        asset: landed,
        observed: `Only Content-Security-Policy-Report-Only is sent: ${truncate(cspReportOnly, 140)}`,
        interpretation:
          'A policy has been written and is collecting violation reports, but the browser enforces nothing. This is the correct and intended first phase of a CSP rollout.',
        risk:
          'Until the policy is enforced, it provides no restriction on what executes in the page — the protective effect begins only when the header is switched to the enforcing form.',
        recommendation:
          'Review the collected violation reports, resolve the legitimate ones, then move the policy to the enforcing `Content-Security-Policy` header.',
        evidence: {
          test: `GET ${target}, headers inspected for both CSP forms`,
          observed: 'content-security-policy-report-only present; content-security-policy absent',
          expected: 'An enforcing content-security-policy header',
          verification: `Read from the response that ${landed} actually returned.`,
        },
        scoreImpact: 14,
      }),
    );
    details.push({ label: 'Content-Security-Policy', value: `Report-only: ${truncate(cspReportOnly, 70)}`, mono: true, tone: 'warn' });
  } else if (csp) {
    const scriptSrc = cspDirective(csp, 'script-src');
    const objectSrc = cspDirective(csp, 'object-src');
    const unsafeInline = (scriptSrc ?? '').toLowerCase().includes("'unsafe-inline'");
    const unsafeEval = (scriptSrc ?? '').toLowerCase().includes("'unsafe-eval'");
    const hasNonceOrHash = /'nonce-|'sha(256|384|512)-/i.test(scriptSrc ?? '');
    const wildcardScript = hasBareWildcard(scriptSrc);

    // `unsafe-inline` is ignored by browsers when a nonce or hash is also
    // present, so its bare presence is not automatically a weakness.
    const inlineEffective = unsafeInline && !hasNonceOrHash;

    if (wildcardScript || inlineEffective || unsafeEval) {
      cspScore = 12;
      const problems = [
        wildcardScript ? 'a bare wildcard source' : null,
        inlineEffective ? "'unsafe-inline' with no nonce or hash to override it" : null,
        unsafeEval ? "'unsafe-eval'" : null,
      ].filter(Boolean);

      findings.push(
        makeFinding(KEY, {
          title: 'Content-Security-Policy permits script sources that defeat it',
          severity: 'low',
          confidence: 'medium',
          asset: landed,
          observed: `The effective script-src is \`${truncate(scriptSrc ?? '(inherits default-src)', 120)}\`, which contains ${problems.join(' and ')}.`,
          interpretation:
            'A policy is enforced, but the script source list admits the constructions that injected script needs. The protective value of the policy is therefore much lower than its presence suggests — although it still constrains other resource types and still blocks the simplest cases.',
          risk:
            'Injected inline script executes normally under `unsafe-inline`, and a wildcard source lets script be loaded from anywhere. Klyro did not test for an injection flaw and is not asserting one exists; this describes the policy, not an exploitable path.',
          recommendation:
            'Move inline scripts into files and adopt per-response nonces, then remove `unsafe-inline` and any bare wildcard from script-src. Add `object-src \'none\'` if it is not already set.',
          evidence: {
            test: `Content-Security-Policy header parsed; script-src read with fallback to default-src`,
            observed: truncate(csp, 240),
            expected: "script-src with nonces or hashes, no 'unsafe-inline', no 'unsafe-eval', no bare wildcard",
            verification: "Nonce and hash sources were checked first, since a browser ignores 'unsafe-inline' when either is present.",
            limitation:
              'Static analysis of the policy only. Whether any page actually depends on these sources was not tested.',
          },
          scoreImpact: 8,
        }),
      );
      details.push({ label: 'Content-Security-Policy', value: truncate(csp, 90), mono: true, tone: 'warn' });
    } else {
      cspScore = 20;
      details.push({ label: 'Content-Security-Policy', value: truncate(csp, 90), mono: true, tone: 'good' });
    }

    details.push({
      label: 'CSP script-src',
      value: truncate(scriptSrc ?? '(inherits default-src)', 110),
      mono: true,
    });
    if (objectSrc) {
      details.push({ label: 'CSP object-src', value: truncate(objectSrc, 60), mono: true });
    }
  }

  /* ---------------- Framing ---------------- */

  const xfo = get('x-frame-options');
  const frameAncestors = csp ? cspDirective(csp, 'frame-ancestors') : null;
  const xfoNormalised = (xfo ?? '').toLowerCase().trim();
  const xfoValid = ['deny', 'sameorigin'].includes(xfoNormalised);
  // frame-ancestors supersedes X-Frame-Options where both are present, and is
  // sufficient on its own — reporting "missing clickjacking protection" for a
  // site that sets it is a false positive.
  const frameAncestorsRestrictive =
    frameAncestors !== null && !hasBareWildcard(frameAncestors) && frameAncestors.trim() !== '';
  const framingProtected = xfoValid || frameAncestorsRestrictive;
  const framingScore = framingProtected ? 15 : 0;

  if (!framingProtected) {
    findings.push(
      makeFinding(KEY, {
        title: 'No restriction on which sites may frame these pages',
        severity: 'low',
        confidence: 'high',
        asset: landed,
        observed: xfo
          ? `X-Frame-Options is set to \`${xfo}\`, which is not one of the two values browsers accept, and the Content-Security-Policy sets no frame-ancestors directive.`
          : 'Neither an X-Frame-Options header nor a Content-Security-Policy frame-ancestors directive is present.',
        interpretation:
          'Any other website may embed these pages in a frame. For a purely informational page that is harmless; it matters on pages carrying an authenticated action.',
        risk:
          'An attacker page can overlay invisible framed content beneath its own controls so that a visitor\'s click lands on a control in this site instead — approving a change or confirming an action they never saw. This requires the framed page to carry an action worth triggering, which Klyro did not assess.',
        recommendation:
          "Send `Content-Security-Policy: frame-ancestors 'self'`, which supersedes X-Frame-Options and is the maintained mechanism. Keep `X-Frame-Options: SAMEORIGIN` alongside it for older clients.",
        evidence: {
          test: `GET ${target}, headers inspected for x-frame-options and CSP frame-ancestors`,
          observed: xfo ? `x-frame-options: ${xfo}; no frame-ancestors directive` : 'Neither mechanism present',
          expected: "frame-ancestors 'self' or X-Frame-Options: SAMEORIGIN / DENY",
          verification: 'Both mechanisms were checked before this was reported, since either is sufficient on its own.',
          limitation:
            'Only the site root was checked, and whether any framed page carries a sensitive action was not assessed.',
        },
        scoreImpact: 15,
      }),
    );
  }

  details.push({
    label: 'Framing protection',
    value: frameAncestorsRestrictive
      ? `CSP frame-ancestors ${truncate(frameAncestors ?? '', 60)}`
      : xfoValid
        ? `X-Frame-Options: ${xfo}`
        : xfo
          ? `X-Frame-Options: ${xfo} (not a value browsers honour)`
          : 'Not set',
    mono: true,
    tone: framingProtected ? 'good' : 'bad',
  });

  /* ---------------- MIME sniffing ---------------- */

  const xcto = get('x-content-type-options');
  const xctoValid = (xcto ?? '').toLowerCase().trim() === 'nosniff';
  const xctoScore = xctoValid ? 15 : 0;

  if (!xctoValid) {
    findings.push(
      makeFinding(KEY, {
        title: xcto ? 'X-Content-Type-Options is set to a value browsers ignore' : 'No X-Content-Type-Options header is sent',
        severity: 'low',
        confidence: 'high',
        asset: landed,
        observed: xcto
          ? `X-Content-Type-Options: ${xcto}. The only value browsers act on is \`nosniff\`.`
          : 'The response contains no X-Content-Type-Options header.',
        interpretation:
          'Browsers may disregard the declared Content-Type on responses from this host and infer the type from the content instead.',
        risk:
          'Where a site serves files it did not generate — user uploads, imported documents — a file whose content resembles script can be interpreted and executed as script despite being served with a benign type. This requires such an upload path to exist, which Klyro did not test for.',
        recommendation: 'Send `X-Content-Type-Options: nosniff` on every response. It has no side effects on correctly typed content.',
        evidence: {
          test: `GET ${target}, headers inspected`,
          observed: xcto ? `x-content-type-options: ${xcto}` : 'header absent',
          expected: 'x-content-type-options: nosniff',
          verification: `Read from the response that ${landed} actually returned.`,
        },
        scoreImpact: 15,
      }),
    );
  }

  details.push({
    label: 'X-Content-Type-Options',
    value: xcto ?? 'Not sent',
    mono: true,
    tone: xctoValid ? 'good' : 'bad',
  });

  /* ---------------- Referrer policy ---------------- */

  const referrer = get('referrer-policy');
  const referrerScore = referrer ? 10 : 0;
  if (!referrer) {
    findings.push(
      makeFinding(KEY, {
        title: 'No Referrer-Policy header is sent',
        severity: 'low',
        confidence: 'high',
        asset: landed,
        observed: 'The response contains no Referrer-Policy header.',
        interpretation:
          'The browser falls back to its own default, which for current Chrome, Firefox and Safari is `strict-origin-when-cross-origin` — meaning only the origin, not the full URL, is sent to third parties. The absence of the header is therefore not the same as the absence of the protection.',
        risk:
          'Older clients, and any client whose default differs, may send the full URL of the current page to external sites the visitor navigates to. Where URLs contain account identifiers, search terms or reset tokens, those reach the third party. On a site whose URLs carry nothing sensitive, no risk follows.',
        recommendation:
          'Send `Referrer-Policy: strict-origin-when-cross-origin` to state the behaviour explicitly rather than relying on browser defaults.',
        evidence: {
          test: `GET ${target}, headers inspected`,
          observed: 'referrer-policy header absent',
          expected: 'referrer-policy: strict-origin-when-cross-origin',
          verification: `Read from the response that ${landed} actually returned.`,
          limitation:
            'Modern browsers apply a safe default. This finding reports a missing explicit declaration, not a confirmed leak.',
        },
        scoreImpact: 10,
      }),
    );
  }
  details.push({ label: 'Referrer-Policy', value: referrer ?? 'Not sent (browser default applies)', mono: true, tone: referrer ? 'good' : 'warn' });

  /* ---------------- Permissions policy ---------------- */

  const permissions = get('permissions-policy');
  const permissionsScore = permissions ? 10 : 0;
  if (!permissions) {
    findings.push(
      makeFinding(KEY, {
        title: 'No Permissions-Policy header is sent',
        severity: 'low',
        confidence: 'high',
        asset: landed,
        observed: 'The response contains no Permissions-Policy header.',
        interpretation:
          'The site does not declare which browser features it needs. Powerful features still require a user prompt, so this is a defence-in-depth control rather than an access gate.',
        risk:
          'Third-party code embedded in these pages inherits the ability to request camera, microphone, geolocation and similar features under this site\'s name. The visitor sees the prompt attributed to this site, not to the embedded party.',
        recommendation:
          'Send `Permissions-Policy: geolocation=(), camera=(), microphone=()`, then enable only what the product genuinely uses.',
        evidence: {
          test: `GET ${target}, headers inspected`,
          observed: 'permissions-policy header absent',
          expected: 'permissions-policy denying features the site does not use',
          verification: `Read from the response that ${landed} actually returned.`,
        },
        scoreImpact: 10,
      }),
    );
  }
  details.push({ label: 'Permissions-Policy', value: permissions ? truncate(permissions, 90) : 'Not sent', mono: true, tone: permissions ? 'good' : 'warn' });

  /* ---------------- X-XSS-Protection ----------------
     Reported, never scored. The filter this header controlled was removed from
     Chrome in 2019 and never existed in Firefox. Its absence is the modern
     correct state, so marking a site down for it — as this module used to —
     was penalising the right configuration. Only a harmful value is worth a
     finding. */

  const xxss = get('x-xss-protection');
  const xxssHarmful = xxss !== null && /^1/.test(xxss.trim());

  if (xxssHarmful) {
    findings.push(
      makeFinding(KEY, {
        title: 'A retired XSS filter is explicitly enabled',
        severity: 'info',
        confidence: 'high',
        asset: landed,
        observed: `X-Content-Type-Options aside, the response sets X-XSS-Protection: ${xxss}.`,
        interpretation:
          'This header enabled a browser-side filter that Chrome removed in 2019 and Firefox never implemented. In the browsers that did have it, the filtering behaviour was itself shown to introduce vulnerabilities on some sites, which is why it was withdrawn.',
        risk:
          'Effectively none on current browsers, since none implement the filter. It is noted because the recommended value is now `0`, and compliance checklists that still ask for `1; mode=block` are out of date.',
        recommendation:
          'Set `X-XSS-Protection: 0` and rely on a Content-Security-Policy instead. Removing the header entirely is equally acceptable.',
        evidence: {
          test: `GET ${target}, headers inspected`,
          observed: `x-xss-protection: ${xxss}`,
          expected: '0, or the header omitted',
          verification: `Read from the response that ${landed} actually returned.`,
        },
      }),
    );
  }

  details.push({
    label: 'X-XSS-Protection',
    value: xxss ? `${xxss} (retired header, not scored)` : 'Not sent — the current correct state',
    mono: Boolean(xxss),
    tone: 'neutral',
  });

  /* ---------------- HTTP → HTTPS redirect ---------------- */

  const httpRes = await safeFetch(`http://${domain}/`, { method: 'HEAD', redirect: 'manual' }, 6_000);
  const redirectLocation = httpRes?.headers.get('location') ?? '';
  const redirectsToHttps =
    !!httpRes &&
    httpRes.status >= 300 &&
    httpRes.status < 400 &&
    redirectLocation.toLowerCase().startsWith('https://');
  const httpListenerKnown = httpRes !== null;
  const redirectScore = redirectsToHttps ? 10 : 0;

  if (httpRes && !redirectsToHttps) {
    findings.push(
      makeFinding(KEY, {
        title: 'Plain HTTP requests are not redirected to HTTPS',
        severity: 'medium',
        confidence: 'high',
        asset: `http://${domain}/`,
        observed: `HEAD http://${domain}/ with redirects disabled returned ${httpRes.status}${redirectLocation ? ` with Location: ${truncate(redirectLocation, 80)}` : ' with no Location header'}.`,
        interpretation:
          'The server listens on port 80 but does not send visitors to the encrypted site. Whatever it returns, it returns over an unencrypted connection.',
        risk:
          'Anyone on the network path can read and alter that response. In combination with a missing HSTS header, there is no mechanism keeping a visitor on HTTPS at all once they have been moved off it.',
        recommendation: 'Return a 301 to the https:// equivalent for every path, then enable HSTS.',
        evidence: {
          test: `HEAD http://${domain}/ with redirect following disabled`,
          observed: `${httpRes.status}${redirectLocation ? ` → ${redirectLocation}` : ''}`,
          expected: '301 or 308 to an https:// URL',
          verification: 'Redirects were disabled so the first response is read directly rather than inferred from the final landing URL.',
        },
        scoreImpact: 10,
      }),
    );
  }

  details.push({
    label: 'HTTP → HTTPS redirect',
    value: redirectsToHttps ? 'Enforced' : httpRes ? `Not enforced (${httpRes.status})` : 'No HTTP listener answered',
    tone: redirectsToHttps ? 'good' : httpRes ? 'bad' : 'neutral',
  });

  /* ---------------- Banner disclosure ---------------- */

  const server = get('server');
  const poweredBy = get('x-powered-by');
  const versionInBanner = [server, poweredBy].filter(Boolean).join(' ').match(/\d+\.\d+/);

  if (poweredBy || versionInBanner) {
    findings.push(
      makeFinding(KEY, {
        title: 'Response headers disclose the server software',
        severity: 'info',
        confidence: 'high',
        asset: landed,
        observed: [server ? `Server: ${server}` : null, poweredBy ? `X-Powered-By: ${poweredBy}` : null]
          .filter(Boolean)
          .join('; '),
        interpretation:
          versionInBanner
            ? 'The banner includes what appears to be a version number. Banners can be edited or spoofed, so this identifies what the server claims to be rather than what it is.'
            : 'The banner names the software but not a version.',
        risk:
          'Version disclosure lets an attacker check the running version against known vulnerabilities without probing for them, which shortens reconnaissance. It does not create a vulnerability, and removing the banner does not fix one — this is noise reduction, not remediation.',
        recommendation:
          'Remove `X-Powered-By` and trim `Server` to the product name in the web server or framework configuration. Treat it as tidiness, and prioritise patching over hiding.',
        evidence: {
          test: `GET ${target}, response headers inspected for server identification`,
          observed: [server ? `server: ${server}` : null, poweredBy ? `x-powered-by: ${poweredBy}` : null]
            .filter(Boolean)
            .join('; '),
          expected: 'No version information in response headers',
          verification: `Read from the response that ${landed} actually returned.`,
          limitation:
            'A banner is self-reported. It may be inaccurate, deliberately misleading, or set by a proxy rather than the origin.',
        },
      }),
    );
  }

  details.push(
    { label: 'Server banner', value: server ?? 'Not disclosed', mono: true, tone: server ? 'neutral' : 'good' },
    ...(poweredBy ? [{ label: 'X-Powered-By', value: poweredBy, mono: true, tone: 'warn' as const }] : []),
    { label: 'Final response', value: `${res.status} ${res.statusText}`.trim(), mono: true },
    { label: 'URL inspected', value: landed, mono: true },
    {
      label: 'Scope of this check',
      value: 'Response headers from the site root only. Other paths, and any host other than this one, may send different headers.',
      tone: 'neutral',
    },
  );

  /* ---------------- Score ---------------- */

  const { score, coverage, breakdown } = scoreFromComponents([
    {
      label: 'Transport security (HSTS)',
      value: hstsScore,
      max: 20,
      note: !hsts ? 'No header sent.' : hstsFull ? `max-age=${hstsMaxAge}, at or above one year.` : `max-age=${hstsMaxAge}, below one year.`,
    },
    {
      label: 'Content Security Policy',
      value: cspScore,
      max: 20,
      note: !csp && !cspReportOnly ? 'No policy sent.' : !csp ? 'Report-only, not enforced.' : cspScore === 20 ? 'Enforced, with no self-defeating script sources.' : 'Enforced, but script-src admits sources that defeat it.',
    },
    {
      label: 'Framing protection',
      value: framingScore,
      max: 15,
      note: frameAncestorsRestrictive ? 'CSP frame-ancestors restricts embedding.' : xfoValid ? `X-Frame-Options: ${xfo}` : 'Neither mechanism restricts embedding.',
    },
    {
      label: 'MIME type enforcement',
      value: xctoScore,
      max: 15,
      note: xctoValid ? 'nosniff is set.' : xcto ? `Header present but set to "${xcto}", which browsers ignore.` : 'Header not sent.',
    },
    {
      label: 'Referrer policy',
      value: referrerScore,
      max: 10,
      note: referrer ? `Declared: ${truncate(referrer, 40)}` : 'Not declared; the browser default applies.',
    },
    {
      label: 'Permissions policy',
      value: permissionsScore,
      max: 10,
      note: permissions ? 'Declared.' : 'Not declared.',
    },
    {
      label: 'HTTP redirects to HTTPS',
      value: redirectScore,
      max: 10,
      known: httpListenerKnown,
      note: !httpListenerKnown
        ? 'Nothing answered on port 80, so there was no redirect to observe and this component was dropped.'
        : redirectsToHttps
          ? 'Port 80 redirects to https://.'
          : `Port 80 answered ${httpRes?.status} without redirecting to https://.`,
    },
  ] satisfies ScoreComponent[]);

  if (coverage < 0.999) {
    details.push({
      label: 'Assessed weight',
      value: `${Math.round(coverage * 100)}% — what could not be observed was excluded, not counted against the domain`,
      tone: 'neutral',
    });
  }

  const missing = [
    !hsts ? 'HSTS' : null,
    !csp && !cspReportOnly ? 'Content-Security-Policy' : null,
    !framingProtected ? 'framing protection' : null,
    !xctoValid ? 'nosniff' : null,
  ].filter(Boolean) as string[];

  const summary =
    missing.length === 0
      ? 'Every high-value browser security header is present on the site root.'
      : `${missing.length} of the four high-value browser security headers ${missing.length === 1 ? 'is' : 'are'} absent from the site root: ${missing.join(', ')}.`;

  const facts = {
    hsts: hsts ?? null,
    hstsMaxAge,
    csp: csp ?? null,
    cspReportOnly: Boolean(cspReportOnly && !csp),
    framingProtected,
    nosniff: xctoValid,
    server: server ?? null,
    poweredBy: poweredBy ?? null,
    redirectsToHttps,
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
