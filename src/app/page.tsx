import Link from 'next/link';

import { PageFooter, Wordmark } from '@/components/Chrome';
import ScanForm from '@/components/ScanForm';
import { CATEGORY_BLURBS, CATEGORY_LABELS, CATEGORY_ORDER, CATEGORY_WEIGHTS } from '@/lib/constants';

/** Heaviest check first — the ledger is about what the score is made of. */
const BY_WEIGHT = [...CATEGORY_ORDER].sort((a, b) => CATEGORY_WEIGHTS[b] - CATEGORY_WEIGHTS[a]);
const MAX_WEIGHT = Math.max(...Object.values(CATEGORY_WEIGHTS));

export default function HomePage() {
  return (
    <main className="mx-auto w-full max-w-[1180px] px-5 py-6 sm:px-8 sm:py-8">
      <header className="flex items-center justify-between">
        <Wordmark href={null} />
        <nav className="flex items-center gap-6">
          <Link
            href="/rankings"
            className="text-[12.5px] text-tx-2 transition-colors duration-150 hover:text-tx"
          >
            Benchmark dataset
          </Link>
          <span className="micro hidden sm:inline">External exposure assessment</span>
        </nav>
      </header>

      {/* Hero — statement left, the instrument itself right. */}
      <div className="grid items-start gap-10 py-16 lg:grid-cols-[1fr_minmax(430px,520px)] lg:gap-14 lg:py-24">
        <div className="animate-rise">
          <p className="micro">Passive reconnaissance</p>

          <h1 className="wide mt-6 max-w-[13ch] text-balance text-[46px] font-semibold leading-[0.94] tracking-[-0.035em] text-tx sm:text-[62px]">
            Everything an attacker learns before they touch you.
          </h1>

          <p className="mt-7 max-w-[46ch] text-[15px] leading-relaxed text-tx-2">
            Klyro assesses what your domain publishes to the open internet — certificates, mail
            authentication, exposed paths, subdomains — and returns one composite score, ranked
            against the vendors in our benchmark dataset, as an executive PDF.
          </p>

          <dl className="mt-10 flex flex-wrap gap-x-12 gap-y-6">
            {[
              ['10', 'checks'],
              ['~20s', 'to assess'],
              ['0', 'packets of intrusion'],
            ].map(([value, label]) => (
              <div key={label}>
                <dt className="num text-[30px] font-semibold leading-none text-tx">{value}</dt>
                <dd className="micro mt-2">{label}</dd>
              </div>
            ))}
          </dl>
        </div>

        <div className="animate-rise" style={{ animationDelay: '0.08s' }}>
          <ScanForm />
        </div>
      </div>

      {/* Weight ledger — the composite, itemised. */}
      <section className="panel overflow-hidden">
        <div className="flex flex-wrap items-baseline justify-between gap-3 px-6 py-5 sm:px-8">
          <div>
            <p className="micro">What is measured</p>
            <h2 className="mt-2 text-[17px] font-semibold tracking-tight text-tx">
              Eleven checks, weighted by consequence
            </h2>
          </div>
          <p className="max-w-[42ch] text-[12px] leading-relaxed text-tx-3">
            Each check scores out of 100. The composite is their weighted average — a check whose
            source is unreachable is dropped and the rest renormalised, never counted as a failure.
          </p>
        </div>

        <ul className="stagger grid grid-cols-1 border-t border-line md:grid-cols-2">
          {BY_WEIGHT.map((key, i) => (
            <li
              key={key}
              className={`group flex items-center gap-5 border-t border-line px-6 py-4 sm:px-8 ${
                i % 2 === 0 ? 'md:border-r' : ''
              } ${i === 0 ? 'border-t-0' : ''} ${i === 1 ? 'md:border-t-0' : ''}`}
            >
              <span className="font-mono text-[10.5px] text-tx-3 tabular-nums">
                {String(i + 1).padStart(2, '0')}
              </span>

              <div className="min-w-0 flex-1">
                <p className="text-[13.5px] font-medium leading-tight text-tx">
                  {CATEGORY_LABELS[key]}
                </p>
                <p className="mt-1 truncate text-[11.5px] leading-relaxed text-tx-3">
                  {CATEGORY_BLURBS[key]}
                </p>
              </div>

              <div className="flex w-[104px] shrink-0 items-center gap-3">
                <div className="h-[3px] flex-1 bg-line">
                  <div
                    className="h-full origin-left animate-sweep bg-tx-2 transition-colors duration-150 group-hover:bg-tx"
                    style={{ width: `${(CATEGORY_WEIGHTS[key] / MAX_WEIGHT) * 100}%` }}
                  />
                </div>
                <span className="w-8 shrink-0 text-right font-mono text-[11.5px] text-tx-2 tabular-nums">
                  {Math.round(CATEGORY_WEIGHTS[key] * 100)}%
                </span>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <PageFooter />
    </main>
  );
}
