/**
 * The mark, as geometry rather than as three drawings.
 *
 * Klyro's claim is that every finding traces back to something observed, so
 * the identity is borrowed from the one graphic tradition built entirely
 * around being checkable: security printing. A guilloché rosette is drawn by a
 * geometric lathe, and it appears on banknotes and share certificates for a
 * single reason — the pattern is a consequence of its parameters, so a forgery
 * that is slightly wrong is visibly wrong. That is the same argument Klyro
 * makes about a scan.
 *
 * Two expressions, one construction. At 24px the rosette is illegible, so the
 * mark reduces to concentric arcs with rotating gaps — a dial read end-on. At
 * hero size the full rosette is drawn as interfering ellipses, which is how a
 * lathe actually produces one and costs a few hundred bytes of markup instead
 * of a sampled path with a thousand points in it.
 *
 * The favicon is generated from `EMBLEM_RINGS` too, and a test asserts the
 * committed SVG still matches what this module produces — the brief asked for
 * one mark across three uses, and a comment saying so would not have kept it
 * true.
 */

const round = (n: number) => Number(n.toFixed(3));

function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  // -90 so 0° is twelve o'clock, which is where a dial's index sits.
  const a = ((deg - 90) * Math.PI) / 180;
  return [round(cx + r * Math.cos(a)), round(cy + r * Math.sin(a))];
}

/** One arc of a ring, swept clockwise from `startDeg` to `endDeg`. */
export function arcPath(
  cx: number,
  cy: number,
  r: number,
  startDeg: number,
  endDeg: number,
): string {
  const [x1, y1] = polar(cx, cy, r, startDeg);
  const [x2, y2] = polar(cx, cy, r, endDeg);
  const sweep = (endDeg - startDeg + 360) % 360;
  return `M ${x1} ${y1} A ${r} ${r} 0 ${sweep > 180 ? 1 : 0} 1 ${x2} ${y2}`;
}

export interface EmblemRing {
  r: number;
  /** Degrees of the ring left open, and where. */
  gapAt: number;
  gapWidth: number;
  width: number;
  opacity: number;
}

/**
 * Three rings, each with its gap rotated on from the last.
 *
 * The rotation is the whole idea: three concentric circles read as a target,
 * which is the wrong metaphor entirely. Three circles whose openings step
 * around the centre read as tumblers that have to be brought into line, which
 * is the right one.
 */
export const EMBLEM_RINGS: EmblemRing[] = [
  { r: 10.4, gapAt: 0, gapWidth: 26, width: 1.5, opacity: 1 },
  { r: 7.1, gapAt: 132, gapWidth: 34, width: 1.3, opacity: 0.72 },
  { r: 3.9, gapAt: 248, gapWidth: 42, width: 1.2, opacity: 0.46 },
];

export const EMBLEM_SIZE = 24;
const C = EMBLEM_SIZE / 2;

export function emblemRingPath(ring: EmblemRing): string {
  return arcPath(C, C, ring.r, ring.gapAt + ring.gapWidth / 2, ring.gapAt - ring.gapWidth / 2);
}

/**
 * The index mark: a short radial tick at twelve o'clock, sitting in the outer
 * ring's gap. It is what turns a set of rings into an instrument that has a
 * reading.
 */
export const EMBLEM_INDEX = { x: C, y1: round(C - 10.8), y2: round(C - 7.6) };

export const EMBLEM_CENTRE = { cx: C, cy: C, r: 1.35 };

/**
 * The favicon, as a string.
 *
 * Held here rather than hand-written into `src/app/icon.svg` so the file on
 * disk can be checked against it. A favicon carries no theme, so it is drawn
 * in the seal at a fixed value — it has to hold on whatever colour a browser
 * tab happens to be.
 */
export function faviconSvg(): string {
  const rings = EMBLEM_RINGS.map(
    (ring) =>
      `<path d="${emblemRingPath(ring)}" stroke="#C9A227" stroke-width="${ring.width}" ` +
      `stroke-linecap="round" fill="none" opacity="${ring.opacity}"/>`,
  ).join('\n  ');

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${EMBLEM_SIZE} ${EMBLEM_SIZE}">\n` +
    `  <rect width="${EMBLEM_SIZE}" height="${EMBLEM_SIZE}" rx="5" fill="#0B0E14"/>\n` +
    `  ${rings}\n` +
    `  <line x1="${EMBLEM_INDEX.x}" y1="${EMBLEM_INDEX.y1}" x2="${EMBLEM_INDEX.x}" y2="${EMBLEM_INDEX.y2}" ` +
    `stroke="#C9A227" stroke-width="1.6" stroke-linecap="round"/>\n` +
    `  <circle cx="${EMBLEM_CENTRE.cx}" cy="${EMBLEM_CENTRE.cy}" r="${EMBLEM_CENTRE.r}" fill="#C9A227"/>\n` +
    `</svg>\n`
  );
}

/**
 * The full rosette, for the one place there is room for it.
 *
 * `count` ellipses rotated evenly about the centre. Where their edges cross,
 * the moiré produces the dense lacework a lathe would cut — no sampling, no
 * path data, and it scales to any size without getting heavier.
 */
export function rosetteEllipses(count = 30): { rx: number; ry: number; angle: number }[] {
  return Array.from({ length: count }, (_, i) => ({
    rx: 96,
    ry: 38,
    angle: round((360 / count) * i),
  }));
}
