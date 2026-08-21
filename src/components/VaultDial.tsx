'use client';

import { useEffect, useRef, useState } from 'react';

import { Reveal } from '@/components/motion';
import { CATEGORY_BLURBS, CATEGORY_LABELS, CATEGORY_ORDER, CATEGORY_WEIGHTS } from '@/lib/constants';

/**
 * The dial.
 *
 * A drum standing on its side, carrying one face per check. As the reader
 * moves down the ledger beside it, the drum turns to whichever check they have
 * reached — so the thing that moves is an index into content that is already
 * on the page, not an animation playing at them.
 *
 * Two departures from the original brief, both load-bearing:
 *
 * 1. It is not in the hero. A hero is one viewport tall, and eleven detents
 *    need real scroll distance to land as detents rather than as a blur. The
 *    only ways to fit them into a hero are to autoplay the rotation, which the
 *    brief rules out, or to make the hero tall enough to push the domain field
 *    under the fold, which the brief also rules out. Below the fold there is
 *    as much runway as the ledger is long, and the scan form keeps the
 *    strongest position on the page.
 *
 * 2. The metaphor is a dial being *read*, not a lock being picked. A
 *    combination being cracked is the attacker's side of the story, and this
 *    product is sold to the defender.
 *
 * Everything it displays comes from CATEGORY_ORDER, CATEGORY_LABELS,
 * CATEGORY_BLURBS and CATEGORY_WEIGHTS. There is no second list to drift.
 */

const FACES = CATEGORY_ORDER;
export const STEP = 360 / FACES.length;

/** Half the drum's height, in px — the radius the faces stand out at. */
const RADIUS = 132;

/**
 * How far the drum is turned to bring face `active` to the front, and how far
 * any face then is from the reader.
 *
 * Split out as plain arithmetic so it can be tested without a browser. The
 * rotation itself cannot be exercised in a headless run — it is driven by an
 * IntersectionObserver, which needs a page that is actually being composited —
 * so the part that *can* be checked is checked.
 */
export function drumTurnDeg(active: number): number {
  // `|| 0` normalises the negative zero that `-0 * STEP` produces. It renders
  // identically in CSS, but it is a value nothing downstream should have to
  // know about.
  return -active * STEP || 0;
}

/** 0 for the face at the front, rising to 5 for the one furthest round. */
export function faceDistance(index: number, active: number, count = FACES.length): number {
  const raw = Math.abs(index - active);
  return Math.min(raw, count - raw);
}

export function faceOpacity(distance: number): number {
  return distance === 0 ? 1 : distance === 1 ? 0.3 : 0.1;
}

