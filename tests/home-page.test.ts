import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CATEGORY_ORDER } from '@/lib/constants';
import { ratingFor, riskLevelFor } from '@/lib/scoring';

/**
 * The landing page makes claims about the product, and every one of them is
 * copied from somewhere else in the tree — the check modules, the scanner
 * disclosure, the scoring functions. Copies drift silently, and these ones
 * drift in the worst possible place: a prospective customer reading a promise
 * the software stopped keeping.
 *
 * So the copies are pinned. If someone rewords the SPF finding, retunes a risk
 * band, or adds a twelfth check, the test that fails is here rather than the
 * conversation that goes wrong six weeks later.
 */

const src = (...parts: string[]) => readFileSync(join(process.cwd(), 'src', ...parts), 'utf8');

/**
 * Source with its comments removed.
 *
 * The assertions below about what the page *says* have to read what the page
 * renders, not what the file explains. This tree comments heavily, and several
 * of those comments quote the very strings being banned — the note above
 * `ml-[30px]`'s replacement names it, and the one above `ScoreBands` quotes
 * "80+ is low risk" as the thing not to write. Matching against raw source
 * fails on its own documentation.
 */
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

const HOME = [
  src('app', 'page.tsx'),
  src('components', 'home', 'Hero.tsx'),
  src('components', 'home', 'HowItWorks.tsx'),
  src('components', 'home', 'FindingAnatomy.tsx'),
  src('components', 'home', 'ScoreBands.tsx'),
  src('components', 'home', 'Boundary.tsx'),
  src('components', 'home', 'SignalBand.tsx'),
  src('components', 'home', 'ClosingCTA.tsx'),
  src('components', 'VaultDial.tsx'),
].join('\n');

describe('the example finding', () => {
  const emailSecurity = src('lib', 'checks', 'email-security.ts');
  const anatomy = src('components', 'home', 'FindingAnatomy.tsx');

  /*
   * The page shows a finding as the product would actually print it. The four
   * fields are quoted from the module, with only the domain substituted, so
   * that "this is what you get" is a checkable statement rather than a claim.
   */
  const quoted = [
    'The domain does not declare which servers are authorised to send mail using it in the envelope sender.',
    'SPF is one of the two mechanisms DMARC can authenticate against.',
    'Publish an SPF record listing the legitimate sending services and ending in',
    'SPF authenticates the envelope sender, not the From address a recipient sees.',
  ];

  it.each(quoted)('reproduces module copy: %s', (fragment) => {
    expect(anatomy).toContain(fragment);
    expect(emailSecurity).toContain(fragment);
  });

  it('keeps the title the module gives the finding', () => {
    expect(anatomy).toContain('No SPF record is published');
    expect(emailSecurity).toContain("title: 'No SPF record is published'");
  });

  it('carries the severity the module assigns it', () => {
    // The module pairs that title with `severity: 'high'`. The page prints
    // "High"; a page showing a critical badge over a high finding would be
    // overstating the product's own output.
    const block = emailSecurity.slice(emailSecurity.indexOf('No SPF record is published'));
    expect(block.slice(0, 200)).toContain("severity: 'high'");
    expect(anatomy).toMatch(/>\s*High\s*</);
  });

  it('uses a reserved documentation domain, not a real one', () => {
    // Printing a real company's mail posture on a marketing page, next to a
    // "High" badge, is a thing to be certain of never doing by accident.
    expect(anatomy).toContain("EXAMPLE_DOMAIN = 'example.com'");
  });

  it('labels the example as an example', () => {
    expect(anatomy).toContain('Example output');
  });
});

describe('the boundary claims', () => {
  const disclosure = src('app', 'scanner', 'page.tsx');
  const boundary = src('components', 'home', 'Boundary.tsx');

  /*
   * `/scanner` is the authoritative statement of what the scanner does. The
   * landing page must not promise a restraint the disclosure does not also
   * claim — the disclosure is the version an operator will hold Klyro to.
   */
  it.each([
    ['No login is attempted', 'no password is guessed'],
    ['No payloads', 'Nothing is injected'],
    ['port scanning', 'No port scanning'],
    ['state', 'Every request is a read'],
    ['enumeration', 'directories are not brute forced'],
  ])('%s is claimed on both pages', (_topic, fragment) => {
    // Case-insensitive: the disclosure sets these mid-sentence and the landing
    // page opens a sentence with them. Same claim, different capital.
    expect(boundary.toLowerCase()).toContain(fragment.toLowerCase());
    expect(disclosure.toLowerCase()).toContain(fragment.toLowerCase());
  });

  it('links to the authoritative disclosure', () => {
    expect(boundary).toContain('href="/scanner"');
  });

});

