'use client';

import { useRef, useState } from 'react';

import { Reveal } from '@/components/motion';

/**
 * The anatomy of a finding, as the thing to look at rather than a screenshot.
 *
 * Every landing page in this category shows a dashboard image. An image proves
 * nothing about the writing, and the writing is the product: Klyro's claim is
 * that it separates what it measured from what that means from what could
 * follow from it, and never lets the three blur into a single confident
 * sentence. That separation is only demonstrable by showing the four fields
 * apart from each other — which is exactly what this does.
 *
 * The copy is verbatim from `src/lib/checks/email-security.ts`, with the
 * domain substituted. It is not marketing text written to look like output; it
 * is the output. `example.com` is the reserved documentation domain, so the
 * example cannot be mistaken for a real assessment of anyone.
 */

const EXAMPLE_DOMAIN = 'example.com';

const PARTS = [
  {
    key: 'observed',
    label: 'Observed',
    gloss: 'What Klyro measured. No inference attached.',
    body: `A TXT query for ${EXAMPLE_DOMAIN} returned no record beginning with v=spf1. Absence was confirmed against a second resolver before being reported.`,
  },
  {
    key: 'interpretation',
    label: 'Interpretation',
    gloss: 'What the observation reasonably indicates.',
    body:
      'The domain does not declare which servers are authorised to send mail using it in the envelope sender. Receiving servers therefore have no SPF result to evaluate — they get a “none” result, which is not a failure and does not by itself cause mail to be rejected.',
  },
  {
    key: 'risk',
    label: 'Risk',
    gloss: 'What could follow. The one field in the conditional voice.',
    body:
      'SPF is one of the two mechanisms DMARC can authenticate against. With no SPF record and no DKIM signature, a DMARC policy has nothing to pass, so enforcement cannot be introduced without first breaking legitimate mail. In the meantime, forged mail using this domain in the envelope sender has no authentication result working against it at the receiving server.',
  },
  {
    key: 'recommendation',
    label: 'Recommendation',
    gloss: 'The shortest path out, and the part usually missed.',
    body:
      'Publish an SPF record listing the legitimate sending services and ending in `-all`, for example `v=spf1 include:<provider> -all`. Confirm the full list of senders first — marketing platforms and ticketing systems are the ones usually missed.',
  },
] as const;

const LIMITATION =
  'SPF authenticates the envelope sender, not the From address a recipient sees. Its absence is not by itself proof that mail can be forged convincingly.';

/**
 * Backticks in the source copy are code, and are set as code.
 *
 * The check modules write recommendations with real record syntax in them, and
 * flattening that into running text is how `-all` becomes something a reader
 * skims past instead of something they paste.
 */
function withCode(text: string) {
  return text.split('`').map((chunk, i) =>
    i % 2 === 1 ? (
      <code
        key={i}
        className="rounded border border-line bg-raised px-1.5 py-0.5 font-mono text-[0.9em] text-tx"
      >
        {chunk}
      </code>
    ) : (
      <span key={i}>{chunk}</span>
    ),
  );
}

