'use client';

import { createBrowserClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';

import { SUPABASE_ANON_KEY, SUPABASE_URL, isSupabaseConfigured } from './config';

/**
 * The browser client. Auth only.
 *
 * Signing in, signing out, and reading the current session for the header.
 * Data reads go through API routes rather than directly from here — not
 * because a direct read would be insecure (row level security applies to the
 * anon key exactly as it does on the server) but because the routes already
 * carry the rate limiting, validation and shaping that the dashboard depends
 * on, and two paths to the same data means two places for the rules to drift.
 *
 * Caching is correct here, unlike on the server: there is one browser, one
 * user, and the client owns the session-refresh timer. A new client per call
 * would mean several timers refreshing the same token.
 */

let client: SupabaseClient | null = null;

export function getBrowserClient(): SupabaseClient | null {
  if (!isSupabaseConfigured) return null;
  if (!client) {
    client = createBrowserClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  }
  return client;
}
