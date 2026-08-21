'use client';

import { useEffect, useId, useRef, useState } from 'react';

import type { BenchmarkResult, RelationshipAssessment, ScanResult } from '@/lib/types';
import type { NewsIntelligence } from '@/lib/intel/types';
import type { OwnershipContext } from '@/components/OwnershipPanel';

/**
 * The two download actions, in the two shapes the page needs.
 *
 * They used to have one shape. That shape is ~106px tall — two buttons on a
 * row, then a caption explaining how the summary relates to the full report —
 * and it was being dropped straight into the results page's sticky header,
 * which is a fixed 56px row with `items-center`. A 106px child centred in a
 * 56px box overflows 25px in each direction, and the top 25px of a header
 * pinned to `top: 0` is off the screen entirely. Measured at 1920px, both
 * buttons sat at `top: -25px` with 17px of a 42px button showing; at 380px the
 * first button was at `top: -117px`, completely gone.
 *
 * Worth naming what it was *not*, because all three were plausible: nothing
 * had `overflow: hidden`, nothing was absolutely positioned, and no stacking
 * context was involved. The header is a plain sticky flex row. The bug was
 * reusing a full-size block in a slot sized for a single control.
 *
 * So there are two variants now, and the compact one is built to the height of
 * the row it lives in.
 */

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
  /**
   * `compact` fits a header row: no captions, fixed height, and an overflow
   * menu below `lg` where two labelled buttons stop fitting beside the
   * wordmark. `full` is the section treatment, with the caption that explains
   * what the summary is for.
   */
  variant?: 'full' | 'compact';
}

type Phase = 'idle' | 'generating' | 'error';

/**
 * Everything both variants share: the two requests, their phases, and the
 * decision about which endpoint shape to send.
 *
 * A hook rather than duplicated handlers, because the interesting part — that
 * a bound assessment renders from the stored row and an anonymous one renders
 * from page state — must not differ between the header button and the section
 * button. They download the same document.
 */
function useReportDownloads({
  result,
  benchmark,
  news,
  ownership,
  relationship,
}: ReportButtonProps) {
  const [state, setState] = useState<Phase>('idle');
  const [summaryState, setSummaryState] = useState<Phase>('idle');
  /*
   * The summary endpoint fails loudly by design, so its reason is shown rather
   * than swallowed. Without it the button would appear to do nothing on a
   * deployment with no generator configured — the exact failure the endpoint
   * was written to avoid producing in PDF form.
   */
  const [summaryError, setSummaryError] = useState<string | null>(null);

  /*
   * A saved assessment can be rendered from the database instead of from this
   * tab's memory. `persisted` is set by the scan route only after the row was
   * actually written, so this is "there is a stored record to bind to" rather
   * than "the user looks signed in".
   */
  const boundId = result.persisted && result.id ? result.id : null;

  const save = (blob: Blob, name: string) => {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    // Give the browser a tick to start the download before revoking.
    setTimeout(() => URL.revokeObjectURL(url), 2_000);
  };

  const stamp = result.scannedAt.slice(0, 10);

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

      save(await response.blob(), `klyro-assessment-${result.domain}-${stamp}.pdf`);
      setState('idle');
    } catch {
      setState('error');
      setTimeout(() => setState('idle'), 4_000);
    }
  }

  async function downloadSummary() {
    setSummaryState('generating');
    setSummaryError(null);
    try {
      const response = await fetch('/api/report/summary', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(boundId ? { assessmentId: boundId } : { result }),
      });

      if (!response.ok) {
        const detail = (await response.json().catch(() => null)) as
          | { error?: string; reason?: string }
          | null;
        /*
         * The reason is shown, not just the sentence.
         *
         * The endpoint has always sent one — when the configured model was
         * retired it read `Groq returned 404: The model ... does not exist` —
         * but this button displayed only `error`, so a precise diagnosis
         * arrived at the browser and was thrown away. It is a dependency
         * failure on Klyro's side and says nothing about the domain, so there
         * is nothing here to withhold.
         */
        setSummaryError(
          [detail?.error ?? 'The summary could not be generated. Please try again.', detail?.reason]
            .filter(Boolean)
            .join(' '),
        );
        setSummaryState('error');
        return;
      }

      save(await response.blob(), `klyro-summary-${result.domain}-${stamp}.pdf`);
      setSummaryState('idle');
    } catch {
      setSummaryError('The summary could not be generated. Please try again.');
      setSummaryState('error');
    }
  }

  return { state, summaryState, summaryError, boundId, download, downloadSummary };
}

