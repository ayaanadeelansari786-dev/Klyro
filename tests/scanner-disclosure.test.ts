import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { PROBE_MANIFEST } from '@/lib/checks/exposed-paths';
import { USER_AGENT } from '@/lib/checks/util';
import { SCANNER_INFO_URL } from '@/lib/site';

/**
 * Klyro puts a URL in its User-Agent so that an operator who finds unfamiliar
 * traffic in their logs can find out what it was. A `+URL` pointing at a 404
 * is worse than no URL — it looks like a scanner trying to appear legitimate.
 *
 * These tests exist because that URL was broken once already. The page it
 * points at must exist, and the path list it publishes must be the list the
 * scanner actually requests rather than a copy that drifts.
 */

const PAGE = join(process.cwd(), 'src', 'app', 'scanner', 'page.tsx');

describe('scanner User-Agent', () => {
  it('advertises a URL', () => {
    expect(USER_AGENT).toContain(`+${SCANNER_INFO_URL}`);
  });

  it('advertises a URL that this application actually serves', () => {
    const path = new URL(SCANNER_INFO_URL).pathname;
    expect(path).toBe('/scanner');
    expect(existsSync(PAGE), `${SCANNER_INFO_URL} must be served by ${PAGE}`).toBe(true);
  });

  it('follows the deployment rather than naming a fixed host', () => {
    // The constant is read from NEXT_PUBLIC_SITE_URL; a hardcoded origin in
    // the User-Agent would 404 for anyone hosting Klyro anywhere else.
    const source = readFileSync(join(process.cwd(), 'src', 'lib', 'checks', 'util.ts'), 'utf8');
    expect(source).not.toMatch(/USER_AGENT\s*=\s*['"`][^`]*https:\/\/klyro/);
  });
});

describe('published probe list', () => {
  it('exposes every probed path', () => {
    expect(PROBE_MANIFEST.length).toBeGreaterThan(0);
    for (const probe of PROBE_MANIFEST) {
      expect(probe.path.startsWith('/'), `${probe.path} should be root-relative`).toBe(true);
      expect(probe.label.length).toBeGreaterThan(0);
      expect(probe.expected.length).toBeGreaterThan(0);
    }
  });

  it('is rendered from the manifest, not retyped into the page', () => {
    const source = readFileSync(PAGE, 'utf8');
    expect(source).toContain('PROBE_MANIFEST');
    // A path written directly into the page is the drift this guards against.
    expect(source).not.toMatch(/['"]\/\.env['"]/);
  });

  it('discloses the one request that is not a GET or HEAD', () => {
    const source = readFileSync(PAGE, 'utf8');
    expect(source).toContain('POST');
    expect(source).toContain('__schema');
  });

  /*
   * Klyro used to send a single HEAD to each discovered host and read nothing
   * but the status line. It now sends a GET and reads up to 8KB of the body to
   * identify the software. That is a change in what the scanner *does*, and an
   * operator reading this page after finding the traffic in their log is
   * entitled to see it described accurately rather than as it used to be.
   */
  it('discloses that response bodies are read on discovered hosts', () => {
    const source = readFileSync(PAGE, 'utf8');
    expect(source).toMatch(/8KB/);
    expect(source).toMatch(/one GET to the host root/i);
    expect(source).toMatch(/Redirects are not followed/i);
  });

  it('states that cookie values are discarded and only names kept', () => {
    const source = readFileSync(PAGE, 'utf8');
    expect(source).toMatch(/only names are kept|only the name is kept/i);
  });

  it('does not describe the host probe as a HEAD request any more', () => {
    const source = readFileSync(PAGE, 'utf8');
    // The old wording. If host probing ever reverts to HEAD this should be
    // updated deliberately rather than left to drift.
    expect(source).not.toMatch(/receive a single HEAD request/i);
  });

  it('separates reaching a page from bypassing its authentication', () => {
    const source = readFileSync(PAGE, 'utf8');
    expect(source).toMatch(/not treated as bypassing/i);
  });

  it('gives an operator a way to block the scanner', () => {
    const source = readFileSync(PAGE, 'utf8');
    expect(source).toContain('KlyroExposureScanner');
    expect(source).toMatch(/nginx/i);
  });
});
