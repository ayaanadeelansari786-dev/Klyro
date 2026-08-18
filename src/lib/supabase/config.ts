/**
 * Shared Supabase configuration.
 *
 * No client is constructed here — this module is imported by browser code, so
 * anything it touches ends up in the bundle. It reads the two public values
 * and nothing else. The service-role key is deliberately absent: see
 * `./service.ts`, which is the only module allowed to know it exists.
 */

export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
export const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';

/**
 * Supabase remains optional. Klyro runs a full assessment without it and skips
 * persistence, benchmarking and accounts, so every caller null-checks rather
 * than assuming a client exists.
 */
export const isSupabaseConfigured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

/** Row shape of the legacy corpus table, still read by the seeding path. */
export interface ScanRow {
  id: string;
  domain: string;
  industry: string;
  region: string;
  composite_score: number;
  category_scores: Record<string, number>;
  findings: unknown;
  scanned_at: string;
}
