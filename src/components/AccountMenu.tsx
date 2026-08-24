'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState } from 'react';

import { NAV_ITEMS } from '@/components/navItems';
import { useSession } from '@/components/SessionProvider';

/**
 * Who is signed in, and the way out.
 *
 * Session state is read from `SessionProvider` in the root layout rather than
 * fetched here. That is not a tidiness change: this component used to call
 * `supabase.auth.getUser()` in its own effect, and because the header is
 * rendered per page rather than by a layout, every navigation mounted a fresh
 * copy and made the call again. The reader watched their own name disappear
 * and come back on every click. Reading from context, the answer is already
 * settled by the time this mounts, and the first paint is the right one.
 *
 * The session is still resolved in the browser rather than on the server, and
 * that part is a deliberate trade. The landing page is the one statically
 * prerendered route in the app and the page most people arrive on; reading
 * the session server-side would make it render per request and give up its
 * CDN cache to decide whether to draw a name in the corner.
 *
 * The cost is one moment on first load, before the provider has answered. It
 * is covered by rendering the signed-out control itself, made invisible,
 * rather than a guessed-width box: a visitor who turns out to be signed out —
 * the common case on a landing page — sees the header settle with no movement
 * at all, at every breakpoint, because the space held was the real markup.
 */

export default function AccountMenu() {
  const router = useRouter();
  const pathname = usePathname();
  const { account, signOut } = useSession();

  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  /*
   * Focusable items are read from the DOM rather than collected into a ref
   * array as they render, and filtered by `offsetParent` so anything
   * `display: none` is skipped. Arrow keys should never walk onto an item
   * nobody can see, and a ref array populated during render cannot know
   * which items CSS has since hidden.
   */
  function menuItems(): HTMLElement[] {
    const found = menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]');
    return Array.from(found ?? []).filter((el) => el.offsetParent !== null);
  }

  /* Escape closes and returns focus to the trigger; a click outside just
     closes. The same contract the report menu keeps. */
  useEffect(() => {
    if (!open) return;

    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };

    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [open]);

  useEffect(() => {
    if (open) menuItems()[0]?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  /*
   * Close on navigation. The menu now contains links, and without this a tap
   * on one of them leaves it hanging open over the page it just opened.
   * Keyed on the pathname rather than the router object, which is stable
   * across navigations and would never fire this.
   */
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  function onMenuKeyDown(event: React.KeyboardEvent) {
    const items = menuItems();
    if (items.length === 0) return;
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      items[(at + 1) % items.length]?.focus();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      items[(at - 1 + items.length) % items.length]?.focus();
    }
  }

  async function runSignOut() {
    if (!signOut) return;
    setSigningOut(true);
    try {
      await signOut();
      setOpen(false);
      /*
       * Both, and in this order. `refresh()` re-runs the server components
       * that read the session — otherwise `/app` keeps rendering the history
       * it fetched while signed in — and `push('/')` moves off any page that
       * exists only for a signed-in reader.
       */
      router.refresh();
      router.push('/');
    } finally {
      setSigningOut(false);
    }
  }

  // Asked, not yet answered — and once answered, nobody. The same markup
  // serves both, so the settled signed-out header occupies exactly the space
  // the pending one reserved.
  if (account === undefined || account === null) {
    const pending = account === undefined;
    return (
      <div
        className={`flex items-center gap-3 sm:gap-4 ${pending ? 'invisible' : ''}`}
        aria-hidden={pending || undefined}
      >
        <Link
          href="/login"
          tabIndex={pending ? -1 : undefined}
          className="text-[12.5px] text-tx-2 transition-colors duration-150 hover:text-tx"
        >
          Sign in
        </Link>
        <Link
          href="/signup"
          tabIndex={pending ? -1 : undefined}
          className="btn-ghost px-3 py-1.5 text-[12.5px]"
        >
          Create account
        </Link>
      </div>
    );
  }

  const item =
    'flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left text-[13px] text-tx-2 ' +
    'transition-colors duration-150 hover:bg-tx/[0.05] hover:text-tx disabled:opacity-50 ' +
    'focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-seal-ink';

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        className="flex items-center gap-2 rounded border border-line bg-raised px-2 py-1.5 text-[12.5px]
          text-tx-2 transition-colors duration-150 hover:border-line-strong hover:text-tx
          focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-seal-ink"
      >
        {/* The initial, not an avatar. Klyro has no picture of anybody and
            inventing one from a service that does is a request to a third
            party about who is signed in. */}
        <span
          aria-hidden="true"
          className="flex h-[19px] w-[19px] shrink-0 items-center justify-center rounded-full
            bg-seal/15 font-mono text-[10px] font-medium uppercase text-seal-ink"
        >
          {account.displayName.slice(0, 1)}
        </span>
        <span className="hidden max-w-[13ch] truncate sm:inline">{account.displayName}</span>
        <svg
          width="11"
          height="11"
          viewBox="0 0 12 12"
          fill="none"
          aria-hidden="true"
          className={`shrink-0 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
        >
          <path
            d="M2.5 4.5 6 8l3.5-3.5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {open && (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          onKeyDown={onMenuKeyDown}
          className="panel absolute right-0 top-[calc(100%+6px)] z-50 w-[228px] overflow-hidden py-1 shadow-lift"
        >
          {/* Which account, spelled out. A menu that only shows a first name
              cannot answer "am I in the right account", which is the question
              somebody with a work and a personal login is actually asking. */}
          <div className="border-b border-line px-3.5 pb-2.5 pt-2">
            <p className="truncate text-[12.5px] text-tx">{account.displayName}</p>
            <p className="truncate font-mono text-[10.5px] text-tx-3">{account.email}</p>
          </div>

          {/*
           * The primary navigation, always. Below `md` this is the only copy
           * — a phone header cannot hold three links, an account button, and
           * a theme toggle without overflowing, and a second disclosure
           * button beside this one would be two menus where one will do.
           *
           * Above `md` it duplicates the header bar, deliberately. The report
           * and rankings views carry their own compact header with no room
           * for a nav bar, and a reader who opened a result had no way back
           * into the product except the wordmark. Repeating three links in a
           * menu is a smaller cost than an account control that means
           * something different depending on which page you opened it from.
           */}
          <div>
            {NAV_ITEMS.map((entry) => (
              <Link
                key={entry.href}
                href={entry.href}
                role="menuitem"
                aria-current={pathname === entry.href ? 'page' : undefined}
                onClick={() => setOpen(false)}
                className={`${item} aria-[current=page]:text-tx`}
              >
                {entry.label}
              </Link>
            ))}
            <div className="my-1 border-t border-line" />
          </div>

          <button
            type="button"
            role="menuitem"
            onClick={runSignOut}
            disabled={signingOut}
            className={item}
          >
            {signingOut ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      )}
    </div>
  );
}
