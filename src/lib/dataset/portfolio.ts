/**
 * An organisation's own vendors, as the thing to compare a new one against.
 *
 * Deliberately not a second benchmark. The shared corpus in `benchmark.ts`
 * refuses to publish a percentile under `MIN_BENCHMARK_SAMPLES` domains,
 * because a percentile is a claim about an industry and thirty is roughly
 * where that claim stops being noise. An organisation will have assessed
 * three vendors, or eight. Running the same arithmetic over eight and calling
 * the result a percentile would be exactly the overclaim that threshold
 * exists to prevent.
 *
 * So this computes something different and smaller, which happens to be more
 * useful: a position within a set the reader assembled themselves. "Third of
 * seven Technology vendors your organisation has assessed" is not a
 * statistical statement about the technology industry — it is a fact about
 * seven specific domains, all of which are named, and it is true at any pool
 * size. There is no threshold because there is nothing being inferred.
 *
 * Every peer's score is returned alongside the rank rather than only a
 * derived average, for the same reason the dashboard shows evidence under a
 * finding: the reader can see the set the position was computed from and
 * disagree with it.
 *
 * Reads through the caller's own client. Row level security on `assessments`
 * already restricts rows to the caller's own and to organisations they belong
 * to, so a non-member asking about an organisation's portfolio gets an empty
 * one rather than an error — and passing a service client here would silently
 * disable that.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { latestPerDomain } from '../benchmark';

export interface PortfolioPeer {
  domain: string;
  score: number;
  scannedAt: string;
  /** True for the domain currently on screen. */
  isTarget?: boolean;
}

export interface PortfolioComparison {
  orgName: string;
  industry: string;
  /** Every distinct domain in this industry, including the target, best first. */
  peers: PortfolioPeer[];
  /**
   * The target's position, 1-based, counting domains that scored strictly
   * higher. Null when the organisation has assessed nothing else here, which
   * is a different statement from "ranked first of one" and is rendered as
   * one.
   */
  rank: number | null;
  /** How many distinct domains the position is out of, target included. */
  total: number;
}

/**
 * The ranking itself, as arithmetic over a list.
 *
 * Separated from the query so the rule can be tested without a database.
 * Two decisions are encoded here and both are worth stating:
 *
 * Position counts domains scoring *strictly* higher, so ties share a place —
 * two vendors on 74 are both second, and neither is told it beat the other on
 * the strength of an alphabetical accident.
 *
 * A portfolio with no other domain in it returns `rank: null` rather than
 * `1`. "First of one" is technically true and reads as an achievement; there
 * is no comparison, and the panel says so instead.
 */
export function rankPortfolio(
  peers: PortfolioPeer[],
  target: string,
  score: number,
): { peers: PortfolioPeer[]; rank: number | null; total: number } {
  const others = peers.filter((peer) => peer.domain !== target.toLowerCase());
  const higher = others.filter((peer) => peer.score > score).length;

  const all = [
    ...others,
    { domain: target.toLowerCase(), score, scannedAt: '', isTarget: true },
  ].sort((a, b) => b.score - a.score || a.domain.localeCompare(b.domain));

  return {
    peers: all,
    rank: others.length === 0 ? null : higher + 1,
    total: all.length,
  };
}

interface Row {
  domain: string;
  composite_score: number;
  scanned_at: string | null;
  category_scores: Record<string, number> | null;
}

/**
 * The organisation's assessments in one industry, ranked.
 *
 * `industry` is matched exactly rather than fuzzily. It comes from a fixed
 * list the person picked at scan time, so there is nothing to normalise, and
 * a near-match would silently compare a bank against a logistics firm.
 */
export async function industryPortfolio(
  supabase: SupabaseClient,
  options: { orgId: string; industry: string; domain: string; score: number },
): Promise<PortfolioComparison | null> {
  const { orgId, industry, domain, score } = options;
  const target = domain.toLowerCase();

  try {
    const org = await supabase
      .from('organisations')
      .select('name')
      .eq('id', orgId)
      .maybeSingle();

    // Not a member, or no such organisation. The policy returns nothing in
    // both cases and they are not distinguished here for the same reason
    // `resolveOwner` does not distinguish them.
    if (org.error || !org.data) return null;

    const { data, error } = await supabase
      .from('assessments')
      .select('domain, composite_score, scanned_at, category_scores')
      .eq('owner_org_id', orgId)
      .eq('industry', industry)
      .order('scanned_at', { ascending: false })
      .limit(500);

    if (error || !data) return null;

    /*
     * One domain, one row — the newest. The table keeps every run so scores
     * can be tracked over time, and counting a vendor once per scan would let
     * a supplier reassessed weekly dominate the ranking of a portfolio they
     * are one member of.
     *
     * The target is excluded here and re-inserted below with the score from
     * the assessment on screen, which may not be stored yet: an anonymous
     * reader's scan is never stored at all, and a member's has usually not
     * been committed at the moment this renders.
     */
    const rows = latestPerDomain(data as unknown as Row[], target) as Row[];

    const peers: PortfolioPeer[] = rows
      .map((row) => ({
        domain: (row.domain ?? '').toLowerCase(),
        score: Number(row.composite_score) || 0,
        scannedAt: row.scanned_at ?? '',
      }))
      .filter((peer) => peer.domain);

    return {
      orgName: (org.data as { name: string }).name,
      industry,
      ...rankPortfolio(peers, target, score),
    };
  } catch {
    // A portfolio that cannot be read costs the reader a comparison. It must
    // not cost them the assessment they actually asked for.
    return null;
  }
}
