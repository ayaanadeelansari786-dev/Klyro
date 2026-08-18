import { createPublicClient } from '../supabase/public';

export interface LeaderboardRow {
  domain: string;
  display_name: string | null;
  industry: string;
  region: string;
  composite_score: number;
  risk_level: string | null;
  coverage: number | null;
  category_scores: Record<string, number> | null;
  scanned_at: string;
  previous_score: number | null;
  score_delta: number | null;
  previous_scanned_at: string | null;
  parent_name: string | null;
  parent_domain: string | null;
  ownership_type: string | null;
  ownership_confidence: string | null;
  is_parent_entity: boolean | null;
  linkage_verdict: string | null;
  parent_score: number | null;
  ownership_narrative: string | null;
  industry_rank: number;
  industry_size: number;
  industry_average: number;
  overall_rank: number;
  overall_size: number;
}

export interface IndustrySummaryRow {
  industry: string;
  vendors: number;
  average_score: number;
  median_score: number;
  min_score: number;
  max_score: number;
  with_parent: number;
}

export interface RankingsPayload {
  configured: boolean;
  industries: IndustrySummaryRow[];
  rows: LeaderboardRow[];
  totalVendors: number;
  runs: string[];
}

export async function getRankings(industry?: string, region?: string): Promise<RankingsPayload> {
  const supabase = createPublicClient();
  if (!supabase) {
    return { configured: false, industries: [], rows: [], totalVendors: 0, runs: [] };
  }

  let query = supabase
    .from('vendor_leaderboard')
    .select('*')
    .order('composite_score', { ascending: false });

  if (industry) query = query.eq('industry', industry);
  if (region) query = query.eq('region', region);

  const [leaderboard, summary] = await Promise.all([
    query.limit(500),
    supabase.from('industry_summary').select('*').order('industry'),
  ]);

  if (leaderboard.error) throw new Error(leaderboard.error.message);

  return {
    configured: true,
    industries: (summary.data ?? []) as IndustrySummaryRow[],
    rows: (leaderboard.data ?? []) as LeaderboardRow[],
    totalVendors: (leaderboard.data ?? []).length,
    runs: [],
  };
}

/**
 * Score history for one domain in the *public corpus*, oldest first.
 *
 * Deliberately not a user's own history. This reads `benchmark_samples`, which
 * holds no owner and no private content, and drives the trend line on the
 * public rankings page. A signed-in user's saved assessments live in
 * `assessments` and are read through the request-scoped client so that row
 * level security applies — a public client must never be pointed at that
 * table.
 */
export async function getHistory(domain: string): Promise<
  { composite_score: number; scanned_at: string; run_label: string | null; risk_level: string | null }[]
> {
  const supabase = createPublicClient();
  if (!supabase) return [];

  const { data, error } = await supabase
    .from('benchmark_samples')
    .select('composite_score, scanned_at, run_label, risk_level')
    .eq('domain', domain)
    .order('scanned_at', { ascending: true })
    .limit(200);

  if (error) return [];
  return (data ?? []) as {
    composite_score: number;
    scanned_at: string;
    run_label: string | null;
    risk_level: string | null;
  }[];
}
