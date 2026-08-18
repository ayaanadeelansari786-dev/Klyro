import { describe, expect, it } from 'vitest';

import {
  cookieNamesFrom,
  detectPlatform,
  isSensitivePlatform,
  looksLikeSignIn,
  metaGeneratorOf,
  readCapped,
  titleOf,
} from '@/lib/checks/probe';
import { classifyName, countByTier, groupByTier, tierSubdomain } from '@/lib/checks/tiering';
import { assetUrlsFrom, externalHostsFrom, versionFromUrl } from '@/lib/checks/technologies';
import type { SubdomainResult } from '@/lib/types';

/**
 * Klyro now reads response bodies from hosts it discovered rather than hosts
 * the operator submitted. That is a meaningful escalation in what the scanner
 * does, and these tests hold the two lines that make it defensible: nothing is
 * captured beyond what identifies software, and reaching a page is never
 * reported as bypassing its authentication.
 */

/* ------------------------------------------------------------------ *
 * Cookie handling — the one that would be indefensible to get wrong
 * ------------------------------------------------------------------ */

describe('cookie capture', () => {
  function headersWith(...cookies: string[]): Headers {
    const headers = new Headers();
    for (const cookie of cookies) headers.append('set-cookie', cookie);
    return headers;
  }

  it('keeps the name and discards the value', () => {
    const names = cookieNamesFrom(headersWith('JSESSIONID=A1B2C3D4E5F6; Path=/; HttpOnly'));
    expect(names).toEqual(['JSESSIONID']);
  });

  it('never lets a session value survive, whatever the cookie looks like', () => {
    const secret = 'eyJhbGciOiJIUzI1NiJ9.SUPERSECRETSESSION.signature';
    const names = cookieNamesFrom(
      headersWith(
        `session=${secret}; Secure`,
        `csrftoken=${secret}`,
        // A value containing its own `=` is the case a naive split gets wrong.
        `auth=${secret}==; Path=/`,
      ),
    );

    expect(names).toEqual(['session', 'csrftoken', 'auth']);
    for (const name of names) {
      expect(name).not.toContain('SUPERSECRET');
      expect(name).not.toContain('=');
    }
  });

  it('drops malformed entries rather than recording half a header', () => {
    expect(cookieNamesFrom(headersWith('not a cookie at all'))).toEqual([]);
  });

  it('deduplicates and caps, so a host cannot flood the record', () => {
    const many = Array.from({ length: 40 }, (_, i) => `c${i}=value`);
    const names = cookieNamesFrom(headersWith(...many, 'c0=other'));
    expect(names.length).toBeLessThanOrEqual(12);
    expect(new Set(names).size).toBe(names.length);
  });
});

/* ------------------------------------------------------------------ *
 * Body reading
 * ------------------------------------------------------------------ */

describe('size-limited body reading', () => {
  it('stops at the cap rather than reading an unbounded response', async () => {
    const body = 'x'.repeat(200_000);
    const text = await readCapped(new Response(body), 8 * 1024, 1_000);
    expect(text.length).toBeLessThanOrEqual(8 * 1024);
    expect(text.length).toBeGreaterThan(0);
  });

  it('returns what arrived when the response is shorter than the cap', async () => {
    const text = await readCapped(new Response('<title>Small</title>'), 8 * 1024, 1_000);
    expect(text).toBe('<title>Small</title>');
  });

  it('gives back an empty string rather than throwing on a bodyless response', async () => {
    const text = await readCapped(new Response(null, { status: 204 }), 1_024, 1_000);
    expect(text).toBe('');
  });
});

/* ------------------------------------------------------------------ *
 * Markup extraction
 * ------------------------------------------------------------------ */

describe('title extraction', () => {
  it('reads a title and collapses whitespace', () => {
    expect(titleOf('<html><head><title>  Dashboard\n  [Jenkins]  </title>')).toBe(
      'Dashboard [Jenkins]',
    );
  });

  it('decodes the entities a title actually carries', () => {
    expect(titleOf('<title>Acme &amp; Co &#39;staging&#39;</title>')).toBe("Acme & Co 'staging'");
  });

  it('returns null when there is no title', () => {
    expect(titleOf('<html><body>no head</body></html>')).toBeNull();
  });

  it('reads a generator tag in either attribute order', () => {
    expect(metaGeneratorOf('<meta name="generator" content="WordPress 6.4">')).toBe('WordPress 6.4');
    expect(metaGeneratorOf('<meta content="Drupal 10" name="generator">')).toBe('Drupal 10');
  });
});

/* ------------------------------------------------------------------ *
 * Platform identification
 * ------------------------------------------------------------------ */

