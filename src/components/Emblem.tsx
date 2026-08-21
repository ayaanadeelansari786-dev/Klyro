import {
  EMBLEM_CENTRE,
  EMBLEM_INDEX,
  EMBLEM_RINGS,
  EMBLEM_SIZE,
  emblemRingPath,
  rosetteEllipses,
} from '@/lib/emblem';

/**
 * The mark. Inherits `currentColor`, so it sits in the seal on the landing
 * page and in the text colour wherever it is only identifying a page.
 */
export function Emblem({ size = 22, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${EMBLEM_SIZE} ${EMBLEM_SIZE}`}
      fill="none"
      aria-hidden="true"
      className={className}
    >
      {EMBLEM_RINGS.map((ring) => (
        <path
          key={ring.r}
          d={emblemRingPath(ring)}
          stroke="currentColor"
          strokeWidth={ring.width}
          strokeLinecap="round"
          opacity={ring.opacity}
        />
      ))}
      <line
        x1={EMBLEM_INDEX.x}
        y1={EMBLEM_INDEX.y1}
        x2={EMBLEM_INDEX.x}
        y2={EMBLEM_INDEX.y2}
        stroke="currentColor"
        strokeWidth={1.6}
        strokeLinecap="round"
      />
      <circle {...EMBLEM_CENTRE} fill="currentColor" />
    </svg>
  );
}

/**
 * The rosette, at the size the lacework actually resolves.
 *
 * Decorative and marked as such: it carries no information the page does not
 * state in words elsewhere, and it is drawn at an opacity the theme sets so it
 * stays a watermark on paper and an engraving in the dark.
 */
export function Rosette({ className }: { className?: string }) {
  return (
    <svg
      viewBox="-120 -120 240 240"
      fill="none"
      aria-hidden="true"
      focusable="false"
      className={className}
      style={{ opacity: 'var(--guilloche-alpha)' }}
    >
      <g stroke="currentColor" strokeWidth={0.4} fill="none">
        {rosetteEllipses().map(({ rx, ry, angle }) => (
          <ellipse key={angle} cx={0} cy={0} rx={rx} ry={ry} transform={`rotate(${angle})`} />
        ))}
      </g>
      <circle cx={0} cy={0} r={101} stroke="currentColor" strokeWidth={0.8} opacity={0.55} />
      <circle cx={0} cy={0} r={106} stroke="currentColor" strokeWidth={0.4} opacity={0.35} />
    </svg>
  );
}
