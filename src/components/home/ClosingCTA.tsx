'use client';

import Link from 'next/link';

import { Reveal, useSheen } from '@/components/motion';
import { CATEGORY_ORDER, RATE_LIMIT_MAX } from '@/lib/constants';

/**
 * The way back to the one field.
 *
 * A button rather than an `href="#domain"`, because an anchor pointing at an
 * input scrolls to it and leaves the caret somewhere else — the reader arrives
 * at the field they asked for and still has to click it. This returns focus
 * with the scroll, so the next thing they type goes where they meant it to.
 */
export default function ClosingCTA() {
  const ref = useSheen<HTMLDivElement>();

  function focusDomain() {
    const field = document.getElementById('domain');
    if (!field) return;
    field.scrollIntoView({ behavior: 'smooth', block: 'center' });
    // `preventScroll` so the focus call does not fight the smooth scroll with
    // an instant jump of its own.
    field.focus({ preventScroll: true });
  }

  return (
    <Reveal>
      <section
        aria-labelledby="closing-heading"
        className="mt-24 sm:mt-32"
      >
        <div ref={ref} className="glass sheen overflow-hidden rounded-[10px] px-7 py-12 sm:px-12 sm:py-16">
          <div className="flex flex-wrap items-end justify-between gap-x-12 gap-y-8">
            <div>
              <p className="micro">Start</p>
              <h2
                id="closing-heading"
                className="titling mt-4 max-w-[16ch] text-balance text-[32px] leading-[1.02] text-tx sm:text-[44px]"
              >
                Assess a supplier before you sign, not after.
              </h2>
              <p className="mt-5 max-w-[46ch] text-[13.5px] leading-relaxed text-tx-2">
                {CATEGORY_ORDER.length} passive checks, no account required, up to {RATE_LIMIT_MAX}{' '}
                assessments an hour.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <button type="button" onClick={focusDomain} className="btn-seal px-7 py-3 text-[14px]">
                Enter a domain
                <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path
                    d="M8 3v9.5M4.5 9 8 12.5 11.5 9"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
              <Link href="/rankings" className="btn-ghost px-5 py-3 text-[13px]">
                See the benchmark dataset
              </Link>
            </div>
          </div>
        </div>
      </section>
    </Reveal>
  );
}
