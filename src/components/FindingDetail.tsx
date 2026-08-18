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
          {evidence.limitation && (
            <EvidenceRow label="What this cannot establish" value={evidence.limitation} />
          )}
          {typeof finding.scoreImpact === 'number' && finding.scoreImpact > 0 && (
            <EvidenceRow
              label="Score impact"
              value={`${finding.scoreImpact} points deducted within ${finding.categoryLabel}. Category scores are rescaled to 0–100, so this is not the effect on the composite.`}
            />
          )}
        </dl>
      </div>
    </div>
  );
}

function EvidenceRow({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="grid gap-1 sm:grid-cols-[190px_1fr] sm:gap-4">
      <dt className="text-[11.5px] leading-relaxed text-tx-3">{label}</dt>
      <dd
        className={`text-[11.5px] leading-relaxed text-tx-2 ${
          mono ? 'break-all font-mono' : ''
        }`}
      >
        {value}
      </dd>
    </div>
  );
}
