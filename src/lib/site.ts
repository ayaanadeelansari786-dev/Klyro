/**
 * Where this deployment says it lives.
 *
 * Klyro identifies itself in every outbound request with a User-Agent that
 * carries a URL, which is the convention a site operator relies on when an
 * unfamiliar client shows up in their logs. That convention only works if the
 * URL resolves to a page explaining the traffic — a `+https://…` pointing at a
 * 404 is worse than no URL at all, because it looks like an attempt to appear
 * legitimate.
 *
 * The URL therefore has to follow the deployment rather than being hardcoded
 * to the domain the project was written under. `NEXT_PUBLIC_SITE_URL` is read
 * at build time and falls back to the canonical host.
 */

function normaliseOrigin(value: string | undefined, fallback: string): string {
  if (!value) return fallback;

  try {
    const url = new URL(value.includes('://') ? value : `https://${value}`);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return fallback;
    return url.origin;
  } catch {
    return fallback;
  }
}

/** Origin of this deployment, with no trailing slash. */
export const SITE_URL = normaliseOrigin(process.env.NEXT_PUBLIC_SITE_URL, 'https://klyro.security');

/** The page an operator lands on from the User-Agent string. */
export const SCANNER_INFO_URL = `${SITE_URL}/scanner`;

/**
 * Where an operator writes about scanner traffic.
 *
 * Deliberately not a mailto: constructed from the site domain — a deployment
 * on a preview host would then publish an address that bounces.
 */
export const SCANNER_CONTACT =
  process.env.NEXT_PUBLIC_SCANNER_CONTACT?.trim() || 'abuse@klyro.security';
