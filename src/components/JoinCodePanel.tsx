'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Issuing and revoking an organisation's join code.
 *
 * The plaintext appears once, in the response to the POST that created it, and
 * is held in component state until the page is left. There is no endpoint that
 * returns an existing code and there should never be one: a code that can be
 * re-read is a code a stolen admin session can fetch at leisure. The panel
 * says this in the interface rather than only in the code comments, because
 * the person who loses a code is the person reading the screen.
 */
export default function JoinCodePanel({
  orgId,
  canManage,
  liveCodeHint,
}: {
  orgId: string;
  canManage: boolean;
  liveCodeHint: string | null;
}) {
  const router = useRouter();
  const [issued, setIssued] = useState<{ code: string; warning: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  if (!canManage) {
    return (
      <section className="panel p-6">
        <p className="micro">Join code</p>
        <p className="mt-3 text-[12.5px] leading-relaxed text-tx-2">
          Administrators and owners can issue a code that lets colleagues join this organisation.
        </p>
      </section>
    );
  }

  async function act(method: 'POST' | 'DELETE') {
    setBusy(true);
    setError(null);
    setCopied(false);

    try {
      const response = await fetch(`/api/org/${orgId}/code`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: method === 'POST' ? JSON.stringify({}) : undefined,
      });
      const payload = (await response.json()) as {
        code?: string;
        warning?: string;
        error?: string;
        message?: string;
      };

      if (!response.ok) {
        setError(payload.error ?? 'Something went wrong.');
        return;
      }

      if (method === 'POST' && payload.code) {
        setIssued({ code: payload.code, warning: payload.warning ?? '' });
      } else {
        setIssued(null);
      }
      router.refresh();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel p-6">
      <p className="micro">Join code</p>
      <h2 className="mt-2 text-[16px] font-semibold tracking-tight text-tx">
        Let colleagues join
      </h2>

      {issued ? (
        <div className="mt-4">
          <div className="flex flex-wrap items-center gap-3">
            <code className="rounded border border-line bg-raised px-4 py-2.5 font-mono text-[15px] tracking-[0.1em] text-tx">
              {issued.code}
            </code>
            <button
              type="button"
              className="btn-ghost px-3 py-2 text-[12px]"
              onClick={() => {
                void navigator.clipboard?.writeText(issued.code);
                setCopied(true);
              }}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <p className="mt-3 max-w-[56ch] text-[12px] leading-relaxed text-risk-warn">
            {issued.warning}
          </p>
        </div>
      ) : (
        <p className="mt-2 max-w-[52ch] text-[12.5px] leading-relaxed text-tx-2">
          {liveCodeHint
            ? `One code is live, ending ${liveCodeHint}. Issuing a new one revokes it immediately.`
            : 'No code is live. Anyone who had an older one can no longer use it.'}
        </p>
      )}

      {error && (
        <p role="alert" className="mt-3 text-[12.5px] text-risk-bad">
          {error}
        </p>
      )}

      <div className="mt-5 flex flex-wrap gap-3">
        <button type="button" className="btn-primary" onClick={() => void act('POST')} disabled={busy}>
          {busy ? 'Working…' : liveCodeHint ? 'Rotate code' : 'Issue code'}
        </button>
        {liveCodeHint && (
          <button type="button" className="btn-ghost" onClick={() => void act('DELETE')} disabled={busy}>
            Revoke without replacing
          </button>
        )}
      </div>

      <p className="mt-4 max-w-[56ch] text-[11.5px] leading-relaxed text-tx-3">
        Klyro stores a keyed hash of the code rather than the code, so it cannot be shown again
        later — not to you, and not to anyone who obtains a copy of the database.
      </p>
    </section>
  );
}
