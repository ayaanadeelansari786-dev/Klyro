import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { organisationPortfolio, rankPortfolio, type PortfolioPeer } from '@/lib/dataset/portfolio';

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

/**
 * A Supabase client stub that answers exactly the two queries
 * `organisationPortfolio` makes and nothing else.
 *
 * Hand-written rather than mocked from the real client: the point of these
 * tests is that the industry split happens over one unfiltered fetch, so the
 * stub records whether `.eq('industry', ...)` was ever called. A generated
 * mock would answer whatever it was asked and prove nothing about that.
 */
function stubClient(rows: Array<Record<string, unknown>>, orgName = 'Acme') {
  const filters: string[] = [];

  const builder = {
    select: () => builder,
    eq: (column: string) => {
      filters.push(column);
      return builder;
    },
    order: () => builder,
    limit: () => Promise.resolve({ data: rows, error: null }),
    maybeSingle: () => Promise.resolve({ data: { name: orgName }, error: null }),
  };

  return {
    client: { from: () => builder } as never,
    filters,
  };
}

const row = (domain: string, industry: string, score: number, scannedAt: string) => ({
  domain,
  industry,
  composite_score: score,
  scanned_at: scannedAt,
  category_scores: null,
});

describe('organisationPortfolio: two sets from one fetch', () => {
  const rows = [
    row('alpha.ae', 'Technology', 90, '2026-03-01T00:00:00.000Z'),
    row('beta.ae', 'Technology', 50, '2026-03-01T00:00:00.000Z'),
    row('gamma.ae', 'Banking & Finance', 80, '2026-03-01T00:00:00.000Z'),
    row('delta.ae', 'Retail & E-commerce', 30, '2026-03-01T00:00:00.000Z'),
  ];

  it('ranks within the industry and across the whole portfolio', async () => {
    const { client } = stubClient(rows);
    const portfolio = await organisationPortfolio(client, {
      orgId: 'org-1',
      industry: 'Technology',
      domain: 'target.ae',
      score: 70,
    });

    // Two Technology peers, one above and one below.
    expect(portfolio?.sameIndustry.total).toBe(3);
    expect(portfolio?.sameIndustry.rank).toBe(2);

    // All four peers, two above (90, 80) and two below (50, 30).
    expect(portfolio?.everything.total).toBe(5);
    expect(portfolio?.everything.rank).toBe(3);
  });

  it('never filters the fetch by industry — the split is in memory', async () => {
    // Two round trips for two views of the same rows is the thing this
    // avoids, and it is invisible in the output, so it is asserted here.
    const { client, filters } = stubClient(rows);
    await organisationPortfolio(client, {
      orgId: 'org-1',
      industry: 'Technology',
      domain: 'target.ae',
      score: 70,
    });
    expect(filters).toContain('owner_org_id');
    expect(filters).not.toContain('industry');
  });

  it('counts the industries the wider set actually spans', async () => {
    const { client } = stubClient(rows);
    const portfolio = await organisationPortfolio(client, {
      orgId: 'org-1',
      industry: 'Technology',
      domain: 'target.ae',
      score: 70,
    });
    // Technology, Banking & Finance, Retail & E-commerce.
    expect(portfolio?.industriesCovered).toBe(3);
  });

  it('gives the first vendor in an industry a wider comparison, not none', async () => {
    // The case the second set exists for: nothing to rank against in the
    // target's own industry, but eight other vendors on file.
    const { client } = stubClient([
      row('gamma.ae', 'Banking & Finance', 80, '2026-03-01T00:00:00.000Z'),
      row('delta.ae', 'Retail & E-commerce', 30, '2026-03-01T00:00:00.000Z'),
    ]);
    const portfolio = await organisationPortfolio(client, {
      orgId: 'org-1',
      industry: 'Technology',
      domain: 'target.ae',
      score: 70,
    });

    expect(portfolio?.sameIndustry.rank).toBeNull();
    expect(portfolio?.everything.rank).toBe(2);
    expect(portfolio?.everything.total).toBe(3);
  });

  it('counts a re-scanned vendor once, at its most recent score', async () => {
    const { client } = stubClient([
      row('alpha.ae', 'Technology', 90, '2026-03-01T00:00:00.000Z'),
      row('alpha.ae', 'Technology', 20, '2026-01-01T00:00:00.000Z'),
    ]);
    const portfolio = await organisationPortfolio(client, {
      orgId: 'org-1',
      industry: 'Technology',
      domain: 'target.ae',
      score: 70,
    });

    expect(portfolio?.everything.total).toBe(2);
    expect(portfolio?.everything.peers.find((p) => p.domain === 'alpha.ae')?.score).toBe(90);
  });
});

describe('deleting an organisation', () => {
  const route = readFileSync(
    join(process.cwd(), 'src', 'app', 'api', 'org', '[orgId]', 'route.ts'),
    'utf8',
  );
  const panel = readFileSync(
    join(process.cwd(), 'src', 'components', 'DeleteOrgPanel.tsx'),
    'utf8',
  );

  it('leaves the owner check to the database rather than re-testing it', () => {
    // The DELETE policy on `organisations` is `app.has_org_role(id, 'owner')`.
    // A TypeScript role test beside it is a second copy of the rule, free to
    // disagree with the first — the same reasoning the PATCH handler follows.
    expect(route).not.toMatch(/roleAtLeast|roleInOrg/);
    expect(route).toMatch(/from\(['"]organisations['"]\)\s*\.delete\(\)/);
  });

  it('refuses to delete unless the caller names the organisation', () => {
    expect(route).toMatch(/confirm !== name/);
  });

  it('tells the reader the assessments go too', () => {
    // `assessments.owner_org_id` is `on delete cascade`, so this destroys the
    // organisation's whole history for every member at once. An interface
    // that describes it as removing an organisation is not describing it.
    expect(panel).toMatch(/assessmentCount/);
    expect(panel).toMatch(/cannot be undone|no recovery/i);
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
