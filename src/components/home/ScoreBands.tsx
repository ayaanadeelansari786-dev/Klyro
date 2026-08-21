'use client';

import { useId, useState } from 'react';

import { Reveal } from '@/components/motion';
import { CATEGORY_ORDER } from '@/lib/constants';
import { ratingFor, riskColorFor, riskLevelFor } from '@/lib/scoring';

/**
 * How to read the composite, by moving it.
 *
 * The bands are not restated here — they are read out of `riskLevelFor`,
 * `ratingFor` and `riskColorFor`, the same three functions that label every
 * real assessment and every page of the PDF. A hardcoded "80+ is low risk" on
 * a landing page is a second source of truth that goes stale the first time
 * the thresholds are tuned, and goes stale silently, in the one place a
 * prospective customer is looking.
 *
 * The cost is that this pulls `@/lib/scoring` into the client bundle. It is
 * pure arithmetic over constants with no server dependency, and the guarantee
 * is worth more than the kilobytes.
 */

/* Where the bands actually change, derived by asking rather than by knowing. */
const EDGES = (() => {
  const found: number[] = [];
  for (let score = 1; score <= 100; score += 1) {
    if (riskLevelFor(score) !== riskLevelFor(score - 1)) found.push(score);
  }
  return found;
})();

const RADIUS = 88;
const ARC = Math.PI * RADIUS;

export default function ScoreBands() {
  const [score, setScore] = useState(72);
  const id = useId();

  const level = riskLevelFor(score);
  const rating = ratingFor(score);
  const hue = `rgb(var(--risk-${riskColorFor(score)}))`;

  return (
    <section aria-labelledby="bands-heading" className="mt-24 sm:mt-32">
      <div className="flex flex-wrap items-end justify-between gap-x-10 gap-y-4">
        <Reveal>
          <p className="micro">Reading the number</p>
          <h2
            id="bands-heading"
            className="titling mt-3 max-w-[18ch] text-balance text-[28px] leading-[1.05] text-tx sm:text-[36px]"
          >
            One composite, and what it commits to.
          </h2>
        </Reveal>
        <Reveal delay={90}>
          <p className="max-w-[42ch] text-[12.5px] leading-relaxed text-tx-3">
            Drag it. The band and the rating below come from the same functions that label a real
            assessment, so this cannot disagree with the report you receive.
          </p>
        </Reveal>
      </div>

      <Reveal delay={60}>
        <div className="glass mt-10 grid gap-10 rounded-[10px] p-7 sm:p-10 lg:grid-cols-[300px_minmax(0,1fr)] lg:gap-14">
          {/* The gauge. A half turn, because a score out of 100 has two ends
              and a full ring hides where they are. */}
          <div className="flex flex-col items-center">
            <svg
              viewBox="0 0 220 124"
              className="w-full max-w-[280px]"
              role="img"
              aria-label={`${score} out of 100 — ${level}`}
            >
              <path
                d={`M 22 110 A ${RADIUS} ${RADIUS} 0 0 1 198 110`}
                fill="none"
                stroke="rgb(var(--line))"
                strokeWidth={10}
                strokeLinecap="round"
              />
              <path
                d={`M 22 110 A ${RADIUS} ${RADIUS} 0 0 1 198 110`}
                fill="none"
                stroke={hue}
                strokeWidth={10}
                strokeLinecap="round"
                strokeDasharray={ARC}
                strokeDashoffset={ARC * (1 - score / 100)}
                style={{ transition: 'stroke-dashoffset 260ms ease-out, stroke 260ms ease-out' }}
              />
              {/* Band edges, marked on the arc itself so the thresholds are
                  visible rather than asserted underneath. */}
              {EDGES.map((edge) => {
                const angle = Math.PI * (1 - edge / 100);
                const cx = 110 + Math.cos(angle) * RADIUS;
                const cy = 110 - Math.sin(angle) * RADIUS;
                return (
                  <line
                    key={edge}
                    x1={110 + Math.cos(angle) * (RADIUS - 7)}
                    y1={110 - Math.sin(angle) * (RADIUS - 7)}
                    x2={cx + Math.cos(angle) * 7}
                    y2={cy - Math.sin(angle) * 7}
                    stroke="rgb(var(--ground))"
                    strokeWidth={2.5}
                  />
                );
              })}
            </svg>

            <div className="-mt-9 flex flex-col items-center">
              <span
                className="num wide text-[54px] font-semibold leading-none"
                style={{ color: hue }}
              >
                {score}
              </span>
              <span className="micro mt-2.5">out of 100</span>
            </div>

            <label htmlFor={id} className="sr-only">
              Composite score
            </label>
            <input
              id={id}
              type="range"
              min={0}
              max={100}
              value={score}
              aria-valuetext={`${score}, ${level}, rated ${rating}`}
              onChange={(e) => setScore(Number(e.target.value))}
              className="score-range mt-7 w-full max-w-[280px]"
              style={{ '--range-hue': hue } as React.CSSProperties}
            />
          </div>

          <div>
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-2">
              <span className="titling text-[30px] leading-none text-tx sm:text-[34px]">
                {level}
              </span>
              <span className="chip">Rated {rating}</span>
            </div>

            <p className="mt-5 max-w-[54ch] text-[13.5px] leading-relaxed text-tx-2">
              The composite is the weighted average of the {CATEGORY_ORDER.length} checks. Where a source could
              not be reached, that check is dropped and the remaining weights are renormalised, so a
              score is always out of what could actually be assessed — and the coverage achieved is
              printed beside it rather than folded into the number.
            </p>

            {/* The bands as a strip, with the live position marked. Widths are
                the real interval widths, so the strip is to scale. */}
            <div className="mt-8">
              <div className="relative">
                <div className="flex h-2 w-full overflow-hidden rounded-full">
                  {[0, ...EDGES].map((start, i) => {
                    const end = EDGES[i] ?? 101;
                    const mid = Math.floor((start + end - 1) / 2);
                    return (
                      <span
                        key={start}
                        className="h-full"
                        style={{
                          width: `${((end - start) / 101) * 100}%`,
                          background: `rgb(var(--risk-${riskColorFor(mid)}) / 0.5)`,
                        }}
                      />
                    );
                  })}
                </div>
                <span
                  aria-hidden="true"
                  className="absolute top-1/2 h-5 w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-tx
                    ring-2 ring-panel transition-[left] duration-200 ease-out"
                  style={{ left: `${(score / 100) * 100}%` }}
                />
              </div>

              <dl className="mt-4 flex justify-between font-mono text-[10.5px] tabular-nums text-tx-3">
                {[0, ...EDGES].map((start, i) => {
                  const end = (EDGES[i] ?? 101) - 1;
                  return (
                    <div key={start} className={i === 0 ? 'text-left' : ''}>
                      <dt className="text-tx-2">
                        {start}–{end}
                      </dt>
                      <dd className="mt-1 uppercase tracking-[0.12em]">{riskLevelFor(start)}</dd>
                    </div>
                  );
                })}
              </dl>
            </div>
          </div>
        </div>
      </Reveal>
    </section>
  );
}
