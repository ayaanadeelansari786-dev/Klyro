'use client';

import { Reveal, useReveal } from '@/components/motion';
import { CATEGORY_ORDER } from '@/lib/constants';

/**
 * Three steps, numbered — and numbered honestly.
 *
 * Numbered markers are the house style of every generic landing page, and are
 * usually decoration standing in for structure. Here the sequence is real:
 * nothing can be measured before a domain is given, and nothing can be scored
 * before it is measured. The numbers encode an order the reader will actually
 * experience, which is the only thing that earns them.
 */

const STEPS: { title: string; body: string; aside: string }[] = [
  {
    title: 'You give it a domain',
    body:
      'Nothing is installed and no access is granted. Klyro never asks the vendor for permission, because it never asks the vendor for anything — the assessment runs entirely against what the domain has already published.',
    aside: 'No agent · no credentials',
  },
  {
    title: `${CATEGORY_ORDER.length} checks read public sources`,
    body:
      'Resolvers, certificate transparency logs, the registry’s RDAP service, and ordinary anonymous web requests to endpoints the domain publishes itself. A source that will not answer is dropped and the remaining weights renormalised — never counted as a failure.',
    aside: '20–45 seconds',
  },
  {
    title: 'You get a score, a rank, and two documents',
    body:
      'One composite out of 100, every finding split into what was observed, what it indicates and what to do — plus the full report and a one-page plain-language summary for whoever signs off without reading the rest.',
    aside: 'Ranked against the dataset',
  },
];

function Step({ index, step }: { index: number; step: (typeof STEPS)[number] }) {
  const { ref, shown } = useReveal<HTMLLIElement>();

  return (
    <li
      ref={ref}
      data-reveal={shown ? 'in' : ''}
      style={{ '--reveal-delay': `${index * 110}ms` } as React.CSSProperties}
      className="lift glass h-full rounded-[10px] p-6 sm:p-7"
    >
      <div className="flex items-baseline justify-between gap-4">
        <span className="font-mono text-[11px] tabular-nums tracking-[0.16em] text-seal-ink">
          {String(index + 1).padStart(2, '0')}
        </span>
        <span className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-tx-3">
          {step.aside}
        </span>
      </div>

      <h3 className="mt-5 text-[17px] font-medium leading-snug text-tx">{step.title}</h3>
      <p className="mt-3 text-[13px] leading-relaxed text-tx-2">{step.body}</p>
    </li>
  );
}

export default function HowItWorks() {
  const { ref, shown } = useReveal<HTMLDivElement>();

  return (
    <section aria-labelledby="how-heading" className="mt-24 sm:mt-32">
      <Reveal>
        <p className="micro">How it runs</p>
        <h2
          id="how-heading"
          className="titling mt-3 max-w-[20ch] text-balance text-[28px] leading-[1.05] text-tx sm:text-[36px]"
        >
          One field in. A defensible document out.
        </h2>
      </Reveal>

      {/*
       * The rail the three steps hang from, drawn left to right once the row is
       * in view. It is the only ornament in the section and it is doing a job:
       * it says these are one sequence rather than three unrelated cards.
       */}
      <div ref={ref} className="relative mt-12 pt-8">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 hidden h-px origin-left bg-line
            transition-transform duration-[1100ms] ease-[cubic-bezier(0.16,1,0.3,1)] md:block"
          style={{ transform: `scaleX(${shown ? 1 : 0})` }}
        />

        <ol className="grid gap-4 md:grid-cols-3 md:gap-5">
          {STEPS.map((step, i) => (
            <Step key={step.title} index={i} step={step} />
          ))}
        </ol>
      </div>
    </section>
  );
}
