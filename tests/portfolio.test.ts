import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { rankPortfolio, type PortfolioPeer } from '@/lib/dataset/portfolio';

/**
 * The organisation portfolio ranking.
 *
 * This is the one place in the product that ranks a vendor against a pool
 * small enough to be misleading, so the rules it follows are pinned here
 * rather than left to be re-derived: ties share a place, a portfolio of one
 * is not a ranking, and the whole thing must never present itself as a
 * percentile — the shared benchmark holds a thirty-domain floor for exactly
 * that reason and this must not quietly route around it.
 */

const peer = (domain: string, score: number): PortfolioPeer => ({
  domain,
  score,
  scannedAt: '2026-01-01T00:00:00.000Z',
});

describe('rankPortfolio', () => {
  it('counts only domains scoring strictly higher', () => {
    const result = rankPortfolio(
      [peer('a.com', 90), peer('b.com', 80), peer('c.com', 40)],
      'target.com',
      70,
    );
    expect(result.rank).toBe(3);
    expect(result.total).toBe(4);
  });

  it('lets ties share a place rather than breaking them alphabetically', () => {
    // Two peers on the same score as the target: none of them scored higher,
    // so the target is first — and would be whatever its domain was called.
    const tied = rankPortfolio([peer('a.com', 74), peer('z.com', 74)], 'target.com', 74);
    expect(tied.rank).toBe(1);

    const renamed = rankPortfolio([peer('a.com', 74), peer('z.com', 74)], 'aaa.com', 74);
    expect(renamed.rank).toBe(1);
  });

  it('returns null rather than "first of one" for an empty portfolio', () => {
    const result = rankPortfolio([], 'target.com', 82);
    expect(result.rank).toBeNull();
    expect(result.total).toBe(1);
  });

  it('never counts the target twice when it is already in the pool', () => {
    // The stored assessment of this same domain must not become its own peer,
    // or a re-scan ranks the vendor against itself.
    const result = rankPortfolio(
      [peer('target.com', 55), peer('other.com', 90)],
      'target.com',
      60,
    );
    expect(result.total).toBe(2);
    expect(result.peers.filter((p) => p.domain === 'target.com')).toHaveLength(1);
    expect(result.rank).toBe(2);
  });

  it('matches the target case-insensitively', () => {
    const result = rankPortfolio([peer('target.com', 55)], 'TARGET.COM', 60);
    expect(result.total).toBe(1);
    expect(result.rank).toBeNull();
  });

  it('marks exactly one row as the target, sorted best first', () => {
    const result = rankPortfolio([peer('a.com', 30), peer('b.com', 95)], 'target.com', 70);
    expect(result.peers.map((p) => p.score)).toEqual([95, 70, 30]);
    expect(result.peers.filter((p) => p.isTarget)).toHaveLength(1);
    expect(result.peers.find((p) => p.isTarget)?.domain).toBe('target.com');
  });
});

describe('what the portfolio refuses to claim', () => {
  const panel = readFileSync(
    join(process.cwd(), 'src', 'components', 'OrgPortfolio.tsx'),
    'utf8',
  );
  const lib = readFileSync(join(process.cwd(), 'src', 'lib', 'dataset', 'portfolio.ts'), 'utf8');

  it('never presents the position as a percentile', () => {
    // A percentile off seven domains is the overclaim MIN_BENCHMARK_SAMPLES
    // exists to prevent. The panel states a position in a named set instead.
    expect(panel).not.toMatch(/percentile(?!\b[^.]*\bnot\b)/i);
    expect(lib).not.toMatch(/percentileRank/);
  });

  it('says whose set the position is computed within', () => {
    expect(panel).toContain('orgName');
    expect(panel).toContain('has assessed');
  });

  it('reads through the caller’s own client so the policy decides', () => {
    // A service client here would return every organisation's portfolio to
    // anyone who guessed an id. Asserted against the *imports* rather than the
    // text — this file's own header explains why it does not use one, and a
    // substring check matches that explanation.
    expect(lib).not.toMatch(/from ['"][^'"]*supabase\/service['"]/);
    // It takes a client rather than choosing one, the way `history.ts` does.
    expect(lib).toMatch(/supabase: SupabaseClient/);
  });
});
