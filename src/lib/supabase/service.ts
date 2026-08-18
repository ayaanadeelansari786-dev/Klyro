import 'server-only';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { SUPABASE_URL } from './config';

/**
 * The privileged client. Bypasses row level security entirely.
 *
 * The `import 'server-only'` above is the guard that matters. This key grants
 * unrestricted read and write across every table — every user's assessments,
 * every organisation's portfolio, every join code hash. If it reaches the
 * browser bundle it is game over, and the ordinary way that happens is not
 * malice but a refactor: someone imports a helper from here into a module that
 * a client component also imports, and the key ships. `server-only` turns that
 * into a build failure instead of a breach.
 *
 * Note also that the key is read from `SUPABASE_SERVICE_ROLE_KEY`, with no
 * `NEXT_PUBLIC_` prefix. Next.js only inlines prefixed variables into client
 * bundles, so the naming is a second, independent guard.
 *
 * ## When to use it
 *
 * Only where the operation genuinely cannot be expressed as the caller:
 *
 *   - Writing an assessment. The output of a scan Klyro ran; no client may
 *     invent one, so there is no INSERT policy for any client role.
 *   - Verifying a join code. Requires reading a hash the client must not see.
 *   - Creating an organisation and its first owner, atomically.
 *   - Seeding the benchmark corpus.
 *
 * Everywhere else uses `createClientForRequest()` so the database enforces
 * access rather than the route remembering to. A service-role query with a
 * caller-supplied id and no ownership check is an IDOR with extra steps.
 */

const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

export const isServiceRoleConfigured = Boolean(SUPABASE_URL && serviceKey);

/**
 * Constructed per call rather than cached.
 *
 * Less critical than for the request-scoped client — this one carries no user
 * session, so there is nothing to leak between requests — but the same rule is
 * applied for consistency, so that nobody reading this file later concludes
 * that caching a Supabase client is sometimes fine.
 */
export function createServiceClient(): SupabaseClient | null {
  if (!isServiceRoleConfigured) return null;

  return createClient(SUPABASE_URL, serviceKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      // This client has no user and must never acquire one from a URL.
      detectSessionInUrl: false,
    },
  });
}

/**
 * The service client, or a thrown error naming what is missing.
 *
 * For the paths where absence is a misconfiguration rather than a supported
 * mode — storing an assessment for a signed-in user, for instance. Failing
 * loudly beats silently not saving someone's data.
 */
export function requireServiceClient(): SupabaseClient {
  const client = createServiceClient();

  if (!client) {
    throw new Error(
      'SUPABASE_SERVICE_ROLE_KEY is not configured. Accounts, organisations and saved ' +
        'assessments require it. Anonymous scanning does not, and continues to work without it.',
    );
  }

  return client;
}
