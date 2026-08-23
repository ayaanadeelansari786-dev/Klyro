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
 * Two positions are computed, not one. The same-industry set is the sharper
 * comparison — a bank and a logistics firm are not held to the same
 * expectations in practice — but it is also the one that is empty for the
 * first vendor in every new industry, which early on is most of them. The
 * whole-portfolio set is populated the moment an organisation has assessed
 * two things at all, and it answers the question a buyer asks first: of
 * everything we have looked at, where does this one sit? Both are returned
 * and labelled, and neither is presented as the other.
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
 * disable that. A viewer sees exactly what an owner sees, because that policy
 * is `app.is_org_member`, not a role test.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { latestPerDomain } from '../benchmark';

export interface PortfolioPeer {
  domain: string;
  score: number;
  scannedAt: string;
  /**
   * The peer's industry. Only meaningful in the whole-portfolio scope, where
   * the set is mixed and the label is what keeps the comparison honest.
   */
  industry?: string;
  /** True for the domain currently on screen. */
  isTarget?: boolean;
}

/** One ranking: a position, the set it was taken within, and that set's size. */
export interface PortfolioScope {
  /** Every distinct domain in this scope, including the target, best first. */
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

export interface PortfolioComparison {
  orgName: string;
  /** The target's own industry, which labels the narrower scope. */
  industry: string;
  /** Against the organisation's other vendors in the same industry. */
  sameIndustry: PortfolioScope;
  /** Against every vendor the organisation has assessed, industry ignored. */
  everything: PortfolioScope;
  /** How many distinct industries `everything` spans, target included. */
  industriesCovered: number;
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
): PortfolioScope {
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
  industry: string | null;
  composite_score: number;
  scanned_at: string | null;
  category_scores: Record<string, number> | null;
}

function toPeers(rows: Row[]): PortfolioPeer[] {
  return rows
    .map((row) => ({
      domain: (row.domain ?? '').toLowerCase(),
      score: Number(row.composite_score) || 0,
      scannedAt: row.scanned_at ?? '',
      industry: row.industry ?? undefined,
    }))
    .filter((peer) => peer.domain);
}

/**
 * The organisation's assessments, ranked twice: within the target's industry,
 * and across the whole portfolio.
 *
 * `industry` is matched exactly rather than fuzzily for the narrower scope. It
 * comes from a fixed list the person picked at scan time, so there is nothing
 * to normalise, and a near-match would silently compare a bank against a
 * logistics firm.
 */
export async function organisationPortfolio(
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

    /*
     * One query, unfiltered by industry, split in memory afterwards. The
     * narrower scope used to filter in SQL; keeping that and adding the wider
     * one would be two round trips for two views of the same rows.
     *
     * The ceiling is a real one: an organisation past 2000 stored runs ranks
     * against its 2000 most recent rather than all of them. Ordering newest
     * first means the truncation drops old re-scans of busy domains before it
     * drops whole vendors, so the set thins evenly instead of losing an
     * arbitrary slice of the portfolio.
     */
    const { data, error } = await supabase
      .from('assessments')
      .select('domain, industry, composite_score, scanned_at, category_scores')
      .eq('owner_org_id', orgId)
      .order('scanned_at', { ascending: false })
      .limit(2000);

    if (error || !data) return null;

    /*
     * One domain, one row — the newest. The table keeps every run so scores
     * can be tracked over time, and counting a vendor once per scan would let
     * a supplier reassessed weekly dominate the ranking of a portfolio they
     * are one member of.
     *
     * The target is excluded here and re-inserted by `rankPortfolio` with the
     * score from the assessment on screen, which may not be stored yet: an
     * anonymous reader's scan is never stored at all, and a member's has
     * usually not been committed at the moment this renders.
     */
    const overallRows = latestPerDomain(data as unknown as Row[], target) as Row[];
    const industryRows = overallRows.filter((row) => row.industry === industry);

    const industries = new Set<string>([industry]);
    for (const row of overallRows) if (row.industry) industries.add(row.industry);

    return {
      orgName: (org.data as { name: string }).name,
      industry,
      sameIndustry: rankPortfolio(toPeers(industryRows), target, score),
      everything: rankPortfolio(toPeers(overallRows), target, score),
      industriesCovered: industries.size,
    };
  } catch {
    // A portfolio that cannot be read costs the reader a comparison. It must
    // not cost them the assessment they actually asked for.
    return null;
  }
}
