import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import type { SupabaseClient } from '@supabase/supabase-js';

import { SUPABASE_ANON_KEY, SUPABASE_URL, isSupabaseConfigured } from './config';

/**
 * A Supabase client bound to one request's session.
 *
 * This is the client almost everything should use. It carries the caller's
 * cookies, so every query runs as that user and row level security decides
 * what comes back. A route using this client cannot accidentally read another
 * user's data even if it forgets to filter, because the database is doing the
 * filtering.
 *
 * ## Why this is constructed per request, and never cached
 *
 * The previous implementation was a module-level singleton:
 *
 *     let client: SupabaseClient | null = null;
 *     export function getSupabase() {
 *       if (!client) client = createClient(url, anonKey);
 *       return client;
 *     }
 *
 * That was safe only because it was anonymous and stateless. The moment a
 * client carries a session, a cached one is a cross-request session leak: in a
 * long-lived server process the module is evaluated once and shared by every
 * concurrent request, so whichever user's token was attached last is the
 * identity every other request runs as. The symptom is users intermittently
 * seeing each other's data under load — non-deterministic, hard to reproduce,
 * and a breach the whole time it goes unnoticed.
 *
 * There is no memoisation here for that reason, and there must not be one
 * added. Constructing a client is cheap; it is a wrapper around fetch.
 */
export function createClientForRequest(): SupabaseClient | null {
  if (!isSupabaseConfigured) return null;

  const cookieStore = cookies();

  return createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          /*
           * Called from a Server Component, where cookies are read-only.
           * Refreshing the session is the middleware's job; a component that
           * cannot write the refreshed token still reads the current one
           * correctly, so this is not an error worth propagating.
           */
        }
      },
    },
  });
}

/**
 * The signed-in user, or null.
 *
 * `getUser()` rather than `getSession()`, and the difference matters: a
 * session is read from the cookie and can be anything the client put there,
 * while `getUser()` verifies the token with the auth server before returning.
 * Trusting `getSession().user.id` server-side means trusting a value the
 * caller controls — the ownership on every assessment would be whatever they
 * claimed it was.
 */
export async function getCurrentUser(): Promise<{ id: string; email: string | null } | null> {
  const supabase = createClientForRequest();
  if (!supabase) return null;

  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;

  return { id: data.user.id, email: data.user.email ?? null };
}
