'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState } from 'react';

import { getBrowserClient } from '@/lib/supabase/browser';

/**
 * Who is signed in, and the way out.
 *
 * Resolved in the browser rather than on the server, which is a deliberate
 * trade. The landing page is the one statically prerendered route in the app
 * and it is the page most people arrive on; reading the session server-side
 * would make it render per request and give up its CDN cache to decide
 * whether to draw a name in the corner. So this asks the browser instead, and
 * the page stays static.
 *
 * The cost is a moment before the answer arrives. It is covered by rendering
 * the signed-out control itself, made invisible, rather than a guessed-width
 * box: a visitor who turns out to be signed out — the common case on a
 * landing page — sees the header settle with no movement at all, at every
 * breakpoint, because the space held was the real markup. A visitor who turns
 * out to be signed in sees one small collapse as the two links give way to a
 * shorter name. That shift is not avoidable without rendering the page on the
 * server, which is the trade this whole approach declines.
 *
 * `onAuthStateChange` is subscribed to rather than the session being read
 * once. Signing out in another tab, or a token expiring mid-session, both
 * leave a header claiming somebody is signed in who is not — and the one
 * place that must never be wrong is the control that says whose data you are
 * looking at.
 */

interface Account {
  email: string;
  displayName: string;
}

function accountFrom(user: { email?: string; user_metadata?: Record<string, unknown> } | null): Account | null {
  if (!user?.email) return null;

  const raw = user.user_metadata?.display_name;
  const named = typeof raw === 'string' ? raw.trim() : '';

  return {
    email: user.email,
    // The local part is a poor name and a good fallback: it is what the person
    // typed, and it beats rendering an empty button.
    displayName: named || user.email.split('@')[0],
  };
}

export default function AccountMenu() {
  const router = useRouter();
  const supabase = getBrowserClient();

  /* `undefined` is "not asked yet" and renders the placeholder; `null` is a
     settled answer of nobody. Collapsing the two would flash the signed-out
     links at every signed-in visitor on every page load. */
  const [account, setAccount] = useState<Account | null | undefined>(
    supabase ? undefined : null,
  );
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemsRef = useRef<(HTMLAnchorElement | HTMLButtonElement | null)[]>([]);
  const menuId = useId();

  useEffect(() => {
    if (!supabase) return;
    let live = true;

    supabase.auth.getUser().then(({ data }) => {
      if (live) setAccount(accountFrom(data.user));
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (live) setAccount(accountFrom(session?.user ?? null));
    });

    return () => {
      live = false;
      sub.subscription.unsubscribe();
    };
  }, [supabase]);

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
    if (open) itemsRef.current[0]?.focus();
  }, [open]);

  function onMenuKeyDown(event: React.KeyboardEvent) {
    const items = itemsRef.current.filter(Boolean) as HTMLElement[];
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      items[(at + 1) % items.length]?.focus();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      items[(at - 1 + items.length) % items.length]?.focus();
    }
  }

  async function signOut() {
    if (!supabase) return;
    setSigningOut(true);
    try {
      await supabase.auth.signOut();
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

  // Accounts are not configured for this deployment. Assessments still run, so
  // the header simply says nothing about them rather than offering a door into
  // a panel that would explain it cannot sign anyone in.
  if (!supabase) return null;

  // Asked, not yet answered — and once answered, nobody. The same markup
  // serves both, so the settled signed-out header occupies exactly the space
  // the pending one reserved.
  if (account === undefined || account === null) {
    const pending = account === undefined;
    return (
      <div
        className={`flex items-center gap-4 sm:gap-5 ${pending ? 'invisible' : ''}`}
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

          <Link
            ref={(el) => {
              itemsRef.current[0] = el;
            }}
            href="/app"
            role="menuitem"
            onClick={() => setOpen(false)}
            className={item}
          >
            Your assessments
          </Link>
          <Link
            ref={(el) => {
              itemsRef.current[1] = el;
            }}
            href="/org"
            role="menuitem"
            onClick={() => setOpen(false)}
            className={item}
          >
            Organisations
          </Link>

          <div className="my-1 border-t border-line" />

          <button
            ref={(el) => {
              itemsRef.current[2] = el;
            }}
            type="button"
            role="menuitem"
            onClick={signOut}
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
