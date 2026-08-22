'use client';

import Link from 'next/link';

import { Reveal, useReveal } from '@/components/motion';
import { VALIDATIONS } from '@/lib/validations';

/**
 * The validation strip.
 *
 * Every landing page in this category asks to be believed on tone. This asks
 * to be checked instead: three rows lifted verbatim from the "Track record"
 * table on `/methodology`, which is the single source both pages read — see
 * `src/lib/validations.ts` and the pin in `tests/home-page.test.ts`. Two
 * outcomes are shown rather than only the flattering one, because a strip
 * that quoted only the times Klyro was right would be doing the exact thing
 * this product exists to catch other tools doing.
 */
const FEATURED = VALIDATIONS.slice(0, 3);

const OUTCOME_LABEL: Record<'match' | 'fixed', string> = {
  match: 'Held up',
  fixed: 'Klyro was wrong',
};

function Row({ index, validation }: { index: number; validation: (typeof VALIDATIONS)[number] }) {
  const { ref, shown } = useReveal<HTMLLIElement>();

  return (
    <li
      ref={ref}
      data-reveal={shown ? 'in' : ''}
      style={{ '--reveal-delay': `${index * 80}ms` } as React.CSSProperties}
      className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-t border-line py-3.5 first:border-t-0"
    >
      <span
        className={`shrink-0 font-mono text-[9.5px] font-medium uppercase tracking-[0.13em] ${
          validation.outcome === 'match' ? 'text-risk-good' : 'text-risk-warn'
        }`}
      >
        {OUTCOME_LABEL[validation.outcome]}
      </span>
      <span className="font-mono text-[11.5px] text-tx-3">{validation.domain}</span>
      <span className="min-w-0 flex-1 basis-full text-[12.5px] leading-relaxed text-tx-2 sm:basis-0">
        {validation.result}
      </span>
    </li>
  );
}

export default function ValidationStrip() {
  return (
    <Reveal>
      <section aria-labelledby="validation-heading" className="mt-24 sm:mt-32">
        <div className="flex flex-wrap items-end justify-between gap-x-10 gap-y-4">
          <div>
            <p className="micro">Track record</p>
            <h2
              id="validation-heading"
              className="titling mt-3 max-w-[20ch] text-balance text-[28px] leading-[1.05] text-tx sm:text-[36px]"
            >
              Checked against sources Klyro does not control.
            </h2>
          </div>
          <Link
            href="/methodology#validation"
            className="inline-flex items-center gap-2 text-[13px] text-seal-ink
              transition-opacity duration-150 hover:opacity-75 focus-visible:outline
              focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-seal-ink"
          >
            The full record
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M3 8h9.5M9 4.5 12.5 8 9 11.5"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </Link>
        </div>

        <ul className="mt-8 border-b border-line">
          {FEATURED.map((validation, i) => (
            <Row key={`${validation.domain}-${validation.finding}`} index={i} validation={validation} />
          ))}
        </ul>
      </section>
    </Reveal>
  );
}
