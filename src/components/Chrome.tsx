import Link from 'next/link';

import AccountMenu from '@/components/AccountMenu';
import { Emblem } from '@/components/Emblem';
import MainNav from '@/components/MainNav';
import ThemeToggle from '@/components/ThemeToggle';

/**
 * The wordmark: the emblem, then the name.
 *
 * The name is set in the titling face, uppercase and tracked out — which is
 * the letterspacing of an engraved plate rather than of a logotype, and is the
 * one place a Didone is allowed below 24px. The tracking is 0.22em rather than
 * the 0.15em first sketched: Bodoni's caps carry so much white inside the
 * letterforms that at 0.15em the word still read as a single dark block, and
 * it needed opening up further before the five letters separated.
 */
export function Wordmark({ href = '/' }: { href?: string | null }) {
  const inner = (
    <span className="inline-flex items-center gap-2.5">
      <Emblem size={22} className="shrink-0 text-seal" />
      <span className="font-display text-[15px] font-bold uppercase leading-none tracking-[0.22em] text-tx">
        Klyro
      </span>
    </span>
  );

  if (!href) return <span className="text-tx">{inner}</span>;

  return (
    <Link href={href} className="text-tx transition-opacity duration-150 hover:opacity-70">
      {inner}
    </Link>
  );
}

/**
 * The header row every page shares.
 *
 * It carries the navigation now, rather than leaving each page to compose its
 * own from whatever links seemed relevant there. That change is the point of
 * the current shape: the same bar, in the same order, with the current page
 * marked, on every route — see `navItems.ts` for what the four different
 * hand-rolled bars looked like before, and why one of them naming the same
 * destination differently was the actual usability problem.
 *
 * `children` still exists, for the rare page that needs a word of context
 * beside the controls, but it is no longer where navigation goes.
 *
 * Structurally: wordmark and navigation left, account and theme right. The
 * left group is "where you can go" and the right is "who you are and how this
 * looks", which is the split every reader already expects and the previous
 * arrangement — everything crowded to the right of the wordmark — did not
 * make.
 */
export function SiteHeader({
  children,
  href = '/',
  account = true,
  nav = true,
}: {
  children?: React.ReactNode;
  href?: string | null;
  /**
   * Set false on the pages that *are* the account flow. `/login` offering a
   * "Sign in" link, or `/signup` a "Create account" one, is a control that
   * points at the page it is already on.
   */
  account?: boolean;
  /** Set false where the page supplies its own in-context navigation. */
  nav?: boolean;
}) {
  return (
    <header className="flex items-center justify-between gap-4">
      <div className="flex min-w-0 items-center gap-6 lg:gap-8">
        <Wordmark href={href} />
        {nav && <MainNav />}
      </div>
      <div className="flex shrink-0 items-center gap-3 sm:gap-4">
        {children}
        {account && <AccountMenu />}
        <ThemeToggle />
      </div>
    </header>
  );
}

/** A hairline separator for inline metadata runs. */
export function Sep() {
  return <span className="h-3 w-px shrink-0 bg-line-strong" aria-hidden="true" />;
}

export function PageFooter({ children }: { children?: React.ReactNode }) {
  return (
    <footer className="mt-20 border-t border-line py-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-3">
          <Wordmark />
          {/*
           * The scanner announces this page in its User-Agent, so it has to be
           * reachable from the product too — an operator who reaches the site
           * any other way should find the same disclosure.
           */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
            <Link
              href="/scanner"
              className="text-[11.5px] text-tx-3 transition-colors duration-150 hover:text-tx-2"
            >
              What the scanner requests
            </Link>
            <Link
              href="/methodology"
              className="text-[11.5px] text-tx-3 transition-colors duration-150 hover:text-tx-2"
            >
              Methodology
            </Link>
          </div>
          {/*
           * Legal. Plain `<a>`, not `Link` — these are static files served from
           * `public/legal/`, not app routes, and `Link`'s prefetch assumes the
           * href resolves to an RSC payload rather than a flat asset.
           */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
            <a
              href="/legal/TERMS_OF_SERVICE.md"
              className="text-[11.5px] text-tx-3 transition-colors duration-150 hover:text-tx-2"
            >
              Terms of Service
            </a>
            <a
              href="/legal/PRIVACY_POLICY.md"
              className="text-[11.5px] text-tx-3 transition-colors duration-150 hover:text-tx-2"
            >
              Privacy Policy
            </a>
            <a
              href="/legal/ACCEPTABLE_USE_POLICY.md"
              className="text-[11.5px] text-tx-3 transition-colors duration-150 hover:text-tx-2"
            >
              Acceptable Use Policy
            </a>
          </div>
        </div>
        <p className="max-w-xl text-[11.5px] leading-relaxed text-tx-3">
          {children ??
            'Passive reconnaissance using publicly available information only. No systems are accessed, scanned for vulnerabilities, or tested.'}
        </p>
      </div>
    </footer>
  );
}
