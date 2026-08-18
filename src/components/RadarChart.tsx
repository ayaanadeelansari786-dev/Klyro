'use client';

import { CATEGORY_ORDER, CATEGORY_SHORT_LABELS, COLORS } from '@/lib/constants';
import type { BenchmarkResult, CategoryResult } from '@/lib/types';

interface RadarChartProps {
  categories: CategoryResult[];
  benchmark: BenchmarkResult | null;
}

const W = 460;
const H = 400;
const CX = W / 2;
const CY = 194;
const R = 128;
const LABEL_R = R + 24;

function point(index: number, count: number, radius: number) {
  const angle = (index / count) * Math.PI * 2 - Math.PI / 2;
  return { x: CX + Math.cos(angle) * radius, y: CY + Math.sin(angle) * radius, angle };
}

function polygon(values: (number | null)[], radius: number) {
  return values
    .map((value, i) => {
      const p = point(i, values.length, ((value ?? 0) / 100) * radius);
      return `${p.x.toFixed(1)},${p.y.toFixed(1)}`;
    })
    .join(' ');
}

/**
 * Hand-drawn rather than charted: the grid is hairline-thin, the axes carry no
 * numbers, and the only filled shape is the assessed profile. A chart library's
 * defaults (legends, tooltips, tick labels) would out-shout the data at this
 * size.
 */
export default function RadarChart({ categories, benchmark }: RadarChartProps) {
  const hasPeerData =
    Boolean(benchmark) && Object.keys(benchmark?.categoryAverages ?? {}).length > 0;

  const axes = CATEGORY_ORDER.map((key) => {
    const category = categories.find((c) => c.key === key);
    return {
      key,
      label: CATEGORY_SHORT_LABELS[key],
      you: category?.status === 'assessed' ? category.score : null,
      peers: benchmark?.categoryAverages[key] ?? null,
    };
  });

  const count = axes.length;
  const weakest = axes
    .filter((a) => a.you !== null)
    .sort((a, b) => (a.you ?? 0) - (b.you ?? 0))
    .slice(0, 3);

  return (
    <section className="panel flex flex-col">
      <div className="px-5 py-5 sm:px-6">
        <p className="micro">Profile</p>
        <h2 className="mt-2 text-[17px] font-semibold tracking-tight text-tx">
          Where the exposure concentrates
        </h2>
        <p className="mt-1.5 max-w-lg text-[11.5px] leading-relaxed text-tx-3">
          Each spoke is one assessed check, scored out of 100. Points pulled toward the centre are
          what an attacker reaches for first.
        </p>
      </div>

      <div className="px-2 pb-1">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="h-auto w-full"
          role="img"
          aria-label="Category profile across every assessed check"
        >
          {/* Concentric rings */}
          {[25, 50, 75, 100].map((level) => (
            <polygon
              key={level}
              points={polygon(new Array(count).fill(level), R)}
              fill="none"
              stroke={level === 100 ? '#272C35' : '#1C2027'}
              strokeWidth="1"
            />
          ))}

          {/* Spokes */}
          {axes.map((axis, i) => {
            const p = point(i, count, R);
            return (
              <line
                key={axis.key}
                x1={CX}
                y1={CY}
                x2={p.x}
                y2={p.y}
                stroke="#1C2027"
                strokeWidth="1"
              />
            );
          })}

          {hasPeerData && (
            <polygon
              points={polygon(
                axes.map((a) => a.peers),
                R,
              )}
              fill="none"
              stroke="#4A515E"
              strokeWidth="1.25"
              strokeDasharray="3 3"
            />
          )}

          <polygon
            points={polygon(
              axes.map((a) => a.you),
              R,
            )}
            fill="rgba(236,238,242,0.10)"
            stroke={COLORS.ink}
            strokeWidth="1.75"
            strokeLinejoin="round"
          />

          {/* Vertices, coloured only where the value is poor */}
          {axes.map((axis, i) => {
            if (axis.you === null) return null;
            const p = point(i, count, (axis.you / 100) * R);
            const colour =
              axis.you < 60 ? COLORS.bad : axis.you < 80 ? COLORS.warn : COLORS.ink;
            return (
              <circle key={axis.key} cx={p.x} cy={p.y} r={axis.you < 80 ? 3.5 : 2.5} fill={colour}>
                <title>{`${axis.label}: ${axis.you}`}</title>
              </circle>
            );
          })}

          {/* Axis labels */}
          {axes.map((axis, i) => {
            const p = point(i, count, LABEL_R);
            const cos = Math.cos(p.angle);
            const anchor = cos > 0.25 ? 'start' : cos < -0.25 ? 'end' : 'middle';
            const dim = axis.you !== null && axis.you < 60;
            return (
              <text
                key={axis.key}
                x={p.x}
                y={p.y + 3.5}
                textAnchor={anchor}
                fontSize="10.5"
                fontFamily="var(--font-mono)"
                letterSpacing="0.04em"
                fill={dim ? COLORS.bad : '#9AA1AD'}
              >
                {axis.label}
              </text>
            );
          })}
        </svg>
      </div>

      <div className="mt-auto">
        <div className="rule" />
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 px-5 py-4 sm:px-6">
          <span className="flex items-center gap-2 text-[11.5px] text-tx-2">
            <span className="h-[2px] w-4 bg-tx" aria-hidden="true" />
            This domain
          </span>
          {hasPeerData ? (
            <span className="flex items-center gap-2 text-[11.5px] text-tx-3">
              <span
                className="h-0 w-4 border-t border-dashed border-[#4A515E]"
                aria-hidden="true"
              />
              Pool average
            </span>
          ) : (
            <span className="text-[11.5px] text-tx-3">
              The pool overlay appears once peer assessments exist for this industry and region.
            </span>
          )}
          {weakest.length > 0 && (
            <span className="ml-auto text-[11.5px] text-tx-3">
              Weakest: <span className="text-tx-2">{weakest.map((w) => w.label).join(', ')}</span>
            </span>
          )}
        </div>
      </div>
    </section>
  );
}
