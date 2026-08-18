import { afterEach, describe, expect, it, vi } from 'vitest';

import { checkCors } from '@/lib/checks/cors';
import { checkExposedPaths } from '@/lib/checks/exposed-paths';
import { checkHeaders } from '@/lib/checks/headers';

const DOMAIN = 'example.test';

afterEach(() => {
  vi.unstubAllGlobals();
});

interface Route {
  /** Matched against the path, or `*` for anything unmatched. */
  path: string;
  status?: number;
  headers?: Record<string, string>;
  body?: string;
}

/**
 * A stubbed origin.
 *
 * `safeFetch` now follows redirects one hop at a time so it can inspect each
 * one, which means a redirect in a fixture is modelled the way a server
 * actually sends it — a 3xx with a Location header — rather than as an opaque
 * "this is where it ended up".
 */
function stubOrigin(routes: Route[], options: { httpPort80?: Route | null } = {}) {
  const requests: { method: string; url: string; origin?: string }[] = [];

  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers((init?.headers ?? {}) as HeadersInit);
    requests.push({ method, url, origin: headers.get('origin') ?? undefined });

    const parsed = new URL(url);

    if (parsed.protocol === 'http:') {
      const rule = options.httpPort80;
      if (!rule) throw new Error('connection refused');
      return build(rule, url);
    }

    const match =
      routes.find((r) => r.path === parsed.pathname) ?? routes.find((r) => r.path === '*');
    if (!match) throw new Error(`no route for ${parsed.pathname}`);

    return build(match, url);
  });

  return requests;

  function build(rule: Route, url: string): Response {
    const status = rule.status ?? 200;
    // Node forbids a body on 204/304; redirects carry none in practice either.
    const bodyless = status === 204 || status === 304 || (status >= 300 && status < 400);
    const res = new Response(bodyless ? null : (rule.body ?? ''), {
      status,
      headers: rule.headers ?? {},
    });
    Object.defineProperty(res, 'url', { value: url, configurable: true });
    return res;
  }
}

/* ------------------------------------------------------------------ *
 * CORS
 * ------------------------------------------------------------------ */

describe('CORS', () => {
  it('treats a wildcard on public content as informational, not a leak', async () => {
    stubOrigin([{ path: '*', headers: { 'access-control-allow-origin': '*' } }]);
    const out = await checkCors(DOMAIN);

    const finding = out.findings.find(
      (f) => f.title === 'Site root is readable cross-origin by any website',
    );
    expect(finding?.severity).toBe('info');
    // The regression this guards: a wildcard used to score 20/100 and read
    // "if any of these responses vary by user, it is a data leak".
    expect(out.score).toBeGreaterThanOrEqual(95);
    expect(finding?.risk).toMatch(/None for content that is public anyway/i);
  });

  it('reports reflection plus credentials at high severity, without asserting a breach', async () => {
    stubOrigin([
      {
        path: '*',
        headers: {
          'access-control-allow-origin': 'https://klyro-cors-probe.example',
          'access-control-allow-credentials': 'true',
          vary: 'Origin',
        },
      },
    ]);
    const out = await checkCors(DOMAIN);

    const finding = out.findings.find(
      (f) => f.title === 'Site echoes any requesting origin and permits credentials',
    );
    expect(finding?.severity).toBe('high');
    expect(finding?.risk).toMatch(/did not prove that any user-specific response is reachable/i);
    expect(out.score).toBeLessThan(50);
  });

  it('reports wildcard-with-credentials as inert, because browsers reject it', async () => {
    stubOrigin([
      {
        path: '*',
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-credentials': 'true',
        },
      },
    ]);
    const out = await checkCors(DOMAIN);

    const finding = out.findings.find(
      (f) => f.title === 'Wildcard origin is declared together with credentials',
    );
    expect(finding?.severity).toBe('low');
    expect(finding?.risk).toMatch(/No cross-origin exposure follows/i);
  });

  it('scores a site that shares nothing at full marks', async () => {
    stubOrigin([{ path: '*', headers: {} }]);
    const out = await checkCors(DOMAIN);

    expect(out.score).toBe(100);
    expect(out.summary).toMatch(/shares nothing cross-origin/);
  });

  it('always states that only the site root was tested', async () => {
    stubOrigin([{ path: '*', headers: {} }]);
    const out = await checkCors(DOMAIN);

    expect(out.findings.map((f) => f.title)).toContain(
      'Cross-origin review covers the site root only',
    );
  });

  it('flags a missing Vary: Origin only when the policy is dynamic', async () => {
    stubOrigin([{ path: '*', headers: { 'access-control-allow-origin': '*' } }]);
    const wildcardOnly = await checkCors(DOMAIN);
    expect(wildcardOnly.findings.map((f) => f.title)).not.toContain(
      'Per-origin responses are not marked as varying by origin',
    );

    vi.unstubAllGlobals();
    stubOrigin([
      { path: '*', headers: { 'access-control-allow-origin': 'https://klyro-cors-probe.example' } },
    ]);
    const reflecting = await checkCors(DOMAIN);
    expect(reflecting.findings.map((f) => f.title)).toContain(
      'Per-origin responses are not marked as varying by origin',
    );
  });
});

