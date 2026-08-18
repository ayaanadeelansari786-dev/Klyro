import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

/**
 * Keeps the session alive, and does nothing else.
 *
 * Supabase access tokens are short-lived. Without something refreshing them on
 * each navigation, a user who leaves a tab open comes back signed out — so
 * this runs `getUser()`, which performs the refresh as a side effect, and
 * copies any rotated cookies onto the response.
 *
 * ## What this deliberately does not do
 *
 * It does not guard routes. Middleware runs before the request reaches a route
 * handler and can only see cookies, so a check here would be a check on
 * whether a token exists — not on what it permits. Authorisation lives in the
 * database, where it is enforced per row for every query regardless of which
 * code path reached it. A middleware redirect is a convenience for the person
 * using the product, not a security control, and treating it as one is how
 * "we check auth in middleware" becomes an incident report.
 *
 * The practical consequence: `/app` and `/org` are reachable while signed out.
 * They render an empty state and a sign-in link, because their data comes back
 * empty, because the policy returned nothing.
 */
export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  // Supabase is optional. Anonymous scanning is the whole product without it.
  if (!url || !key) return response;

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  // `getUser()` rather than `getSession()`: it validates the token with the
  // auth server, which is what triggers the refresh. `getSession()` reads the
  // cookie and would let an expired session look alive.
  await supabase.auth.getUser();

  return response;
}

export const config = {
  matcher: [
    /*
     * Everything except static assets and the scanner disclosure page.
     *
     * `/scanner` is excluded because it is the page a site operator lands on
     * from a User-Agent string in their logs. They are not a Klyro user and
     * have no session; running an auth round trip to serve them a static page
     * would be pure latency.
     */
    '/((?!_next/static|_next/image|favicon.ico|scanner|.*\\.(?:svg|png|jpg|jpeg|gif|webp|woff2?)$).*)',
  ],
};
