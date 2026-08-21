import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CATEGORY_ORDER } from '@/lib/constants';

/**
 * The methodology page describes how the software works, to readers who are
 * deciding whether to believe its output. That makes it the single worst place
 * in the tree for a claim to go stale — a scanner disclosure that drifts
 * misleads an operator about one request, but a methodology page that drifts
 * misrepresents the product to the person auditing it.
 *
 * So the structural parts are read from the code rather than retyped, and this
 * pins that arrangement.
 */

const PAGE = readFileSync(join(process.cwd(), 'src', 'app', 'methodology', 'page.tsx'), 'utf8');
const SCORING = readFileSync(join(process.cwd(), 'src', 'lib', 'scoring.ts'), 'utf8');

describe('the module tables', () => {
  it('are rendered from CATEGORY_ORDER, not typed out', () => {
    expect(PAGE).toContain('CATEGORY_ORDER.map');
    expect(PAGE).toContain('CATEGORY_WEIGHTS[key]');
    expect(PAGE).toContain('CATEGORY_LABELS[key]');
  });

  it('names a source for every module, and no module that does not exist', () => {
    // `SOURCES` is typed `Record<CategoryKey, …>`, so a missing key is a
    // compile error — but an *extra* key for a withdrawn module would compile
    // until someone read the page. This catches that.
    const keys = [...PAGE.matchAll(/^ {2}(\w+): \{$/gm)].map((m) => m[1]);
    expect(keys.sort()).toEqual([...CATEGORY_ORDER].sort());
  });

  it('does not claim corroboration for modules that read one source', () => {
    // The value of the column is that it is not a tick everywhere. If every
    // row said yes, the column would be decoration.
    const single = [...PAGE.matchAll(/confirmed:\s*'([^']*)'/g)].map((m) => m[1]);
    expect(single.length).toBe(CATEGORY_ORDER.length);
    expect(single.filter((s) => s.startsWith('Single observation')).length).toBeGreaterThan(0);
    expect(single.filter((s) => s.startsWith('Yes'))).not.toHaveLength(0);
  });
});

describe('the arithmetic it describes', () => {
  it('quotes the ranking formula the code actually applies', () => {
    expect(PAGE).toContain('severity × confidence × exposure');
    expect(SCORING).toContain('severity * confidence * exposure');
  });

  it('quotes the severity weights the code actually uses', () => {
    // Printed as prose on the page; asserted here against the table.
    expect(PAGE).toContain('critical 100, high 70, medium 45, low 20');
    for (const [level, value] of [
      ['critical', '100'],
      ['high', '70'],
      ['medium', '45'],
      ['low', '20'],
    ]) {
      expect(SCORING).toMatch(new RegExp(`${level}:\\s*${value},`));
    }
  });

  it('quotes the confidence multipliers the code actually uses', () => {
    expect(PAGE).toContain('×0.75');
    expect(PAGE).toContain('×0.5');
    expect(SCORING).toMatch(/medium:\s*0\.75/);
    expect(SCORING).toMatch(/low:\s*0\.5/);
  });

  it('states the renormalisation rule rather than implying modules score zero', () => {
    expect(PAGE).toContain('renormalised');
    expect(SCORING).toContain('totalWeight');
  });
});

describe('what it refuses to claim', () => {
  it.each([
    'network sensor',
    'darknet',
    'compromised-host detection',
    'breach-outcome correlation',
    'one-time snapshot',
  ])('disclaims %s', (phrase) => {
    expect(PAGE.toLowerCase()).toContain(phrase.toLowerCase());
  });

  it('is reachable from the footer and the scanner disclosure', () => {
    const chrome = readFileSync(join(process.cwd(), 'src', 'components', 'Chrome.tsx'), 'utf8');
    const scanner = readFileSync(
      join(process.cwd(), 'src', 'app', 'scanner', 'page.tsx'),
      'utf8',
    );
    expect(chrome).toContain('href="/methodology"');
    expect(scanner).toContain('href="/methodology"');
  });

  it('records corrections, not only confirmations', () => {
    // A validation table containing only successes is a marketing page.
    const outcomes = [...PAGE.matchAll(/outcome: '(match|fixed)'/g)].map((m) => m[1]);
    expect(outcomes.filter((o) => o === 'fixed').length).toBeGreaterThan(0);
    expect(outcomes.filter((o) => o === 'match').length).toBeGreaterThan(0);
  });
});
