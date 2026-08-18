'use client';

import { useState } from 'react';

import type { BenchmarkResult, RelationshipAssessment, ScanResult } from '@/lib/types';
import type { NewsIntelligence } from '@/lib/intel/types';
import type { OwnershipContext } from '@/components/OwnershipPanel';

interface ReportButtonProps {
  result: ScanResult;
  benchmark: BenchmarkResult | null;
  /** Optional — the report renders without a news section if not yet loaded. */
  news?: NewsIntelligence | null;
  /** Optional — present only when the vendor exists in the benchmark dataset. */
  ownership?: OwnershipContext | null;
  /** Optional — present only when a second domain was supplied for comparison. */
  relationship?: RelationshipAssessment | null;
  className?: string;
}

export default function ReportButton({
  result,
  benchmark,
  news,
  ownership,
  relationship,
  className,
}: ReportButtonProps) {
  const [state, setState] = useState<'idle' | 'generating' | 'error'>('idle');

  /*
   * A saved assessment can be rendered from the database instead of from this
   * tab's memory. `persisted` is set by the scan route only after the row was
   * actually written, so this is "there is a stored record to bind to" rather
   * than "the user looks signed in".
   */
  const boundId = result.persisted && result.id ? result.id : null;

  async function download() {
    setState('generating');
    try {
      const response = await fetch('/api/report', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // On the bound path the server reads the scores and findings from its
        // own row, so sending them would be sending something it will ignore.
        // The three contextual panels are not stored, so they still travel.
        body: JSON.stringify(
          boundId
            ? { assessmentId: boundId, news, ownership, relationship }
            : { result, benchmark, news, ownership, relationship },
        ),
      });

      if (!response.ok) throw new Error('Report generation failed');

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `klyro-assessment-${result.domain}-${result.scannedAt.slice(0, 10)}.pdf`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      // Give the browser a tick to start the download before revoking.
      setTimeout(() => URL.revokeObjectURL(url), 2_000);

      setState('idle');
    } catch {
      setState('error');
      setTimeout(() => setState('idle'), 4_000);
    }
  }

  return (
    <div className={className}>
      <button
        type="button"
        onClick={download}
        disabled={state === 'generating'}
        className="btn-primary w-full sm:w-auto"
      >
        {state === 'generating' ? (
          <>
            <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-ground/25 border-t-ground" />
            Building report
          </>
        ) : (
          <>
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M8 2v8m0 0 3.2-3.2M8 10 4.8 6.8M2.5 12.5h11"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            Download report
          </>
        )}
      </button>

      {boundId && state !== 'error' && (
        <p className="mt-2 flex items-center gap-1.5 text-[11.5px] leading-relaxed text-tx-3">
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M4.5 7V5a3.5 3.5 0 1 1 7 0v2M3.5 7h9v6.5h-9z"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          Verified report — built from the saved assessment, not from this page.
        </p>
      )}

      {state === 'error' && (
        <p className="mt-2 text-[12px] text-risk-bad">Report generation failed. Please try again.</p>
      )}
    </div>
  );
}
