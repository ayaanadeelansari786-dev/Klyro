/**
 * Compatibility surface for the old single-client module.
 *
 * There used to be one `getSupabase()` here returning a cached anon client
 * shared by every caller. That is gone: with sessions in play a cached client
 * is a cross-request identity leak, and with three different privilege levels
 * "the Supabase client" is no longer a meaningful thing to ask for.
 *
 * Pick deliberately:
 *
 *   - `supabase/server`  — the caller's own rights. Row level security applies.
 *                          This is the default and should be the answer almost
 *                          every time.
 *   - `supabase/service` — bypasses row level security. Server-only, and only
 *                          for work that genuinely cannot run as the caller.
 *   - `supabase/browser` — auth UI in client components.
 *
 * This file re-exports only the configuration flag, so that the choice of
 * client is always made explicitly at the point of use.
 */

export { isSupabaseConfigured, type ScanRow } from './supabase/config';
