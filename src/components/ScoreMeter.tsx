'use client';

import { useEffect, useRef, useState } from 'react';

import { COLORS } from '@/lib/constants';
import { riskColorFor, riskLevelFor } from '@/lib/scoring';

const TONE_COLORS = {
  good: COLORS.good,
  warn: COLORS.warn,
  bad: COLORS.bad,
} as const;

/** Band edges match `riskLevelFor` — 0–59 high, 60–79 moderate, 80–100 low. */
const BANDS = [
  { from: 0, to: 60, label: 'High', color: COLORS.bad },
  { from: 60, to: 80, label: 'Moderate', color: COLORS.warn },
  { from: 80, to: 100, label: 'Low', color: COLORS.good },
];

interface ScoreMeterProps {
  score: number;
  /** Peer average, drawn as a ghost marker on the same scale. */
  peerAverage?: number | null;
  peerLabel?: string;
  duration?: number;
}

/**
 * The composite, read as an instrument: one large figure carrying the risk
 * colour, and a linear scale that shows which band it falls in and where the
 * peer pool sits. A linear scale beats a ring here — it can hold the band
 * boundaries and a second marker without any of it becoming decoration.
 */
export default function ScoreMeter({
  score,
  peerAverage = null,
  peerLabel = 'Peer average',
  duration = 1100,
}: ScoreMeterProps) {
  const [displayed, setDisplayed] = useState(0);
  const frame = useRef<number | null>(null);

  useEffect(() => {
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // A backgrounded tab suspends its frame loop, so the sweep would never
    // run and the headline figure would sit at zero. Showing the wrong score
    // is far worse than showing it without animation.
    if (reduceMotion || document.visibilityState === 'hidden') {
      setDisplayed(score);
      return;
    }

    const start = performance.now();
    const ease = (t: number) => (t === 1 ? 1 : 1 - Math.pow(2, -10 * t));

    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      setDisplayed(score * ease(t));
      if (t < 1) frame.current = requestAnimationFrame(tick);
    };

    frame.current = requestAnimationFrame(tick);

    // Second guarantee: if frames are throttled mid-sweep, land on the value.
    const settle = window.setTimeout(() => setDisplayed(score), duration + 600);

    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      window.clearTimeout(settle);
    };
  }, [score, duration]);

  const accent = TONE_COLORS[riskColorFor(score)];
  const riskLevel = riskLevelFor(score);
  const activeBand = score >= 80 ? 'Low' : score >= 60 ? 'Moderate' : 'High';
  const progress = Math.max(0, Math.min(100, displayed));

  return (
    <div className="flex flex-col gap-8 sm:flex-row sm:items-end sm:gap-10">
      <div className="flex items-start gap-2.5">
        {/*
         * The largest object on the page, deliberately — the score is the
         * one figure this entire assessment reduces to, and everything else
         * on the dashboard is context for it. `15vw` gives it real headroom
         * on a wide screen rather than pinning it to the size of a card.
         */}
        <span
          className="num wide block font-semibold leading-[0.8]"
          style={{ fontSize: 'clamp(96px, 15vw, 168px)', color: accent }}
          aria-label={`Composite exposure score ${score} out of 100`}
        >
          {Math.round(displayed)}
        </span>
        <span className="mt-3 font-mono text-[13px] text-tx-3">/100</span>
      </div>

      <div className="min-w-0 flex-1 pb-2">
        <div className="flex items-baseline justify-between gap-4">
          <span
            className="font-mono text-[12px] font-medium uppercase tracking-[0.18em]"
            style={{ color: accent }}
          >
            {riskLevel}
          </span>
          {peerAverage !== null && (
            <span className="font-mono text-[11px] text-tx-3">
              {peerLabel} <span className="text-tx-2 tabular-nums">{Math.round(peerAverage)}</span>
            </span>
          )}
        </div>

        <div className="relative mt-3">
          {/* Peer marker sits above the track so it never reads as your score. */}
          {peerAverage !== null && (
            <span
              className="absolute -top-[7px] z-10 h-[5px] w-px bg-tx-2"
              style={{ left: `${Math.max(0, Math.min(100, peerAverage))}%` }}
              aria-hidden="true"
            />
          )}

          <div className="relative h-2 w-full overflow-hidden bg-line">
            <div
              className="h-full transition-[width] duration-500 ease-out"
              style={{ width: `${progress}%`, background: accent }}
            />
            {/* Band boundaries, cut into the bar rather than drawn over it. */}
            {[60, 80].map((edge) => (
              <span
                key={edge}
                className="absolute top-0 h-full w-px bg-ground"
                style={{ left: `${edge}%` }}
                aria-hidden="true"
              />
            ))}
          </div>

          <div className="relative mt-2 h-4">
            {BANDS.map((band) => {
              const active = band.label === activeBand;
              return (
                <span
                  key={band.label}
                  className={`absolute font-mono text-[10px] uppercase tracking-[0.12em] ${
                    active ? '' : 'text-tx-3'
                  }`}
                  style={{
                    left: `${band.from}%`,
                    width: `${band.to - band.from}%`,
                    color: active ? band.color : undefined,
                  }}
                >
                  {band.label}
                </span>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
