import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The three legal documents are static files under `public/legal/`, served
 * verbatim by Next.js rather than rendered by a page component — which means
 * nothing in the type system catches a renamed file or a stale link the way
 * it would for an app route. This is the same failure mode `scanner-disclosure
 * .test.ts` guards against for the scanner's own published URL, applied here.
 */

const LEGAL_DIR = join(process.cwd(), 'public', 'legal');

const DOCS = [
  'TERMS_OF_SERVICE.md',
  'PRIVACY_POLICY.md',
  'ACCEPTABLE_USE_POLICY.md',
] as const;

describe('the legal documents exist where they are linked from', () => {
  it.each(DOCS)('public/legal/%s exists', (name) => {
    expect(existsSync(join(LEGAL_DIR, name))).toBe(true);
  });

  it.each(DOCS)('%s is non-empty and carries the review-status banner', (name) => {
    const text = readFileSync(join(LEGAL_DIR, name), 'utf8');
    expect(text.length).toBeGreaterThan(500);
    // These are explicitly starting drafts, not documents to publish as-is —
    // the banner is what stops that distinction getting lost on the way to a
    // live URL.
    expect(text).toMatch(/draft for (internal and )?legal review/i);
  });

  it('the footer links to all three', () => {
    const chrome = readFileSync(join(process.cwd(), 'src', 'components', 'Chrome.tsx'), 'utf8');
    for (const name of DOCS) expect(chrome).toContain(`/legal/${name}`);
  });

  it('the methodology page links to all three', () => {
    const page = readFileSync(
      join(process.cwd(), 'src', 'app', 'methodology', 'page.tsx'),
      'utf8',
    );
    for (const name of DOCS) expect(page).toContain(`/legal/${name}`);
  });

  it('each document cross-links the other two by their served path', () => {
    // The Terms reference the AUP and Privacy Policy, and vice versa. If a
    // file gets renamed, these internal links are exactly the kind of thing
    // that keeps working in an editor and breaks silently in the browser.
    for (const name of DOCS) {
      const text = readFileSync(join(LEGAL_DIR, name), 'utf8');
      for (const other of DOCS) {
        if (other === name) continue;
        expect(text, `${name} should link to ${other}`).toContain(`/legal/${other}`);
      }
    }
  });
});
