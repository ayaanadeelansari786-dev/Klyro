'use client';

import type { Finding } from '@/lib/types';

/**
 * The four-part structure every finding is written in.
 *
 * The order is load-bearing. OBSERVED comes first because it is the only part
 * a sceptical reader has to accept — everything after it is Klyro reasoning
 * from that observation, and separating them lets a reader who disagrees with
 * the conclusion see exactly where they part company. RISK is deliberately
 * last of the prose sections and phrased conditionally: it is the only field
 * describing something that has not happened.
 */

const CONFIDENCE_NOTE: Record<Finding['confidence'], string> = {
  high: 'Directly observed and corroborated.',
  medium: 'Directly observed, with the limitation noted below.',
  low: 'Inferred from indirect signal. Treat as a question to ask, not a conclusion.',
};

export default function FindingDetail({ finding }: { finding: Finding }) {
  const { evidence } = finding;

  return (
    <div className="space-y-5">
      <div className="grid gap-x-8 gap-y-5 md:grid-cols-2">
        <div>
          <p className="micro">Observed</p>
          <p className="mt-2 text-[12.5px] leading-relaxed text-tx">{finding.observed}</p>
        </div>
        <div>
          <p className="micro">Interpretation</p>
          <p className="mt-2 text-[12.5px] leading-relaxed text-tx-2">{finding.interpretation}</p>
        </div>
        <div>
          <p className="micro">Risk if that reading holds</p>
          <p className="mt-2 text-[12.5px] leading-relaxed text-tx-2">{finding.risk}</p>
        </div>
        <div>
          <p className="micro">Recommended action</p>
          <p className="mt-2 text-[12.5px] leading-relaxed text-tx">{finding.recommendation}</p>
        </div>
      </div>

      <div className="border-t border-line pt-4">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
          <p className="micro">Why Klyro believes this</p>
          <p className="font-mono text-[10.5px] uppercase tracking-[0.1em] text-tx-3">
            {finding.confidence} confidence · {finding.asset}
          </p>
        </div>

        <dl className="mt-3 space-y-2.5">
          <EvidenceRow label="Test performed" value={evidence.test} mono />
          <EvidenceRow label="Observed value" value={evidence.observed} mono />
          {evidence.expected && <EvidenceRow label="Expected value" value={evidence.expected} mono />}
          <EvidenceRow label="Verification" value={evidence.verification} />
          <EvidenceRow label="Confidence basis" value={CONFIDENCE_NOTE[finding.confidence]} />
          {/*
           * The quietest line in the finding, deliberately. Everything above
           * it is what Klyro can stand behind; this is a caveat about the
           * test itself, and reads that way — dimmer and in the tertiary
           * ink, where the rest of the evidence sits in secondary.
           */}
          {evidence.limitation && (
            <EvidenceRow label="What this cannot establish" value={evidence.limitation} quiet />
          )}
          {typeof finding.scoreImpact === 'number' && finding.scoreImpact > 0 && (
            <EvidenceRow
              label="Score impact"
              value={`${finding.scoreImpact} points deducted within ${finding.categoryLabel}. Category scores are rescaled to 0–100, so this is not the effect on the composite.`}
            />
          )}
        </dl>
      </div>

      {/*
       * Generated context, kept visibly apart from everything above it.
       *
       * Collapsed by default, on its own surface, with its provenance in the
       * summary line rather than in a footnote. Every other block on this card
       * is something Klyro measured; this one is something a model wrote about
       * those measurements, and a reader must never have to work out which is
       * which. That is why it does not adopt the OBSERVED / INTERPRETATION
       * styling, and why it sits after the evidence rather than beside it.
       */}
      {finding.aiContext?.generated && finding.aiContext.narrative && (
        <details className="rounded border border-dashed border-line-strong bg-raised">
          <summary
            className="cursor-pointer list-none px-4 py-3 text-[11.5px] text-tx-2
              transition-colors duration-150 hover:text-tx
              focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2
              focus-visible:outline-seal-ink"
          >
            <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-seal-ink">
              AI-generated context
            </span>
            <span className="ml-2 text-tx-3">grounded in this scan&apos;s data</span>
          </summary>
          <div className="border-t border-line px-4 py-3.5">
            <p className="text-[12.5px] leading-relaxed text-tx-2">
              {finding.aiContext.narrative}
            </p>
            <p className="mt-3 text-[11px] leading-relaxed text-tx-3">
              Written by a language model from the findings and measurements on this page. It
              introduces no new observations, and it does not change the severity above.
            </p>
          </div>
        </details>
      )}
    </div>
  );
}

function EvidenceRow({
  label,
  value,
  mono = false,
  quiet = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
  /** The caveat register — tertiary ink, no emphasis. */
  quiet?: boolean;
}) {
  return (
    <div className="grid gap-1 sm:grid-cols-[190px_1fr] sm:gap-4">
      <dt className="text-[11.5px] leading-relaxed text-tx-3">{label}</dt>
      <dd
        className={`text-[11.5px] leading-relaxed ${quiet ? 'italic text-tx-3' : 'text-tx-2'} ${
          mono ? 'break-all font-mono not-italic' : ''
        }`}
      >
        {value}
      </dd>
    </div>
  );
}