export default function FindingAnatomy() {
  const [active, setActive] = useState(0);
  const tabsRef = useRef<(HTMLButtonElement | null)[]>([]);

  /* Roving focus, as the tab pattern requires: arrows move between tabs, Home
     and End jump to the ends, and focus follows selection. */
  function onKeyDown(event: React.KeyboardEvent) {
    const last = PARTS.length - 1;
    let next = active;

    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = active === last ? 0 : active + 1;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = active === 0 ? last : active - 1;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = last;
    else return;

    event.preventDefault();
    setActive(next);
    tabsRef.current[next]?.focus();
  }

  return (
    <section aria-labelledby="anatomy-heading" className="mt-24 sm:mt-32">
      <div className="flex flex-wrap items-end justify-between gap-x-10 gap-y-4">
        <Reveal>
          <p className="micro">What a finding looks like</p>
          <h2
            id="anatomy-heading"
            className="titling mt-3 max-w-[19ch] text-balance text-[28px] leading-[1.05] text-tx sm:text-[36px]"
          >
            Measured, interpreted and risked — never merged.
          </h2>
        </Reveal>
        <Reveal delay={90}>
          <p className="max-w-[42ch] text-[12.5px] leading-relaxed text-tx-3">
            A reader who distrusts every conclusion in the report should still be able to accept the
            first field. That is why they are four fields and not one paragraph.
          </p>
        </Reveal>
      </div>

      <Reveal delay={60}>
        <div className="glass mt-10 overflow-hidden rounded-[10px]">
          {/* The finding's own header line: what it is about, and how sure. */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-6 py-4 sm:px-8">
            {/*
             * Outlined, not filled — which is both what the dashboard actually
             * does (severity is coloured text there, never a solid badge) and
             * what the numbers require: a 10% fill of its own hue under the
             * label dropped it to 4.46:1 on paper. Removing the fill puts it
             * back at 5.13:1 and makes the example look like the product.
             */}
            <span className="inline-flex items-center gap-1.5 rounded border border-risk-high/45 px-2 py-[3px] font-mono text-[10px] uppercase tracking-[0.12em] text-risk-high">
              High
            </span>
            <span className="chip">Confidence: high</span>
            <span className="text-[12.5px] text-tx-3">Email Security</span>
            <span className="ml-auto font-mono text-[12px] text-tx-2">{EXAMPLE_DOMAIN}</span>
          </div>

          <div className="px-6 pt-6 sm:px-8 sm:pt-7">
            <h3 className="text-[19px] font-medium leading-snug text-tx sm:text-[21px]">
              No SPF record is published
            </h3>
          </div>

          <div className="grid gap-0 px-6 pb-6 pt-6 sm:px-8 sm:pb-8 lg:grid-cols-[210px_minmax(0,1fr)] lg:gap-10">
            {/* The rail. A vertical tablist on wide screens, a horizontal one
                below — the same control, laid out for the space it has. */}
            <div
              role="tablist"
              aria-label="Parts of a finding"
              aria-orientation="vertical"
              onKeyDown={onKeyDown}
              /* Wraps rather than scrolls below `lg`. A horizontally scrolling
                 rail with the scrollbar suppressed hides its own fourth tab
                 behind a gesture nothing on screen suggests — and the fourth
                 tab here is the recommendation, which is the one worth reading. */
              className="flex flex-wrap gap-x-1 lg:flex-col lg:flex-nowrap lg:gap-x-0"
            >
              {PARTS.map((part, i) => {
                const selected = i === active;
                return (
                  <button
                    key={part.key}
                    ref={(el) => {
                      tabsRef.current[i] = el;
                    }}
                    type="button"
                    role="tab"
                    id={`anatomy-tab-${part.key}`}
                    aria-selected={selected}
                    aria-controls={`anatomy-panel-${part.key}`}
                    tabIndex={selected ? 0 : -1}
                    onClick={() => setActive(i)}
                    className={`relative shrink-0 whitespace-nowrap border-line py-2.5 pr-5 text-left
                      text-[13px] transition-colors duration-200 focus-visible:outline
                      focus-visible:outline-2 focus-visible:outline-offset-2
                      focus-visible:outline-seal-ink lg:w-full lg:border-l-2 lg:py-3 lg:pl-4 lg:pr-0
                      ${
                        selected
                          ? 'font-medium text-tx lg:border-l-seal'
                          : 'text-tx-3 hover:text-tx-2 lg:border-l-transparent'
                      }`}
                  >
                    <span className="font-mono text-[9.5px] uppercase tracking-[0.16em]">
                      {String(i + 1).padStart(2, '0')}
                    </span>
                    <span className="ml-2.5">{part.label}</span>
                    {/* Underline for the narrow layout, where the left rule has
                        nowhere to sit. */}
                    <span
                      aria-hidden="true"
                      className={`absolute inset-x-0 bottom-0 h-px origin-left bg-seal transition-transform
                        duration-300 lg:hidden ${selected ? 'scale-x-100' : 'scale-x-0'}`}
                    />
                  </button>
                );
              })}
            </div>

            {/* min-h keeps the panel from resizing as the reader moves between
                parts of unequal length, which would push the page under them. */}
            <div className="mt-7 min-h-[210px] lg:mt-0 lg:min-h-[188px]">
              {PARTS.map((part, i) => (
                <div
                  key={part.key}
                  role="tabpanel"
                  id={`anatomy-panel-${part.key}`}
                  aria-labelledby={`anatomy-tab-${part.key}`}
                  hidden={i !== active}
                >
                  <p className="micro">{part.gloss}</p>
                  <p className="mt-4 max-w-[64ch] text-[14.5px] leading-[1.72] text-tx-2">
                    {withCode(part.body)}
                  </p>
                </div>
              ))}
            </div>
          </div>

          {/*
           * The limitation, always on screen rather than behind a tab.
           *
           * It is the field that says what this test cannot establish, and a
           * caveat the reader has to click to find is a caveat the product does
           * not really mean. Every finding that has one renders it this way.
           */}
          <div className="border-t border-line bg-raised/60 px-6 py-4 sm:px-8">
            <p className="max-w-[78ch] text-[12px] leading-relaxed text-tx-3">
              <span className="font-mono text-[9.5px] uppercase tracking-[0.16em] text-seal-ink">
                Limitation
              </span>
              {/* A real space, not only the margin. The gap is visual; without
                  the text node a screen reader reads "LimitationSPF". */}{' '}
              <span className="ml-2">{LIMITATION}</span>
            </p>
          </div>
        </div>
      </Reveal>

      <Reveal delay={40}>
        <p className="mt-4 text-[11.5px] text-tx-3">
          Example output, reproduced from the email-security module. {EXAMPLE_DOMAIN} is the
          reserved documentation domain — no real assessment is shown here.
        </p>
      </Reveal>
    </section>
  );
}
