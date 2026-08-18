import { afterEach, describe, expect, it, vi } from 'vitest';

import { checkCookies } from '@/lib/checks/cookies';

const DOMAIN = 'example.test';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Node's fetch exposes the un-merged Set-Cookie list via getSetCookie(). */
function stubCookies(cookies: string[]) {
  vi.stubGlobal('fetch', async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers();
    for (const cookie of cookies) headers.append('set-cookie', cookie);
    const res = new Response('', { status: 200, headers });
    Object.defineProperty(res, 'url', { value: url });
    return res;
  });
}

describe('cookie scoring', () => {
  it('scores a site with no cookies at full marks', async () => {
    stubCookies([]);
    const out = await checkCookies(DOMAIN);

    expect(out.score).toBe(100);
    expect(out.summary).toMatch(/sets no cookies/);
  });

  it('does not punish a preference cookie for being readable by script', async () => {
    // The regression this guards: one Secure locale cookie without HttpOnly or
    // SameSite used to score 33/100, because the module scored HttpOnly as
    // though it had seen a session cookie it explicitly says it cannot see.
    stubCookies(['__locale__=en-GB; Path=/; Secure']);
    const out = await checkCookies(DOMAIN);

    const httpOnlyLine = out.scoreBreakdown?.find((l) => l.label.startsWith('HttpOnly'));
    expect(httpOnlyLine?.assessed).toBe(false);
    expect(out.moduleCoverage).toBeLessThan(1);
    expect(out.score).toBeGreaterThanOrEqual(60);
  });

  it('still scores HttpOnly when a session-named cookie is visible', async () => {
    stubCookies(['sessionid=abc; Path=/; Secure']);
    const out = await checkCookies(DOMAIN);

    const httpOnlyLine = out.scoreBreakdown?.find((l) => l.label.startsWith('HttpOnly'));
    expect(httpOnlyLine?.assessed).toBe(true);
    expect(httpOnlyLine?.value).toBe(0);
    expect(out.score).toBeLessThan(50);
  });

  it('gives full marks to a correctly configured session cookie', async () => {
    stubCookies(['sessionid=abc; Path=/; Secure; HttpOnly; SameSite=Lax']);
    const out = await checkCookies(DOMAIN);

    expect(out.score).toBe(100);
    expect(out.moduleCoverage).toBe(1);
  });

  it('excludes known analytics cookies from the HttpOnly finding', async () => {
    stubCookies(['_ga=GA1.2.1; Path=/; Secure; SameSite=Lax']);
    const out = await checkCookies(DOMAIN);

    // Google Analytics reads its own cookie from JavaScript; reporting the
    // missing flag would be reporting the library working as designed.
    expect(out.findings.map((f) => f.title)).not.toContain(
      '1 cookie readable by page JavaScript',
    );
    expect(out.details.find((d) => d.label.startsWith('Analytics cookies'))?.value).toContain('_ga');
  });

  it('reports SameSite=None without Secure as inert rather than dangerous', async () => {
    stubCookies(['x=1; Path=/; SameSite=None']);
    const out = await checkCookies(DOMAIN);

    const finding = out.findings.find((f) => f.title === 'SameSite=None is set without Secure');
    expect(finding?.severity).toBe('low');
    expect(finding?.risk).toMatch(/No exposure follows, because the cookie is never stored/);
  });

  it('raises severity when a session-named cookie lacks Secure', async () => {
    stubCookies(['auth_token=abc; Path=/']);
    const out = await checkCookies(DOMAIN);

    const finding = out.findings.find((f) => f.title.includes('without the Secure attribute'));
    expect(finding?.severity).toBe('medium');
    expect(finding?.risk).toMatch(/session or authentication material/);
  });

  it('keeps severity low when no cookie looks like a session', async () => {
    stubCookies(['theme=dark; Path=/']);
    const out = await checkCookies(DOMAIN);

    const finding = out.findings.find((f) => f.title.includes('without the Secure attribute'));
    expect(finding?.severity).toBe('low');
  });

  it('always states that the pre-login response was the only thing inspected', async () => {
    stubCookies(['x=1; Secure; HttpOnly; SameSite=Lax']);
    const out = await checkCookies(DOMAIN);

    expect(out.findings.map((f) => f.title)).toContain(
      'Cookie review covers the pre-login response only',
    );
  });

  it('flags a cookie scoped wider than the host that set it', async () => {
    stubCookies(['x=1; Secure; HttpOnly; SameSite=Lax; Domain=.other.test']);
    const out = await checkCookies(DOMAIN);

    expect(out.findings.map((f) => f.title)).toContain(
      'Cookies are scoped to the whole domain rather than this host',
    );
  });

  it('throws rather than scoring when the site does not answer', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('connection refused');
    });

    await expect(checkCookies(DOMAIN)).rejects.toThrow(/did not respond/);
  });
});
