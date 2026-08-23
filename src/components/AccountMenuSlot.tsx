'use client';

import dynamic from 'next/dynamic';

/**
 * The account control, loaded after the page is.
 *
 * `AccountMenu` reaches for the Supabase browser client, which is not small.
 * Imported normally it lands in the first-load bundle of every page that
 * renders a header — including `/methodology` and `/scanner`, which are
 * static documents that will never ask who is signed in until somebody has
 * already read them. Measured, that was about seventy kilobytes added to
 * pages that had no other reason to carry it.
 *
 * Deferring it costs nothing that matters. The control resolves
 * asynchronously anyway — it cannot know who is signed in until it has asked
 * — so a chunk that arrives just after hydration is early enough, and the
 * space it will occupy is already reserved by the fallback below.
 *
 * `ssr: false` because there is nothing to render on the server: the session
 * lives in the browser, which is the whole point of resolving it there. This
 * wrapper exists only because `next/dynamic` with `ssr: false` cannot be
 * called from a Server Component, and `Chrome.tsx` is one.
 */
const AccountMenu = dynamic(() => import('@/components/AccountMenu'), {
  ssr: false,
  /*
   * The same shape and width the signed-out control settles into, so the
   * header does not move when the real one arrives. Not the real markup: a
   * link that navigates to `/login` should not exist before the code that
   * knows whether the reader is already signed in.
   */
  loading: () => (
    <div aria-hidden="true" className="flex items-center gap-4 sm:gap-5">
      <span className="text-[12.5px] text-transparent">Sign in</span>
      <span className="btn-ghost pointer-events-none border-transparent px-3 py-1.5 text-[12.5px] text-transparent">
        Create account
      </span>
    </div>
  ),
});

export default function AccountMenuSlot() {
  return <AccountMenu />;
}
