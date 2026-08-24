'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { isActive, NAV_ITEMS, PUBLIC_NAV_ITEMS } from '@/components/navItems';
import { useSession } from '@/components/SessionProvider';

/**
 * One navigation bar, on every page, in the same place, saying the same
 * things.
 *
 * Which links appear depends on whether anyone is signed in — offering
 * "Organisations" to a visitor who cannot have one is a door onto a page that
 * exists to tell them to sign in — and that answer comes from the session
 * context in the root layout, so it is already settled when this first
 * paints.
 *
 * Where you are is marked. The previous bars had no current-page state at
 * all, which on a set of four cross-linked pages means the only way to know
 * which one you are on is to read the heading. The mark is an underline in
 * the seal colour rather than a filled pill: the header is a hairline rule
 * over a flat ground and a pill is the heaviest object that could be put in
 * it.
 *
 * Hidden below `lg`, where the account menu carries the same list instead.
 * Four links, an account control, and a theme toggle stop fitting somewhere
 * around the tablet breakpoint, and a header that scrolls sideways is worse
 * than a header with one more tap in it.
 */
export default function MainNav() {
  const pathname = usePathname();
  const { account } = useSession();

  /*
   * While the session is still resolving, show the signed-out set. It is the
   * correct answer for most visitors, it is the shorter of the two — so
   * settling into the signed-in set grows the bar rather than reflowing the
   * controls beside it — and it never offers a link that would bounce the
   * reader to a sign-in page.
   */
  const items = account ? NAV_ITEMS : PUBLIC_NAV_ITEMS;

  return (
    <nav className="hidden items-center gap-5 lg:flex xl:gap-6" aria-label="Primary">
      {items.map((entry) => {
        const current = isActive(pathname, entry);
        return (
          <Link
            key={entry.href}
            href={entry.href}
            aria-current={current ? 'page' : undefined}
            className={`relative py-1 text-[12.5px] transition-colors duration-150 ${
              current ? 'text-tx' : 'text-tx-2 hover:text-tx'
            }`}
          >
            {entry.label}
            {current && (
              <span
                aria-hidden="true"
                className="absolute -bottom-0.5 left-0 h-px w-full bg-seal"
              />
            )}
          </Link>
        );
      })}
    </nav>
  );
}
