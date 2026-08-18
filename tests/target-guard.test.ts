import { describe, expect, it } from 'vitest';

import { parseDomain } from '@/lib/domain';
import { classifyReservedAddress, screenName, screenTarget } from '@/lib/target';

/**
 * Klyro takes a host name from an anonymous visitor and makes server-side
 * requests to it. Everything in this file exists to stop that being a way to
 * reach something the visitor cannot reach themselves.
 */

describe('parseDomain', () => {
  it.each([
    ['127.0.0.1', 'IP address'],
    ['10.0.0.5', 'IP address'],
    ['169.254.169.254', 'IP address'],
    ['[::1]', 'IP address'],
  ])('rejects the IP literal %s', (input) => {
    expect(parseDomain(input).ok).toBe(false);
  });

  it('rejects a bare host name with no dot', () => {
    expect(parseDomain('localhost').ok).toBe(false);
  });

  it('strips credentials, port, path and scheme before validating', () => {
    expect(parseDomain('https://user:pw@Example.COM:8443/path?q=1#f')).toMatchObject({
      ok: true,
      domain: 'example.com',
    });
  });

  it('does not let userinfo smuggle a different host through', () => {
    // `evil.com@127.0.0.1` reaches 127.0.0.1 in a browser; the userinfo strip
    // has to leave the real host, which is then rejected as an IP literal.
    expect(parseDomain('http://evil.com@127.0.0.1/').ok).toBe(false);
  });

  it('refuses embedded newlines for the reason they were refused', () => {
    // This was rejected before, but with "Enter a domain name, not an IP
    // address" — the header line contains a colon, and the colon branch is the
    // IPv6 heuristic. The refusal was right and the explanation was nonsense.
    const verdict = parseDomain('example.com\r\nX-Injected: 1');

    expect(verdict.ok).toBe(false);
    expect(verdict.error).toMatch(/line breaks or control characters/);
    // Nothing from the hostile input is echoed back into the message.
    expect(verdict.domain).toBe('');
  });

  it('refuses a tab or space the same way', () => {
    expect(parseDomain('exa mple.com').error).toMatch(/spaces/);
    expect(parseDomain('example.com\tfoo').ok).toBe(false);
  });

  it('tells the truth about an internationalised name', () => {
    // München's domain is a valid domain. Saying it "does not look like a
    // valid domain" is false, and it hides the fact that the punycode form of
    // the same name works today.
    const verdict = parseDomain('münchen.de');

    expect(verdict.ok).toBe(false);
    expect(verdict.error).toMatch(/punycode/);
  });

  it('accepts the punycode form the message points at', () => {
    expect(parseDomain('xn--mnchen-3ya.de')).toMatchObject({
      ok: true,
      domain: 'xn--mnchen-3ya.de',
    });
  });
});

describe('screenName', () => {
  it.each([
    'printer.local',
    'app.localhost',
    'wiki.internal',
    'jira.corp',
    'nas.lan',
    'router.home.arpa',
    'foo.test',
    'anything.invalid',
    'site.example',
    'service.onion',
  ])('rejects the reserved suffix in %s', (host) => {
    const verdict = screenName(host);
    expect(verdict.ok).toBe(false);
    // The message names the offending suffix and says why it is refused. The
    // reason differs by class — a .corp name resolves privately, a .invalid
    // name never resolves at all — and one blanket sentence for all of them
    // was wrong for most.
    const suffix = host.split('.').slice(1).join('.');
    expect(verdict.error).toContain(`“${suffix}”`);
    expect(verdict.error).toMatch(/so (there is nothing|Klyro cannot|it never)/);
  });

  it('allows an ordinary public domain', () => {
    expect(screenName('example.com').ok).toBe(true);
    expect(screenName('sub.example.co.uk').ok).toBe(true);
  });

  it('does not reject a name that merely contains a reserved word', () => {
    // `internal-api.monzo.com` is a public host whose label contains
    // "internal". Only a whole reserved *suffix* is grounds for refusal.
    expect(screenName('internal-api.monzo.com').ok).toBe(true);
    expect(screenName('test-drive.example.com').ok).toBe(true);
    expect(screenName('local.example.com').ok).toBe(true);
  });
});

