import { SiteHeader } from '@/components/Chrome';

/**
 * What a page looks like while its data is still being fetched.
 *
 * Every route under `/app` and `/org` is `force-dynamic` and reads two or
 * three tables before it can render anything, so a click on "Organisations"
 * used to do nothing visible at all until the whole response came back — the
 * old page just sat there. That reads as the application being slow, when
 * what is actually happening is that it has not yet been given permission to
 * say it is working.
 *
 * Next renders this the instant a navigation to those routes starts. The
 * header is real, not a placeholder, so the wordmark, navigation, and account
 * control stay exactly where they were and only the page body below them
 * changes — the transition looks like a section loading rather than the site
 * being replaced.
 *
 * The blocks below are sized to the shapes they stand in for: an eyebrow, a
 * page title, a line of metadata, and two panels. A skeleton whose proportions
 * do not match what arrives is a second layout shift dressed up as a courtesy.
 */
export default function PageLoading() {
  return (
    <main className="mx-auto w-full max-w-[1180px] px-5 py-6 sm:px-8 sm:py-8">
      <SiteHeader />

      <div aria-hidden="true" className="animate-pulse">
        <div className="pt-10 lg:pt-14">
          <div className="h-2.5 w-24 bg-line" />
          <div className="mt-5 h-9 w-[min(420px,70%)] bg-line-strong sm:h-11" />
          <div className="mt-6 h-3 w-56 bg-line" />
        </div>

        <div className="mt-10 grid gap-5 lg:grid-cols-[1.1fr_1fr]">
          <div className="panel h-[260px]" />
          <div className="panel h-[260px]" />
        </div>
      </div>

      {/* Announced once, for a reader who cannot see the blocks above. */}
      <p className="sr-only" role="status">
        Loading
      </p>
    </main>
  );
}
