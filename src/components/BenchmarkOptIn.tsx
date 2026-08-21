'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * The switch that decides whether an organisation's assessments become public
 * data.
 *
 * The copy is the important part of this component. Somebody enabling this is
 * agreeing to publish a score for a domain they assessed, and they should be
 * able to tell exactly what leaves the organisation from reading the control
 * rather than from reading the schema. So it says what is contributed — a
 * domain, a score, an industry, a date — and what is not, in those words.
 *
 * Off is the default and stays the default. Nothing here pre-selects yes.
 */

const WHAT_IS_SHARED =
  'A contribution is the domain assessed, its score, the industry and region it was filed under, and the date. Not the findings, not the host names, and not the name of this organisation.';

export function BenchmarkExplainer() {
  return <>{WHAT_IS_SHARED}</>;
}

interface Props {
  orgId: string;
  optedIn: boolean;
  /** False for viewers and analysts — the control renders, disabled. */
  canManage: boolean;
}

export default function BenchmarkOptIn({ orgId, optedIn, canManage }: Props) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(optedIn);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function toggle(next: boolean) {
    setBusy(true);
    setError(null);
    setMessage(null);

    // Optimistic, and reverted below if the server disagrees — the switch
    // should not feel like it is buffering.
    setEnabled(next);

    try {
      const response = await fetch(`/api/org/${orgId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ benchmarkOptIn: next }),
      });
      const payload = (await response.json()) as {
        error?: string;
        message?: string;
        benchmarkOptIn?: boolean;
      };

      if (!response.ok) {
        setEnabled(!next);
        setError(payload.error ?? 'Could not change that setting.');
        return;
      }

      setEnabled(payload.benchmarkOptIn ?? next);
      setMessage(payload.message ?? null);
      router.refresh();
    } catch {
      setEnabled(!next);
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel p-6">
      <p className="micro">Benchmarks</p>
      <h2 className="mt-2 text-[16px] font-semibold tracking-tight text-tx">
        Contribute to industry benchmarks
      </h2>

      <div className="mt-4 flex items-start justify-between gap-5">
        <p className="text-[12.5px] leading-relaxed text-tx-2">{WHAT_IS_SHARED}</p>

        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label="Contribute to industry benchmarks"
          disabled={!canManage || busy}
          onClick={() => void toggle(!enabled)}
          className={`relative mt-0.5 h-6 w-11 shrink-0 rounded-full border transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-seal-ink focus:outline-none focus-visible:border-tx-2 disabled:opacity-40 ${
            enabled ? 'border-tx-2 bg-raised' : 'border-line-strong bg-raised'
          }`}
        >
          <span
            className={`absolute top-1/2 h-4 w-4 -translate-y-1/2 rounded-full transition-all ${
              enabled ? 'left-[calc(100%-1.25rem)] bg-tx' : 'left-1 bg-tx-3'
            }`}
          />
        </button>
      </div>

      <p className="mt-3 text-[11.5px] leading-relaxed text-tx-3">
        {enabled
          ? 'On. The next assessment filed under this organisation will add a sample, at most one per domain per day. Turning this off stops new samples; ones already published stay in the corpus.'
          : 'Off. Nothing this organisation assesses reaches the shared corpus. Benchmarks remain readable either way — contributing is not what unlocks them.'}
      </p>

      {!canManage && (
        <p className="mt-3 text-[11.5px] leading-relaxed text-tx-3">
          Only an administrator or owner can change this.
        </p>
      )}

      {(error || message) && (
        <p
          role={error ? 'alert' : 'status'}
          className={`mt-3 text-[12px] leading-relaxed ${error ? 'text-risk-bad' : 'text-tx-2'}`}
        >
          {error ?? message}
        </p>
      )}
    </section>
  );
}
