import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { SUPABASE_ANON_KEY, SUPABASE_URL, isSupabaseConfigured } from './config';

/**
 * An anonymous client with no session attached.
 *
 * For the data that is genuinely public: the benchmark corpus, the vendor
 * registry, the rankings views. Row level security still applies — this runs
 * as `anon`, which after migration 0002 can read those tables and write
 * nothing anywhere.
 *
 * It exists as a separate thing from the request-scoped client for a practical
 * reason as much as a conceptual one. `createClientForRequest()` reads
 * `cookies()`, which is only available inside a request's async context, and
 * the benchmark lookup runs inside the scan route's streaming callback — after
 * the response has started, where that context may no longer be attached.
 * Public data has no reason to need a session, so it does not ask for one.
 *
 * The rule this encodes: a caller picks its privilege level explicitly. There
 * is no client you get by default and hope is right.
 */
export function createPublicClient(): SupabaseClient | null {
  if (!isSupabaseConfigured) return null;

  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