describe('platform identification', () => {
  const empty = { title: null, markup: '', cookieNames: [] as string[], headerBlob: '' };

  it('identifies from a title however it is cased', () => {
    for (const title of ['Dashboard [Jenkins]', 'jenkins', 'JENKINS']) {
      expect(detectPlatform({ ...empty, title })?.name).toBe('Jenkins');
    }
  });

  it('identifies from a cookie name', () => {
    expect(detectPlatform({ ...empty, cookieNames: ['grafana_session'] })?.name).toBe('Grafana');
  });

  it('identifies from an application-shell marker', () => {
    expect(detectPlatform({ ...empty, markup: '<link href="/wp-content/x.css">' })?.name).toBe(
      'WordPress',
    );
  });

  it('prefers a product-specific signal over a brand name in the title', () => {
    // A cookie only Grafana sets beats a title that merely says "Jenkins".
    const match = detectPlatform({
      ...empty,
      title: 'Jenkins',
      cookieNames: ['grafana_session'],
    });
    expect(match?.name).toBe('Grafana');
    expect(match?.strength).toBe('strong');
  });

  it('carries the evidence that produced the identification', () => {
    const match = detectPlatform({ ...empty, cookieNames: ['pga4_session'] });
    expect(match?.name).toBe('pgAdmin');
    expect(match?.evidence).toContain('pga4_session');
  });

  /*
   * The gitlab.com regression, reproduced.
   *
   * A live scan produced eight critical findings against gitlab.com because
   * every page in the estate has "GitLab" in its title — GitLab the company
   * owns the domain. The scanner reported marketing pages as reachable
   * source-control servers and the category scored 24. A brand name is a
   * mention, not a deployment.
   */
  it('treats a brand name in a title as a mention, not a deployment', () => {
    const match = detectPlatform({ ...empty, title: 'Campaign Manager | GitLab' });

    expect(match?.name).toBe('GitLab');
    expect(match?.strength).toBe('weak');
    // The half that matters: a weak match must never mark the host sensitive,
    // because that is what drives the critical tier.
    expect(match?.sensitive).toBe(false);
    expect(match?.evidence).toMatch(/does not demonstrate/i);
  });

  it('does mark it sensitive once the response emits something only that product emits', () => {
    const match = detectPlatform({ ...empty, cookieNames: ['_gitlab_session'] });

    expect(match?.name).toBe('GitLab');
    expect(match?.strength).toBe('strong');
    expect(match?.sensitive).toBe(true);
  });

  /*
   * Over-generic cookie rules. `sid` and `session` sat in this table once,
   * against Kibana, Harbor and Airflow — which would have identified a large
   * share of the internet as an Apache Airflow deployment.
   */
  it.each(['sid', 'session', 'JSESSIONID', 'id'])(
    'does not identify anything from the generic cookie %s',
    (cookie) => {
      expect(detectPlatform({ ...empty, cookieNames: [cookie] })).toBeNull();
    },
  );

  it('separates software whose reachability is material from software that is ordinary', () => {
    expect(isSensitivePlatform('Jenkins')).toBe(true);
    expect(isSensitivePlatform('Grafana')).toBe(true);
    expect(isSensitivePlatform('WordPress')).toBe(false);
    expect(isSensitivePlatform(null)).toBe(false);
  });

  it('returns null rather than guessing when nothing identifies the response', () => {
    expect(detectPlatform({ ...empty, markup: '<html><body>hello</body></html>' })).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Sign-in detection
 *
 * This is what stops "answered 200" from being reported as "no authentication
 * required". It is deliberately generous: a false positive downgrades a
 * finding, which is the direction an inference should fail in.
 * ------------------------------------------------------------------ */

describe('sign-in detection', () => {
  const base = { status: 200, title: null, markup: '', redirectTarget: null, authType: null };

  it.each([
    ['a 401', { ...base, status: 401 }],
    ['a 403', { ...base, status: 403 }],
    ['an auth challenge', { ...base, authType: 'Basic' }],
    ['a redirect to a login path', { ...base, status: 302, redirectTarget: 'https://x.test/login' }],
    ['a redirect to SSO', { ...base, status: 302, redirectTarget: 'https://x.test/sso/saml' }],
    ['a sign-in title', { ...base, title: 'Sign in · Grafana' }],
    ['a password field', { ...base, markup: '<input type="password" name="pw">' }],
  ])('treats %s as a sign-in requirement', (_label, input) => {
    expect(looksLikeSignIn(input)).toBe(true);
  });

  it('does not invent a sign-in requirement from an ordinary page', () => {
    expect(looksLikeSignIn({ ...base, title: 'Grafana', markup: '<div id="reactRoot"></div>' })).toBe(
      false,
    );
  });
});

/* ------------------------------------------------------------------ *
 * Name classification
 * ------------------------------------------------------------------ */

describe('name classification', () => {
  it.each([
    ['admin', 'admin'],
    ['backoffice', 'admin'],
    ['jenkins', 'cicd'],
    ['build-01', 'cicd'],
    ['grafana', 'data'],
    ['postgres', 'data'],
    ['staging', 'nonprod'],
    ['uat', 'nonprod'],
    ['internal', 'nonprod'],
    ['vpn', 'remote'],
    ['www', 'public'],
  ])('places %s in the %s class', (prefix, expected) => {
    expect(classifyName(prefix)?.key).toBe(expected);
  });

  it('matches on label boundaries rather than substrings', () => {
    // `administer` and `development` would both match a naive substring test;
    // only the second is a real label.
    expect(classifyName('cdn')?.key).toBe('public');
    expect(classifyName('marketing')).toBeNull();
    expect(classifyName('devel')?.key).toBe('nonprod');
  });
});

/* ------------------------------------------------------------------ *
 * Tiering
 * ------------------------------------------------------------------ */

function tierInput(overrides: Partial<Parameters<typeof tierSubdomain>[0]> = {}) {
  return {
    hostname: 'host.example.com',
    prefix: 'host',
    statusCode: 200,
    detectedPlatform: null,
    platformSensitive: false,
    looksLikeLogin: false,
    redirectTarget: null,
    unreachableReason: null,
    exposedSecrets: [] as string[],
    ...overrides,
  };
}

describe('risk tiering', () => {
  it('is critical when sensitive software serves a page with no sign-in prompt', () => {
    const { riskTier, riskReason } = tierSubdomain(
      tierInput({ prefix: 'ci', detectedPlatform: 'Jenkins', platformSensitive: true }),
    );
    expect(riskTier).toBe('critical');
    expect(riskReason).toContain('Jenkins');
  });

  it('does not claim the system is unauthenticated, only that no prompt was seen', () => {
    const { riskReason } = tierSubdomain(
      tierInput({ detectedPlatform: 'Grafana', platformSensitive: true }),
    );
    // The failure this guards against is the report asserting a bypass it did
    // not perform. See the note at the top of tiering.ts.
    expect(riskReason).not.toMatch(/without authentication|unauthenticated|no authentication/i);
    expect(riskReason).toMatch(/did not authenticate/i);
  });

  it('drops to high when the same software returns a sign-in page', () => {
    const { riskTier, riskReason } = tierSubdomain(
      tierInput({ detectedPlatform: 'Jenkins', platformSensitive: true, looksLikeLogin: true }),
    );
    expect(riskTier).toBe('high');
    expect(riskReason).toMatch(/sign-in page/i);
  });

  it('is critical when a path exposure was confirmed on the host', () => {
    const { riskTier, riskReason } = tierSubdomain(tierInput({ exposedSecrets: ['/.env'] }));
    expect(riskTier).toBe('critical');
    expect(riskReason).toContain('/.env');
  });

  it('is high for an administrative name that answers', () => {
    expect(tierSubdomain(tierInput({ prefix: 'admin' })).riskTier).toBe('high');
    expect(tierSubdomain(tierInput({ prefix: 'admin', statusCode: 302 })).riskTier).toBe('high');
  });

  /*
   * Observed live on sap.com: `people-admin.services.sap.com` returned 403 and
   * fell through every rule to the `info` default, which then said "nothing in
   * the name or the response suggests a sensitive system" about a host called
   * people-admin. A refusal is weaker than an open console and much stronger
   * than nothing.
   */
  it('does not drop an administrative name to info because it returned 403', () => {
    const { riskTier, riskReason } = tierSubdomain(
      tierInput({ hostname: 'people-admin.example.com', prefix: 'people-admin', statusCode: 403 }),
    );

    expect(riskTier).toBe('medium');
    expect(riskReason).toMatch(/administrative interface/i);
    expect(riskReason).not.toMatch(/nothing in the name/i);
  });

  it('never claims a classified name suggests nothing', () => {
    for (const prefix of ['admin', 'jenkins', 'postgres', 'staging', 'vpn']) {
      const { riskReason } = tierSubdomain(tierInput({ prefix, statusCode: 418 }));
      expect(riskReason, `${prefix} was described as unremarkable`).not.toMatch(
        /nothing in the name/i,
      );
    }
  });

  it('is high for a build or database name that answers anything at all', () => {
    expect(tierSubdomain(tierInput({ prefix: 'jenkins', statusCode: 503 })).riskTier).toBe('high');
    expect(tierSubdomain(tierInput({ prefix: 'postgres', statusCode: 403 })).riskTier).toBe('high');
  });

  it('is medium for a non-production name that answers', () => {
    for (const statusCode of [200, 302, 403]) {
      expect(tierSubdomain(tierInput({ prefix: 'staging', statusCode })).riskTier).toBe('medium');
    }
  });

  it('is low for a non-production name that is offline', () => {
    const { riskTier, riskReason } = tierSubdomain(
      tierInput({ prefix: 'staging', statusCode: 503 }),
    );
    expect(riskTier).toBe('low');
    expect(riskReason).toMatch(/nothing is currently serving/i);
  });

  it('is medium for a remote access gateway, and says why that is expected', () => {
    const { riskTier, riskReason } = tierSubdomain(tierInput({ prefix: 'vpn' }));
    expect(riskTier).toBe('medium');
    expect(riskReason).toMatch(/meant to be reachable/i);
  });

  it('is info for an ordinary public name with nothing behind it', () => {
    expect(tierSubdomain(tierInput({ prefix: 'www' })).riskTier).toBe('info');
  });

  /*
   * The budget case. A host nobody requested must never be described as a host
   * that answered nothing — that reports a limit of the scan as a fact about
   * the target, and it is invisible in the output unless something checks.
   */
  it('never presents an unprobed host as an unreachable one', () => {
    const { riskTier, riskReason } = tierSubdomain(
      tierInput({ prefix: 'admin', statusCode: null, unreachableReason: 'not-probed' }),
    );

    expect(riskTier).toBe('medium');
    expect(riskReason).toMatch(/probe budget|no HTTP request/i);
    expect(riskReason).not.toMatch(/no response|did not answer|refused/i);
  });

  it('distinguishes a timeout from a refusal in what it reports', () => {
    const timedOut = tierSubdomain(
      tierInput({ prefix: 'thing', statusCode: null, unreachableReason: 'timed-out' }),
    );
    const refused = tierSubdomain(
      tierInput({ prefix: 'thing', statusCode: null, unreachableReason: 'no-response' }),
    );

    expect(timedOut.riskReason).toMatch(/deadline/i);
    expect(refused.riskReason).not.toMatch(/deadline/i);
  });
});

describe('tier grouping', () => {
  const hosts = [
    { hostname: 'b.example.com', riskTier: 'high' },
    { hostname: 'a.example.com', riskTier: 'high' },
    { hostname: 'c.example.com', riskTier: 'info' },
  ] as SubdomainResult[];

  it('groups and sorts within a tier', () => {
    expect(groupByTier(hosts).high.map((h) => h.hostname)).toEqual([
      'a.example.com',
      'b.example.com',
    ]);
  });

  it('counts every tier, including the empty ones', () => {
    expect(countByTier(hosts)).toEqual({ critical: 0, high: 2, medium: 0, low: 0, info: 1 });
  });
});

/* ------------------------------------------------------------------ *
 * Technology extraction
 * ------------------------------------------------------------------ */

describe('asset extraction', () => {
  const markup = `
    <script src="https://cdn.example.net/jquery-3.6.0.min.js"></script>
    <script src="/local/app.js"></script>
    <link rel="stylesheet" href="https://fonts.vendor.test/style.css">
    <link rel="icon" href="https://icons.vendor.test/favicon.ico">
    <script src="https://js.stripe.com/v3"></script>
  `;

  it('collects script sources and stylesheet links only', () => {
    const urls = assetUrlsFrom(markup);
    expect(urls).toContain('https://cdn.example.net/jquery-3.6.0.min.js');
    expect(urls).toContain('https://fonts.vendor.test/style.css');
    // A favicon is not code and does not belong in a supply-chain count.
    expect(urls).not.toContain('https://icons.vendor.test/favicon.ico');
  });

  it('counts external hosts and excludes the domain and its own subdomains', () => {
    const urls = assetUrlsFrom(markup);
    const hosts = externalHostsFrom(
      [...urls, 'https://static.example.com/x.js', 'https://example.com/y.js'],
      'example.com',
    );

    expect(hosts).toEqual(['cdn.example.net', 'fonts.vendor.test', 'js.stripe.com']);
  });
});

describe('version reading', () => {
  it.each([
    ['https://cdn.test/jquery-3.6.0.min.js', 'jQuery', '3.6.0'],
    ['https://cdn.test/ajax/libs/jquery/1.12.4/jquery.min.js', 'jQuery', '1.12.4'],
    ['https://cdn.test/vue@2.6.14/dist/vue.js', 'Vue', '2.6.14'],
  ])('reads %s as %s %s', (url, library, expected) => {
    expect(versionFromUrl(url, library)).toBe(expected);
  });

  it('returns null rather than inventing a version for an unversioned path', () => {
    expect(versionFromUrl('https://example.com/js/app.min.js', 'jQuery')).toBeNull();
    expect(versionFromUrl('https://example.com/js/jquery.min.js', 'jQuery')).toBeNull();
  });
});
