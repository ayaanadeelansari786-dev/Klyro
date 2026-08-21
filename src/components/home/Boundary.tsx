'use client';

import Link from 'next/link';

import { Rosette } from '@/components/Emblem';
import { Reveal, useParallax, useReveal } from '@/components/motion';

/**
 * The boundary.
 *
 * Every line here is taken from the scanner disclosure at `/scanner`, which is
 * the authoritative version and is linked at the end of the section. It is on
 * the landing page because it is the objection: the first question anyone
 * senior asks about a tool that assesses a third party is whether running it
 * is something they are allowed to do. Answering that below the fold, in the
 * footer, in eleven point grey, is answering it too quietly.
 */

const LINES: [claim: string, detail: string][] = [
  [
    'No credentials are submitted',
    'No login is attempted, no password is guessed, and no session is established.',
  ],
  [
    'No payloads are sent',
    'Nothing is injected, fuzzed or malformed. No vulnerability is triggered or confirmed by exploitation.',
  ],
  [
    'No port scanning',
    'HTTP and HTTPS on their standard ports only, to host names the domain itself has published.',
  ],
  [
    'No state is changed',
    'Every request is a read. Nothing is created, modified, deleted or uploaded.',
  ],
  [
    'No enumeration',
    'The path list is fixed and short. Directories are not brute forced and host names are not guessed.',
  ],
  [
    'No cookie values are recorded',
    'Set-Cookie is split at the first “=” and only the name is kept, so a stranger’s session is never captured.',
  ],
];

function Line({ index, claim, detail }: { index: number; claim: string; detail: string }) {
  const { ref, shown } = useReveal<HTMLLIElement>();

  return (
    <li
      ref={ref}
      data-reveal={shown ? 'in' : ''}
      style={{ '--reveal-delay': `${index * 70}ms` } as React.CSSProperties}
      className="border-t border-line py-5"
    >
      <div className="flex items-baseline gap-3.5">
        {/* A struck-through ring: the mark for a thing deliberately not done. */}
        <svg
          width="13"
          height="13"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
          className="mt-[1px] shrink-0 text-seal"
        >
          <circle cx="8" cy="8" r="6.2" stroke="currentColor" strokeWidth="1.3" opacity="0.55" />
          <path d="M4.4 11.6 11.6 4.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
        <h3 className="text-[14.5px] font-medium leading-snug text-tx">{claim}</h3>
      </div>
      <p className="ml-[26px] mt-2 max-w-[58ch] text-[12.5px] leading-relaxed text-tx-3">{detail}</p>
    </li>
  );
}

export default function Boundary() {
  // Slower than the page and turning very slightly — an engraved ground behind
  // glass, not a graphic being flown in.
  const rosetteRef = useParallax<HTMLDivElement>(0.06, 0.008);

  return (
    <section
      aria-labelledby="boundary-heading"
      className="relative mt-24 overflow-x-clip sm:mt-32"
    >
      <div
        ref={rosetteRef}
        aria-hidden="true"
        className="pointer-events-none absolute -left-40 top-4 hidden h-[520px] w-[520px] text-seal lg:block"
      >
        <Rosette className="h-full w-full" />
      </div>

      <div className="relative grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)] lg:gap-16">
        <Reveal>
          <p className="micro">Boundaries</p>
          <h2
            id="boundary-heading"
            className="titling mt-3 max-w-[16ch] text-balance text-[28px] leading-[1.05] text-tx sm:text-[36px]"
          >
            What Klyro does not do.
          </h2>
          <p className="mt-6 max-w-[40ch] text-[13.5px] leading-relaxed text-tx-2">
            Assessing a supplier should not require a conversation with your legal team first. Klyro
            reads what the domain has already published to anyone who asks, and stops there.
          </p>
          <Link
            href="/scanner"
            className="mt-7 inline-flex items-center gap-2 text-[13px] text-seal-ink
              transition-opacity duration-150 hover:opacity-75 focus-visible:outline
              focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-seal-ink"
          >
            Every request the scanner makes
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
        </Reveal>

        <ul className="border-b border-line">
          {LINES.map(([claim, detail], i) => (
            <Line key={claim} index={i} claim={claim} detail={detail} />
          ))}
        </ul>
      </div>
    </section>
  );
}
