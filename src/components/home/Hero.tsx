'use client';

import { Rosette } from '@/components/Emblem';
import ScanForm from '@/components/ScanForm';
import { SplitWords, useParallax, useReveal } from '@/components/motion';
import { CATEGORY_ORDER } from '@/lib/constants';

/**
 * The hero.
 *
 * The alignment problem this solves, and it was the brief's first complaint:
 * the two columns had nothing in common to line up on. The left began with a
 * 10px eyebrow at y=0; the right began with a panel whose own first label sat
 * a border and 24 points of padding lower. Nothing agreed with anything, and
 * the more the two columns were nudged the worse it got, because they were
 * being aligned to each other rather than to a shared reference.
 *
 * So there is now a shared reference. One rail spans the full grid — eyebrow
 * left, summary right — closed by a hairline, and *both* columns start at the
 * same y beneath it. The alignment is structural instead of negotiated, and it
 * holds at every width without a single magic offset.
 */

const STATS: [value: string, label: string, note: string][] = [
  [String(CATEGORY_ORDER.length), 'checks', 'weighted by consequence'],
  ['20–45s', 'to assess', 'observed range, run in parallel'],
  ['0', 'packets of intrusion', 'public sources and plain reads'],
];

function Stat({ index, value, label, note }: { index: number; value: string; label: string; note: string }) {
  const { ref, shown } = useReveal<HTMLDivElement>();

  return (
    <div ref={ref} className="relative pt-4">
      {/* The rule over each figure draws in on arrival, one after the next. It
          is also the alignment device: three segments of equal width are what
          make three figures of unequal width read as one set rather than three
          numbers that happen to be near each other. */}
      <span aria-hidden="true" className="absolute inset-x-0 top-0 h-px bg-line" />
      <span
        aria-hidden="true"
        className="absolute inset-x-0 top-0 h-px origin-left bg-seal transition-transform
          duration-[900ms] ease-[cubic-bezier(0.16,1,0.3,1)]"
        style={{
          transform: `scaleX(${shown ? 1 : 0})`,
          transitionDelay: `${140 + index * 130}ms`,
        }}
      />

      <dt className="num wide text-[32px] font-semibold leading-none text-tx sm:text-[36px]">
        {value}
      </dt>
      <dd className="mt-2.5">
        <span className="micro block">{label}</span>
        <span className="mt-1.5 block text-[11.5px] leading-snug text-tx-3">{note}</span>
      </dd>
    </div>
  );
}

export default function Hero() {
  const rosetteRef = useParallax<HTMLDivElement>(0.14, -0.01);

  return (
    <div className="relative overflow-x-clip pb-4 pt-10 sm:pt-14">
      {/*
       * The rosette sits behind the scan panel rather than beside it, because
       * the panel is now glazed: the lacework passes under the glass and comes
       * through as a wash. That is the whole argument for the material — an
       * opaque panel would have nothing to blur.
       */}
      <div
        ref={rosetteRef}
        className="pointer-events-none absolute -right-32 -top-24 hidden h-[620px] w-[620px] text-seal lg:block"
        aria-hidden="true"
      >
        <Rosette className="h-full w-full" />
      </div>

      {/* The shared rail. Both columns hang from the hairline under it. */}
      <div className="relative border-b border-line pb-3.5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-8 gap-y-2">
          <p className="micro">Passive reconnaissance</p>
          <p className="micro hidden sm:block">
            {CATEGORY_ORDER.length} checks · one composite · executive PDF
          </p>
        </div>
      </div>

      {/*
       * The headline steps *down* at `lg` and back up at `xl`, which looks
       * wrong written out and is right on screen: `lg` is where the single
       * column splits in two and the headline loses 40% of its measure in one
       * breakpoint. Held at 62px it set five lines of one-and-a-half words each
       * in a 369px column. It gets its full size back once `xl` gives the
       * column the width to carry it.
       */}
      <div className="relative grid items-start gap-12 pt-12 lg:grid-cols-[minmax(0,1fr)_minmax(390px,440px)] lg:gap-14 lg:pt-14 xl:grid-cols-[minmax(0,1fr)_minmax(420px,516px)] xl:gap-16">
        <div>
          <h1 className="titling max-w-[15ch] text-[44px] leading-[0.98] text-tx sm:text-[56px] lg:text-[48px] xl:text-[60px]">
            <SplitWords text="Everything an attacker learns before they touch you." />
          </h1>

          <p className="mt-8 max-w-[46ch] text-[15px] leading-relaxed text-tx-2">
            Klyro assesses what your domain publishes to the open internet — certificates, mail
            authentication, exposed paths, subdomains — and returns one composite score, ranked
            against the vendors in our benchmark dataset, as an executive PDF.
          </p>

          {/*
           * Three equal columns rather than a wrapping flex row. The old
           * version sized each figure to its own content, so "11", "20–45s"
           * and "0" started at three arbitrary positions that changed with the
           * text; on a grid they start on a grid.
           */}
          <dl className="mt-12 grid grid-cols-1 gap-y-7 sm:grid-cols-3 sm:gap-x-7 sm:gap-y-0">
            {STATS.map(([value, label, note], i) => (
              <Stat key={label} index={i} value={value} label={label} note={note} />
            ))}
          </dl>
        </div>

        <div>
          <ScanForm />
        </div>
      </div>
    </div>
  );
}
