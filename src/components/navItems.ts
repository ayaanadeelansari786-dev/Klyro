/**
 * The primary navigation, in one place.
 *
 * Every page used to hand-roll its own `<nav>` with whatever two or three
 * links seemed relevant from there. `/app` offered "New assessment" and
 * "Organisations"; `/org` offered "Your assessments" and "New assessment";
 * the organisation page offered "All organisations", "Activity", and "Your
 * assessments"; the activity page offered "Organisation settings" and "Your
 * assessments". Four pages, four different bars, and the same destination
 * named three different ways — "Your assessments", "Assessments", and
 * "/app" — depending on where you happened to be standing. There was no
 * stable place to look, so every navigation started by reading the header
 * to find out what it contained this time.
 *
 * `/rankings` is in both lists because it was in neither: the benchmark
 * dataset was linked from a one-item `<nav>` on the landing page and from
 * nowhere else in the product, so it existed only for a reader who happened
 * to be standing on the home page and looking to the right of the wordmark.
 *
 * This is a plain data module rather than a component so that both the header
 * bar and the account menu render the same list from the same source. Two copies of a navigation are how one of them ends up missing a
 * link.
 */

export interface NavItem {
  href: string;
  label: string;
  /**
   * Marked active for any path beneath `href`, not only an exact match.
   * `/org/abc/activity` should light "Organisations"; `/` should not light
   * for every page in the app.
   */
  prefix?: boolean;
}

/** For a signed-in reader. */
export const NAV_ITEMS: NavItem[] = [
  { href: '/', label: 'New assessment' },
  { href: '/app', label: 'Assessments', prefix: true },
  { href: '/org', label: 'Organisations', prefix: true },
  { href: '/rankings', label: 'Benchmark', prefix: true },
];

/**
 * For a signed-out one. Deliberately short: the two controls that matter to
 * a visitor who is not signed in are "Sign in" and "Create account", and
 * those live in the account slot beside this. Everything else about the
 * product is reachable from the footer, which is on every page.
 */
export const PUBLIC_NAV_ITEMS: NavItem[] = [
  { href: '/methodology', label: 'Methodology' },
  { href: '/scanner', label: 'What we request' },
  { href: '/rankings', label: 'Benchmark', prefix: true },
];

export function isActive(pathname: string, item: NavItem): boolean {
  if (!item.prefix) return pathname === item.href;
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}