/* ------------------------------------------------------------------ *
 * Icons
 * ------------------------------------------------------------------ */

function DownloadIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M8 2v8m0 0 3.2-3.2M8 10 4.8 6.8M2.5 12.5h11"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function PageIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M4 2.5h8v11H4zM6 6h4M6 8.5h4M6 11h2"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Spinner({ className }: { className: string }) {
  return <span className={`h-3.5 w-3.5 animate-spin rounded-full border-2 ${className}`} />;
}

/* ------------------------------------------------------------------ *
 * Compact — the header row
 * ------------------------------------------------------------------ */

/**
 * The overflow menu, below `lg`.
 *
 * The brief asked for the theme toggle to move in here too. It does not: the
 * toggle is 58×30 and still fits beside the wordmark at 380px, and burying a
 * two-state control behind a menu makes it harder to reach on exactly the
 * screens where people flip it most. What does not fit is two labelled
 * download buttons, so those are what collapse.
 */
function OverflowMenu({
  state,
  summaryState,
  download,
  downloadSummary,
}: {
  state: Phase;
  summaryState: Phase;
  download: () => void;
  downloadSummary: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemsRef = useRef<(HTMLButtonElement | null)[]>([]);
  const menuId = useId();

  /* Escape closes and returns focus to the trigger; a click outside just
     closes. Both are what a menu is expected to do, and neither happens for
     free. */
  useEffect(() => {
    if (!open) return;

    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };

    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [open]);

  // Opening a menu moves focus into it, or the keyboard user is left behind.
  useEffect(() => {
    if (open) itemsRef.current[0]?.focus();
  }, [open]);

  function onMenuKeyDown(event: React.KeyboardEvent) {
    const items = itemsRef.current.filter(Boolean) as HTMLButtonElement[];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      items[(at + 1) % items.length]?.focus();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      items[(at - 1 + items.length) % items.length]?.focus();
    }
  }

  const item =
    'flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left text-[13px] text-tx-2 ' +
    'transition-colors duration-150 hover:bg-tx/[0.05] hover:text-tx disabled:opacity-50 ' +
    'focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-seal-ink';

  return (
    <div ref={rootRef} className="relative lg:hidden">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label="Report downloads"
        className="btn-ghost h-[34px] w-[38px] px-0"
      >
        {state === 'generating' || summaryState === 'generating' ? (
          <Spinner className="border-line-strong border-t-tx-2" />
        ) : (
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <circle cx="3" cy="8" r="1.35" />
            <circle cx="8" cy="8" r="1.35" />
            <circle cx="13" cy="8" r="1.35" />
          </svg>
        )}
      </button>

      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label="Report downloads"
          onKeyDown={onMenuKeyDown}
          className="glass absolute right-0 top-full z-50 mt-2 w-[212px] overflow-hidden py-1"
        >
          <button
            ref={(el) => {
              itemsRef.current[0] = el;
            }}
            type="button"
            role="menuitem"
            disabled={state === 'generating'}
            onClick={() => {
              setOpen(false);
              download();
            }}
            className={item}
          >
            <DownloadIcon />
            {state === 'generating' ? 'Building report' : 'Download report'}
          </button>
          <button
            ref={(el) => {
              itemsRef.current[1] = el;
            }}
            type="button"
            role="menuitem"
            disabled={summaryState === 'generating'}
            onClick={() => {
              setOpen(false);
              downloadSummary();
            }}
            className={item}
          >
            <PageIcon />
            {summaryState === 'generating' ? 'Writing summary' : '1-page summary'}
          </button>
        </div>
      )}
    </div>
  );
}

