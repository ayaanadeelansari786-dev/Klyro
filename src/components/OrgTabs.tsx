'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * The two views of one organisation, as tabs rather than as cross-links.
 *
 * `/org/[id]` and `/org/[id]/activity` are the same organisation seen two
 * ways, but they used to be joined by a pair of asymmetric links: the
 * settings page offered "Activity", and the activity page offered
 * "Organisation settings". Nothing said the two were siblings, nothing said
 * which one you were on, and the destination changed its name depending on
 * the direction you were travelling. Reading either header told you where you
 * could go but not where you were.
 *
 * A tab strip states both at once, which is the entire reason to prefer it
 * here. It is also the honest shape: these really are two tabs of one thing,
 * and the previous arrangement implied two separate pages that happened to
 * link to each other.
 *
 * Activity is listed first because it is the page a member opens on purpose.
 * Settings is where you go to change something, which is rarer, and putting
 * the rarer one first is how the roster ended up two clicks away from `/org`.
 */
export default function OrgTabs({ orgId }: { orgId: string }) {
  const pathname = usePathname();

  const tabs = [
    { href: `/org/${orgId}/activity`, label: 'Activity' },
    { href: `/org/${orgId}`, label: 'Members & settings' },
  ];

  return (
    <nav className="mt-8 flex items-center gap-1 border-b border-line" aria-label="Organisation">
      {tabs.map((tab) => {
        const current = pathname === tab.href;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={current ? 'page' : undefined}
            className={`-mb-px border-b px-3 py-2.5 text-[12.5px] transition-colors duration-150 ${
              current
                ? 'border-seal text-tx'
                : 'border-transparent text-tx-2 hover:border-line-strong hover:text-tx'
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