describe('numbers the page states', () => {
  it('never hardcodes the check count', () => {
    // It read "10" on the live site for a while after the eleventh module
    // landed, and this caught "the eleven checks" sitting in the score-band
    // copy on the first run. Nothing rendered may spell the number out.
    expect(stripComments(HOME)).not.toMatch(/\b(?:ten|eleven|twelve)\b/i);
    expect(HOME).toContain('CATEGORY_ORDER.length');
  });

  it('derives the risk bands rather than restating them', () => {
    const bands = stripComments(src('components', 'home', 'ScoreBands.tsx'));
    expect(bands).toContain('riskLevelFor');
    expect(bands).toContain('ratingFor');
    // No literal threshold, and no band name typed out beside one.
    expect(bands).not.toMatch(/\b(?:80|60)\s*(?:\+|or above|and above)/);
    expect(bands).not.toContain('Moderate Risk');
  });

  it('finds the band edges the scoring functions actually use', () => {
    // The same derivation the component performs. If a threshold moves, the
    // page's strip and legend move with it.
    const edges: number[] = [];
    for (let score = 1; score <= 100; score += 1) {
      if (riskLevelFor(score) !== riskLevelFor(score - 1)) edges.push(score);
    }
    expect(edges).toEqual([60, 80]);
    expect(edges.map(riskLevelFor)).toEqual(['Moderate Risk', 'Low Risk']);
    expect(ratingFor(edges[0])).toBe('Fair');
  });

  it('quotes the observed scan duration, not an aspirational one', () => {
    expect(HOME).toContain('20–45');
  });
});

describe('the signal band', () => {
  const band = src('components', 'home', 'SignalBand.tsx');
  const checks = ['dns', 'email-security', 'ssl', 'subdomains', 'headers', 'whois', 'cookies', 'cors', 'robots-sitemap']
    .map((name) => src('lib', 'checks', `${name}.ts`))
    .join('\n');

  /*
   * A marquee is decoration; a marquee of things the product does not read
   * is a lie set in a nice font. Each entry has to be traceable to a module.
   */
  it.each([
    'v=spf1',
    '_dmarc',
    'DKIM',
    'DNSSEC',
    'CAA',
    'crt.sh',
    'rdap',
    'robots.txt',
    'security.txt',
    'sitemap.xml',
    'SameSite',
    'Access-Control-Allow-Origin',
    'strict-transport-security',
    'content-security-policy',
  ])('%s is read by a check module', (signal) => {
    expect(checks.toLowerCase()).toContain(signal.toLowerCase());
  });

  it('lists nothing that no module reads', () => {
    const listed = [...band.matchAll(/\['[^']+', '([^']+)'\]/g)].map((m) => m[1]);
    expect(listed.length).toBeGreaterThan(10);

    const unknown = listed.filter((signal) => {
      // Prose entries ("certificate chain", "key length") describe a reading
      // rather than naming a token, so they are matched on their head noun.
      // `=` is kept: `v=spf1` is the token the modules match on, and stripping
      // it leaves `vspf1`, which appears nowhere and fails the entry wrongly.
      const head = signal.split(' ')[0].replace(/[^\w.=-]/g, '');
      return !checks.toLowerCase().includes(head.toLowerCase());
    });
    expect(unknown).toEqual([]);
  });
});

describe('the checks ledger', () => {
  it('renders one row per category, from the single source of truth', () => {
    const dial = src('components', 'VaultDial.tsx');
    expect(dial).toContain('const FACES = CATEGORY_ORDER');
    expect(dial).toContain('{FACES.length} checks');
    expect(CATEGORY_ORDER.length).toBeGreaterThan(0);
  });

  it('aligns the description to the title by grid, not by a guessed offset', () => {
    // `ml-[30px]` was an estimate of a mono numeral's rendered width plus its
    // gap. It only agreed with the title's left edge by coincidence.
    const dial = src('components', 'VaultDial.tsx');
    expect(stripComments(dial)).not.toContain('ml-[30px]');
    expect(dial).toContain('col-start-2');
  });
});

describe('motion', () => {
  const motion = src('components', 'motion.tsx');
  const css = readFileSync(join(process.cwd(), 'src', 'app', 'globals.css'), 'utf8');

  it('hides revealed content only where scripting can bring it back', () => {
    // The hidden state is gated on `.js`, which the pre-paint boot script
    // sets. Without that gate, scripting off means a column of blank sections.
    expect(css).toContain('.js [data-reveal]');
    expect(css).not.toMatch(/^\s*\[data-reveal\]\s*\{/m);
    expect(src('components', 'ThemeToggle.tsx')).toContain("classList.add('js')");
  });

  it('restores everything under reduced motion', () => {
    const reduced = css.slice(css.lastIndexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toContain('[data-reveal]');
    expect(reduced).toContain('opacity: 1');
  });

  it('yields to reduced motion in the handlers, not only in the stylesheet', () => {
    // The sheen and the parallax write inline styles, which no media query can
    // undo. They have to check for themselves.
    const guards = motion.match(/prefers-reduced-motion: reduce/g) ?? [];
    expect(guards.length).toBeGreaterThanOrEqual(2);
  });

  it('adds no animation runtime to the dependency tree', () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    expect(deps.filter((d) => /gsap|framer-motion|animejs|lottie/.test(d))).toEqual([]);
  });
});
