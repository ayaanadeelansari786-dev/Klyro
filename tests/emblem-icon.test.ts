import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { faviconSvg } from '@/lib/emblem';

/*
 * The brief asked for one mark across the nav, the hero and the favicon,
 * "rather than having a different simplified version in each place". The nav
 * and the hero already share `src/lib/emblem.ts` by construction — they import
 * it. The favicon cannot, because it has to exist as a static file for the
 * browser to fetch, so it is the one copy that can drift. This is what stops
 * it: regenerate from the module, compare to what is on disk.
 *
 * If this fails after an intentional change to the mark, the fix is to write
 * the generated string back to the file, not to loosen the assertion.
 */
describe('favicon', () => {
  it('matches the emblem geometry it was generated from', () => {
    const onDisk = readFileSync(join(process.cwd(), 'src/app/icon.svg'), 'utf8');
    expect(onDisk.replace(/\r\n/g, '\n')).toBe(faviconSvg());
  });
});