/* ------------------------------------------------------------------ *
 * Headers
 * ------------------------------------------------------------------ */

describe('security headers', () => {
  const fullHeaders = {
    'strict-transport-security': 'max-age=31536000; includeSubDomains',
    'content-security-policy': "default-src 'self'; script-src 'self' 'nonce-abc'",
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'SAMEORIGIN',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'permissions-policy': 'geolocation=()',
  };

  it('scores a fully configured site at 100', async () => {
    stubOrigin([{ path: '*', headers: fullHeaders }], {
      httpPort80: { path: '/', status: 301, headers: { location: `https://${DOMAIN}/` } },
    });
    const out = await checkHeaders(DOMAIN);

    expect(out.score).toBe(100);
  });

  it('accepts CSP frame-ancestors in place of X-Frame-Options', async () => {
    const { 'x-frame-options': _xfo, ...withoutXfo } = fullHeaders;
    stubOrigin(
      [
        {
          path: '*',
          headers: {
            ...withoutXfo,
            'content-security-policy': "default-src 'self'; script-src 'self' 'nonce-abc'; frame-ancestors 'self'",
          },
        },
      ],
      { httpPort80: { path: '/', status: 301, headers: { location: `https://${DOMAIN}/` } } },
    );
    const out = await checkHeaders(DOMAIN);

    // The false positive this replaced: a site setting frame-ancestors was
    // told it had no clickjacking protection.
    expect(out.findings.map((f) => f.title)).not.toContain(
      'No restriction on which sites may frame these pages',
    );
    expect(out.score).toBe(100);
  });

  it('does not penalise a missing X-XSS-Protection header', async () => {
    stubOrigin([{ path: '*', headers: fullHeaders }], {
      httpPort80: { path: '/', status: 301, headers: { location: `https://${DOMAIN}/` } },
    });
    const out = await checkHeaders(DOMAIN);

    // The header controls a filter Chrome removed in 2019. Its absence is the
    // correct modern state, and this module used to deduct for it.
    expect(out.scoreBreakdown?.some((l) => l.label.includes('XSS'))).toBe(false);
    expect(out.details.find((d) => d.label === 'X-XSS-Protection')?.value).toMatch(
      /current correct state/,
    );
  });

  it('ignores unsafe-inline when a nonce is also present', async () => {
    stubOrigin(
      [
        {
          path: '*',
          headers: {
            ...fullHeaders,
            'content-security-policy': "script-src 'self' 'unsafe-inline' 'nonce-abc'",
          },
        },
      ],
      { httpPort80: { path: '/', status: 301, headers: { location: `https://${DOMAIN}/` } } },
    );
    const out = await checkHeaders(DOMAIN);

    // Browsers ignore 'unsafe-inline' in the presence of a nonce, so treating
    // it as a weakness would be reporting a rule that never applies.
    expect(out.findings.map((f) => f.title)).not.toContain(
      'Content-Security-Policy permits script sources that defeat it',
    );
  });

  it('flags a bare wildcard in script-src but not a wildcarded host', async () => {
    stubOrigin(
      [{ path: '*', headers: { ...fullHeaders, 'content-security-policy': "script-src *" } }],
      { httpPort80: { path: '/', status: 301, headers: { location: `https://${DOMAIN}/` } } },
    );
    const bare = await checkHeaders(DOMAIN);
    expect(bare.findings.map((f) => f.title)).toContain(
      'Content-Security-Policy permits script sources that defeat it',
    );

    vi.unstubAllGlobals();
    stubOrigin(
      [
        {
          path: '*',
          headers: { ...fullHeaders, 'content-security-policy': "script-src 'self' *.cdn.example" },
        },
      ],
      { httpPort80: { path: '/', status: 301, headers: { location: `https://${DOMAIN}/` } } },
    );
    const scoped = await checkHeaders(DOMAIN);
    expect(scoped.findings.map((f) => f.title)).not.toContain(
      'Content-Security-Policy permits script sources that defeat it',
    );
  });

  it('drops the redirect component when nothing answers on port 80', async () => {
    stubOrigin([{ path: '*', headers: fullHeaders }], { httpPort80: null });
    const out = await checkHeaders(DOMAIN);

    const line = out.scoreBreakdown?.find((l) => l.label === 'HTTP redirects to HTTPS');
    expect(line?.assessed).toBe(false);
    expect(out.moduleCoverage).toBeLessThan(1);
    // No listener is not the same as no redirect, so no finding either.
    expect(out.findings.map((f) => f.title)).not.toContain(
      'Plain HTTP requests are not redirected to HTTPS',
    );
  });

  it('reports a missing Referrer-Policy without claiming a leak', async () => {
    const { 'referrer-policy': _rp, ...withoutReferrer } = fullHeaders;
    stubOrigin([{ path: '*', headers: withoutReferrer }], {
      httpPort80: { path: '/', status: 301, headers: { location: `https://${DOMAIN}/` } },
    });
    const out = await checkHeaders(DOMAIN);

    const finding = out.findings.find((f) => f.title === 'No Referrer-Policy header is sent');
    expect(finding?.severity).toBe('low');
    expect(finding?.interpretation).toMatch(/browser falls back to its own default/i);
    expect(finding?.evidence.limitation).toMatch(/not a confirmed leak/i);
  });
});

