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

/**
 * Why Supabase is unconfigured, when it is.
 *
 * Worth a function because the failure is genuinely confusing, and silence
 * about it costs an hour every time. These two values carry the `NEXT_PUBLIC_`
 * prefix, which means Next.js replaces them with string literals at
 * `next build` — the compiled output contains the value, not a lookup, on the
 * server as well as in the browser. So they are fixed at the moment the bundle
 * was compiled and cannot be changed by the running environment.
 *
 * The substitution only happens when a value is actually present at build
 * time, and that is the subtle part. A variable that is *absent* leaves the
 * lookup intact, so the server reads it at request time and everything works.
 * A variable that is *present but empty* is compiled in as an empty string and
 * frozen there — no runtime value can dislodge it, because there is no longer
 * a lookup to satisfy. Those two states look identical in a dashboard.
 *
 * Meanwhile the server-only keys, the ones with no prefix, are always read at
 * request time and start working the moment they are set. So a deployment can
 * look correctly configured while exactly the prefixed half of it is stale.
 *
 * Returns null when everything is present. Never contains a secret: it reports
 * presence and length, never a value.
 */
export function supabaseConfigDiagnostic(): string | null {
  if (isSupabaseConfigured) return null;

  const missing = [
    ...(SUPABASE_URL ? [] : ['NEXT_PUBLIC_SUPABASE_URL']),
    ...(SUPABASE_ANON_KEY ? [] : ['NEXT_PUBLIC_SUPABASE_ANON_KEY']),
  ];

  return (
    `${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} empty in this build. ` +
    'These carry the NEXT_PUBLIC_ prefix, so a value present at build time is compiled into the ' +
    'output rather than read at run time. If the variable was defined but empty when this bundle ' +
    'was built, the empty string is frozen into it and setting a value in the hosting dashboard ' +
    'will not change this deployment. Trigger a fresh build with the build cache disabled, and ' +
    'check the variable is non-empty for the environment being built.'
  );
}

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
