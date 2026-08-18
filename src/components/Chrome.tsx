import Link from 'next/link';

/**
 * The mark is a three-bar signal meter — the same visual grammar the score
 * bars use throughout the product, at 14px.
 */
export function Wordmark({ href = '/' }: { href?: string | null }) {
  const inner = (
    <span className="inline-flex items-center gap-2.5">
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
        <rect x="0" y="8" width="3" height="6" fill="currentColor" opacity="0.35" />
        <rect x="5" y="4" width="3" height="10" fill="currentColor" opacity="0.65" />
        <rect x="10" y="0" width="3" height="14" fill="currentColor" />
      </svg>
      <span className="font-mono text-[13px] font-medium uppercase tracking-[0.26em] text-tx">
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
          <Link
            href="/scanner"
            className="text-[11.5px] text-tx-3 transition-colors duration-150 hover:text-tx-2"
          >
            What the scanner requests
          </Link>
        </div>
        <p className="max-w-xl text-[11.5px] leading-relaxed text-tx-3">
          {children ??
            'Passive reconnaissance using publicly available information only. No systems are accessed, scanned for vulnerabilities, or tested.'}
        </p>
      </div>
    </footer>
  );
}