describe('classifyReservedAddress', () => {
  it.each([
    ['127.0.0.1', 'loopback'],
    ['10.1.2.3', 'private use'],
    ['172.16.0.1', 'private use'],
    ['172.31.255.255', 'private use'],
    ['192.168.1.1', 'private use'],
    ['169.254.169.254', 'link-local, including cloud metadata'],
    ['100.64.0.1', 'carrier-grade NAT'],
    ['0.0.0.0', 'this network'],
    ['224.0.0.1', 'multicast'],
    ['255.255.255.255', 'reserved'],
  ])('classifies %s as reserved', (address, label) => {
    expect(classifyReservedAddress(address)).toBe(label);
  });

  it.each([
    ['::1', 'loopback or unspecified'],
    ['fd00::1', 'unique local address'],
    ['fe80::1', 'link-local'],
    ['ff02::1', 'multicast'],
    ['2001:db8::1', 'documentation'],
  ])('classifies the IPv6 address %s as reserved', (address, label) => {
    expect(classifyReservedAddress(address)).toBe(label);
  });

  it('sees through an IPv4-mapped IPv6 address', () => {
    // ::ffff:127.0.0.1 reaches the loopback interface just as 127.0.0.1 does.
    expect(classifyReservedAddress('::ffff:127.0.0.1')).toBe('loopback');
    expect(classifyReservedAddress('::ffff:169.254.169.254')).toBe(
      'link-local, including cloud metadata',
    );
  });

  it.each(['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700::1111'])(
    'treats the routable address %s as allowed',
    (address) => {
      expect(classifyReservedAddress(address)).toBeNull();
    },
  );

  it('does not misclassify addresses adjacent to a reserved range', () => {
    expect(classifyReservedAddress('9.255.255.255')).toBeNull();
    expect(classifyReservedAddress('11.0.0.0')).toBeNull();
    expect(classifyReservedAddress('172.15.255.255')).toBeNull();
    expect(classifyReservedAddress('172.32.0.0')).toBeNull();
    expect(classifyReservedAddress('192.167.255.255')).toBeNull();
  });
});

/* ------------------------------------------------------------------ */

function resolver(answers: Record<string, { data: string; type: number }[]>) {
  return async (name: string, type: string) => ({
    resolved: true,
    answers: answers[`${name}|${type}`] ?? [],
  });
}

describe('screenTarget', () => {
  it('allows a domain resolving to a routable address', async () => {
    const verdict = await screenTarget(
      'example.com',
      resolver({ 'example.com|A': [{ data: '93.184.216.34', type: 1 }] }),
    );

    expect(verdict.ok).toBe(true);
    expect(verdict.addresses).toEqual(['93.184.216.34']);
  });

  it('refuses a public domain pointed at a private address', async () => {
    const verdict = await screenTarget(
      'internal.example.com',
      resolver({ 'internal.example.com|A': [{ data: '10.0.0.5', type: 1 }] }),
    );

    expect(verdict.ok).toBe(false);
    expect(verdict.error).toContain('private use');
  });

  it('refuses a domain pointed at the cloud metadata address', async () => {
    const verdict = await screenTarget(
      'metadata.example.com',
      resolver({ 'metadata.example.com|A': [{ data: '169.254.169.254', type: 1 }] }),
    );

    expect(verdict.ok).toBe(false);
    expect(verdict.error).toContain('cloud metadata');
  });

  it('refuses when only one of several addresses is reserved', async () => {
    // A mixed answer is the shape of an attempt to slip one past the check.
    const verdict = await screenTarget(
      'mixed.example.com',
      resolver({
        'mixed.example.com|A': [
          { data: '93.184.216.34', type: 1 },
          { data: '127.0.0.1', type: 1 },
        ],
      }),
    );

    expect(verdict.ok).toBe(false);
  });

  it('checks the IPv6 answer as well as the IPv4 one', async () => {
    const verdict = await screenTarget(
      'v6.example.com',
      resolver({
        'v6.example.com|A': [{ data: '93.184.216.34', type: 1 }],
        'v6.example.com|AAAA': [{ data: '::1', type: 28 }],
      }),
    );

    expect(verdict.ok).toBe(false);
  });

  it('rejects a reserved suffix before spending a DNS query', async () => {
    let queried = false;
    const verdict = await screenTarget('thing.internal', async () => {
      queried = true;
      return { resolved: true, answers: [] };
    });

    expect(verdict.ok).toBe(false);
    expect(queried).toBe(false);
  });

  it('fails open when nothing resolves', async () => {
    // A name that does not resolve cannot be connected to, so there is nothing
    // to protect against — and refusing would turn every transient resolver
    // failure into a rejected scan. The connect-time guard covers the gap.
    const verdict = await screenTarget('nothing.example.com', async () => ({
      resolved: false,
      answers: [],
    }));

    expect(verdict.ok).toBe(true);
  });
});