/* ------------------------------------------------------------------ *
 * Exposed paths
 * ------------------------------------------------------------------ */

describe('exposed paths', () => {
  it('does not report a path merely because it returned 200', async () => {
    // Everything answers 200 with unrelated marketing content.
    stubOrigin([{ path: '*', status: 200, body: '<html><h1>Welcome</h1></html>' }]);
    const out = await checkExposedPaths(DOMAIN);

    expect(out.findings.filter((f) => f.severity !== 'info')).toHaveLength(0);
    expect(out.score).toBe(100);
  });

  it('calibrates against a site that answers 200 for unknown paths', async () => {
    stubOrigin([{ path: '*', status: 200, body: '<html>SPA shell</html>' }]);
    const out = await checkExposedPaths(DOMAIN);

    expect(out.details.find((d) => d.label === 'Unknown-path calibration')?.value).toMatch(
      /answers 200 for randomly generated paths/,
    );
  });

  it('confirms a genuine .env by its content, not its status', async () => {
    stubOrigin([
      { path: '/.env', status: 200, body: 'DB_PASSWORD=hunter2\nAPI_KEY=abc\n' },
      { path: '*', status: 404 },
    ]);
    const out = await checkExposedPaths(DOMAIN);

    const finding = out.findings.find((f) => f.title.includes('Environment configuration file'));
    expect(finding).toBeDefined();
    expect(finding?.confidence).toBe('high');
    expect(finding?.evidence.limitation).toMatch(/sent no credentials/i);
  });

  it('discounts a path that redirects to the homepage', async () => {
    stubOrigin([
      // HEAD says something is there; GET is redirected back to the root,
      // where a sign-in form would match the admin-interface signature.
      { path: '/admin', status: 302, headers: { location: `https://${DOMAIN}/` } },
      { path: '/', status: 200, body: '<form><input type="password" name="password"></form>' },
      { path: '*', status: 404 },
    ]);
    const out = await checkExposedPaths(DOMAIN);

    expect(out.findings.filter((f) => f.severity !== 'info')).toHaveLength(0);
    expect(out.details.find((d) => d.label === 'Discounted after verification')?.value).toMatch(
      /redirected away from the requested path/,
    );
  });

  it('keeps a path whose redirect stays on the same resource', async () => {
    stubOrigin([
      { path: '/admin', status: 302, headers: { location: `https://${DOMAIN}/admin/login` } },
      {
        path: '/admin/login',
        status: 200,
        body: '<form><input type="password" name="password"></form>',
      },
      { path: '*', status: 404 },
    ]);
    const out = await checkExposedPaths(DOMAIN);

    // /admin → /admin/login is the resource, not a bounce to the homepage.
    expect(out.findings.map((f) => f.title)).toContain('Admin interface responds at /admin');
  });

  it('records a 403 as a positive observation rather than exposure', async () => {
    stubOrigin([
      { path: '/.env', status: 403 },
      { path: '/.git/HEAD', status: 403 },
      { path: '*', status: 404 },
    ]);
    const out = await checkExposedPaths(DOMAIN);

    const finding = out.findings.find((f) => f.title === 'Sensitive paths are refused by the server');
    expect(finding?.severity).toBe('info');
    expect(finding?.risk).toMatch(/None\. This is recorded as a positive observation/);
    expect(out.score).toBe(100);
  });

  it('separates a 401 from an open path and charges it lightly', async () => {
    stubOrigin([
      { path: '/admin', status: 401 },
      { path: '*', status: 404 },
    ]);
    const out = await checkExposedPaths(DOMAIN);

    const finding = out.findings.find((f) => f.title.includes('exists behind authentication'));
    expect(finding?.severity).toBe('low');
    expect(out.score).toBe(96);
  });

  it('throws rather than scoring when the site does not answer', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('connection refused');
    });

    await expect(checkExposedPaths(DOMAIN)).rejects.toThrow(/did not respond/);
  });
});