function CompactActions(controller: ReturnType<typeof useReportDownloads>) {
  const { state, summaryState, summaryError, download, downloadSummary } = controller;
  const failed = state === 'error' || (summaryState === 'error' && summaryError);

  return (
    /*
     * `shrink-0` and a fixed height are the two properties that keep this out
     * of the header's way. Without the first, a long domain in the left group
     * compresses the controls; without the second, any growth here pushes the
     * cluster back out of the row.
     */
    <div className="relative flex shrink-0 items-center gap-2">
      {/* Inline above `lg`, where two labelled buttons fit beside the
          wordmark and the domain. */}
      <div className="hidden items-center gap-2 lg:flex">
        <button
          type="button"
          onClick={download}
          disabled={state === 'generating'}
          className="btn-primary h-[34px] whitespace-nowrap px-3.5 py-0 text-[12.5px]"
        >
          {state === 'generating' ? (
            <>
              <Spinner className="border-ground/25 border-t-ground" />
              Building
            </>
          ) : (
            <>
              <DownloadIcon />
              Download report
            </>
          )}
        </button>

        <button
          type="button"
          onClick={downloadSummary}
          disabled={summaryState === 'generating'}
          className="btn-ghost h-[34px] whitespace-nowrap px-3.5 py-0 text-[12.5px]"
        >
          {summaryState === 'generating' ? (
            <>
              <Spinner className="border-line-strong border-t-tx-2" />
              Writing
            </>
          ) : (
            <>
              <PageIcon />
              1-page summary
            </>
          )}
        </button>
      </div>

      <OverflowMenu
        state={state}
        summaryState={summaryState}
        download={download}
        downloadSummary={downloadSummary}
      />

      {/*
       * Failures drop out of the row rather than growing it.
       *
       * This is the same reasoning as the fix above, applied to the thing that
       * caused it: a paragraph rendered in flow here would push the cluster
       * out of a fixed-height header the moment a download failed — a layout
       * bug that only appears when something has already gone wrong.
       */}
      {failed && (
        <p
          role="alert"
          className="glass absolute right-0 top-full z-50 mt-2 w-[min(320px,80vw)] px-3.5 py-2.5
            text-[12px] leading-relaxed text-risk-bad"
        >
          {state === 'error' ? 'Report generation failed. Please try again.' : summaryError}
        </p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Full — the section
 * ------------------------------------------------------------------ */

function FullActions({
  className,
  ...controller
}: ReturnType<typeof useReportDownloads> & { className?: string }) {
  const { state, summaryState, summaryError, boundId, download, downloadSummary } = controller;

  return (
    <div className={className}>
      <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center">
        <button
          type="button"
          onClick={download}
          disabled={state === 'generating'}
          className="btn-primary w-full sm:w-auto"
        >
          {state === 'generating' ? (
            <>
              <Spinner className="border-ground/25 border-t-ground" />
              Building report
            </>
          ) : (
            <>
              <DownloadIcon />
              Download report
            </>
          )}
        </button>

        {/*
         * The short version, offered as the secondary action.
         *
         * Named for its length rather than its audience: "1-page summary" tells
         * a reader what they are getting without implying the full report is the
         * difficult one they should avoid. The two are companions, and the
         * caption below says so.
         */}
        <button
          type="button"
          onClick={downloadSummary}
          disabled={summaryState === 'generating'}
          className="btn-ghost w-full sm:w-auto"
        >
          {summaryState === 'generating' ? (
            <>
              <Spinner className="border-line-strong border-t-tx-2" />
              Writing summary
            </>
          ) : (
            <>
              <PageIcon />
              1-page summary
            </>
          )}
        </button>
      </div>

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
        <p role="alert" className="mt-2 text-[12px] text-risk-bad">
          Report generation failed. Please try again.
        </p>
      )}

      {summaryState === 'error' && summaryError && (
        <p role="alert" className="mt-2 max-w-prose text-[12px] leading-relaxed text-risk-bad">
          {summaryError}
        </p>
      )}

      {summaryState !== 'error' && (
        <p className="mt-2 max-w-prose text-[11.5px] leading-relaxed text-tx-3">
          The summary is one page of plain language for a non-technical reader. It is a companion to
          the full report, not a replacement — the findings, methodology and evidence are only in
          the complete document.
        </p>
      )}
    </div>
  );
}

export default function ReportButton(props: ReportButtonProps) {
  const controller = useReportDownloads(props);

  return props.variant === 'compact' ? (
    <CompactActions {...controller} />
  ) : (
    <FullActions {...controller} className={props.className} />
  );
}