export default function VaultDial() {
  const [active, setActive] = useState(0);
  const rowsRef = useRef<(HTMLLIElement | null)[]>([]);

  /*
   * Which row is under the reader's eye, rather than which row is merely on
   * screen. The band is a thin slice across the middle of the viewport: a row
   * becomes active when it crosses that line, so the drum advances once per
   * check instead of thrashing between two of them at the boundary.
   */
  useEffect(() => {
    const rows = rowsRef.current.filter(Boolean) as HTMLLIElement[];
    if (rows.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const index = rows.indexOf(entry.target as HTMLLIElement);
          if (index >= 0) setActive(index);
        }
      },
      { rootMargin: '-48% 0px -48% 0px', threshold: 0 },
    );

    rows.forEach((row) => observer.observe(row));
    return () => observer.disconnect();
  }, []);

  return (
    <section aria-labelledby="checks-heading" className="mt-24 sm:mt-32">
      {/*
       * `items-end`, not `items-baseline`. Baseline alignment between a 36px
       * Didone and a 12.5px note puts the note's first line on the heading's
       * baseline and leaves it floating at the top of a two-line block; ending
       * them together is what actually reads as one row.
       */}
      <div className="flex flex-wrap items-end justify-between gap-x-10 gap-y-4">
        <Reveal>
          <p className="micro">What is measured</p>
          <h2
            id="checks-heading"
            className="titling mt-3 max-w-[18ch] text-balance text-[28px] leading-[1.05] text-tx sm:text-[36px]"
          >
            {FACES.length} checks, weighted by consequence
          </h2>
        </Reveal>
        <Reveal delay={90}>
          <p className="max-w-[44ch] text-[12.5px] leading-relaxed text-tx-3">
            Each check scores out of 100. The composite is their weighted average — a check whose
            source is unreachable is dropped and the rest renormalised, never counted as a failure.
          </p>
        </Reveal>
      </div>

      <div className="mt-12 grid gap-10 lg:grid-cols-[300px_minmax(0,1fr)] lg:gap-16">
        {/*
         * The drum. Hidden below `lg` rather than reimplemented: at 380px there
         * is no width for a cylinder that is legible, and the ledger to its
         * right already carries every name, weight and description the drum
         * shows. A stacked-card port of it would be the same eleven rows
         * twice.
         */}
        <div className="hidden lg:block">
          <div className="sticky top-28">
            <div
              className="dial relative h-[264px] w-full select-none"
              aria-hidden="true"
              style={
                {
                  '--dial-turn': `${drumTurnDeg(active)}deg`,
                  '--dial-radius': `${RADIUS}px`,
                } as React.CSSProperties
              }
            >
              {/* The index: a fixed mark the drum turns beneath. */}
              <div className="pointer-events-none absolute inset-y-0 left-0 z-10 flex items-center">
                <span className="h-[46px] w-px bg-seal" />
                <span className="ml-2 h-1.5 w-1.5 rounded-full bg-seal" />
              </div>

              <div className="dial-drum">
                {FACES.map((key, i) => {
                  const delta = faceDistance(i, active);
                  return (
                    <div
                      key={key}
                      className="dial-face pl-7"
                      style={
                        {
                          '--face-angle': `${i * STEP}deg`,
                          '--face-opacity': faceOpacity(delta),
                        } as React.CSSProperties
                      }
                    >
                      <span className="font-mono text-[10px] tracking-[0.16em] text-seal-ink">
                        {String(i + 1).padStart(2, '0')}
                      </span>
                      <span className="titling mt-2 block text-[24px] leading-[1.05] text-tx">
                        {CATEGORY_LABELS[key]}
                      </span>
                      <span className="mt-2 block font-mono text-[11px] text-tx-2">
                        {Math.round(CATEGORY_WEIGHTS[key] * 100)}% of the composite
                      </span>
                    </div>
                  );
                })}
              </div>

              {/* Shoulders: the drum reads as a solid object only if its top
                  and bottom fall away into the page. */}
              <div className="pointer-events-none absolute inset-x-0 top-0 h-16 bg-gradient-to-b from-ground to-transparent" />
              <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-ground to-transparent" />
            </div>
          </div>
        </div>

        {/*
         * The ledger. This is the content; the drum is an index into it. It is
         * a plain list, present and complete with no JavaScript, at every
         * width, and under reduced-motion.
         *
         * Each row is a three-column grid rather than a flex row with the
         * description pushed across by `ml-[30px]`. That number was an attempt
         * to guess the rendered width of a two-digit mono number plus its gap,
         * so the description's left edge only ever agreed with the title's by
         * coincidence — and stopped agreeing the moment the mono face fell back
         * or the size changed. On a grid the two share a column and cannot
         * disagree.
         */}
        <ol className="border-t border-line">
          {FACES.map((key, i) => {
            const current = i === active;
            return (
              <li
                key={key}
                ref={(el) => {
                  rowsRef.current[i] = el;
                }}
                className={`grid grid-cols-[2.25rem_minmax(0,1fr)_auto] items-baseline gap-x-3
                  border-b border-line py-5 transition-colors duration-300 lg:border-l-2 lg:pl-5 ${
                    current ? 'lg:border-l-seal lg:bg-tx/[0.02]' : 'lg:border-l-transparent'
                  }`}
              >
                <span
                  className={`font-mono text-[10.5px] tabular-nums transition-colors duration-300 ${
                    current ? 'text-seal-ink' : 'text-tx-3'
                  }`}
                >
                  {String(i + 1).padStart(2, '0')}
                </span>
                <h3 className="text-[15px] font-medium leading-tight text-tx">
                  {CATEGORY_LABELS[key]}
                </h3>
                <span className="shrink-0 font-mono text-[11.5px] tabular-nums text-tx-2">
                  {Math.round(CATEGORY_WEIGHTS[key] * 100)}%
                </span>

                <p className="col-span-2 col-start-2 mt-2 max-w-[62ch] text-[12.5px] leading-relaxed text-tx-3">
                  {CATEGORY_BLURBS[key]}
                </p>
              </li>
            );
          })}
        </ol>
      </div>
    </section>
  );
}
