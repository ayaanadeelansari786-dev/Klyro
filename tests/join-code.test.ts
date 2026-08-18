import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  formatJoinCode,
  generateJoinCode,
  hashJoinCode,
  hashesMatch,
  looksLikeJoinCode,
  normaliseJoinCode,
} from '@/lib/auth/joinCode';

const PEPPER = 'test-pepper-value-at-least-32-characters-long';

beforeEach(() => {
  process.env.KLYRO_JOIN_CODE_PEPPER = PEPPER;
});

afterEach(() => {
  process.env.KLYRO_JOIN_CODE_PEPPER = PEPPER;
});

describe('generating a code', () => {
  it('never returns the same code twice', () => {
    const seen = new Set(Array.from({ length: 500 }, () => generateJoinCode().code));
    expect(seen.size).toBe(500);
  });

  it('avoids the characters people transcribe wrongly', () => {
    // O/0 and I/1/L are the pairs that turn a correct code into a support
    // ticket. Checked across many codes because the failure is probabilistic.
    for (let i = 0; i < 200; i += 1) {
      expect(normaliseJoinCode(generateJoinCode().code)).not.toMatch(/[O0IL1]/);
    }
  });

  it('returns a hint short enough to be useless on its own', () => {
    const { code, hint } = generateJoinCode();
    expect(hint).toHaveLength(4);
    expect(normaliseJoinCode(code).endsWith(hint)).toBe(true);
  });

  it('returns a hash that is not the code', () => {
    const { code, hash } = generateJoinCode();
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(normaliseJoinCode(code));
  });
});

describe('normalising input', () => {
  it('accepts the code however the user pastes it', () => {
    const { code } = generateJoinCode();
    const body = normaliseJoinCode(code);

    for (const variant of [
      code,
      code.toLowerCase(),
      code.replace(/-/g, ''),
      code.replace(/-/g, ' '),
      `  ${code}  `,
      body,
    ]) {
      expect(normaliseJoinCode(variant)).toBe(body);
      expect(hashJoinCode(variant)).toBe(hashJoinCode(code));
    }
  });

  it('formats consistently for display', () => {
    const { code } = generateJoinCode();
    expect(formatJoinCode(normaliseJoinCode(code))).toBe(code);
    expect(code).toMatch(/^KLY-[A-Z2-9]{5}-[A-Z2-9]{5}$/);
  });

  it('rejects strings that cannot be codes before touching the database', () => {
    expect(looksLikeJoinCode('')).toBe(false);
    expect(looksLikeJoinCode('KLY-SHORT')).toBe(false);
    expect(looksLikeJoinCode("KLY-ABCDE-'; drop table--")).toBe(false);
    // Contains the excluded characters, so it was never a code this mints.
    expect(looksLikeJoinCode('KLY-OOOOO-11111')).toBe(false);

    expect(looksLikeJoinCode(generateJoinCode().code)).toBe(true);
  });
});

describe('the pepper', () => {
  it('changes the hash, so codes are not portable between deployments', () => {
    const { code } = generateJoinCode();
    const here = hashJoinCode(code);

    process.env.KLYRO_JOIN_CODE_PEPPER = 'a-different-pepper-of-at-least-32-chars!!';
    const there = hashJoinCode(code);

    expect(there).not.toBe(here);
  });

  it('refuses to hash rather than falling back to a default', () => {
    // A default pepper would mean every installation shares a hash space, and
    // a code minted in one would open an organisation in another. Failing
    // loudly is the only safe behaviour.
    delete process.env.KLYRO_JOIN_CODE_PEPPER;
    expect(() => hashJoinCode('KLY-ABCDE-FGHJK')).toThrow(/KLYRO_JOIN_CODE_PEPPER/);

    process.env.KLYRO_JOIN_CODE_PEPPER = 'too-short';
    expect(() => hashJoinCode('KLY-ABCDE-FGHJK')).toThrow(/too short/);
  });
});

describe('comparing hashes', () => {
  it('matches a hash with itself and nothing else', () => {
    const a = hashJoinCode(generateJoinCode().code);
    const b = hashJoinCode(generateJoinCode().code);

    expect(hashesMatch(a, a)).toBe(true);
    expect(hashesMatch(a, b)).toBe(false);
    expect(hashesMatch(a, a.slice(0, -1))).toBe(false);
  });
});
