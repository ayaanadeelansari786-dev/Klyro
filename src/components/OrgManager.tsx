'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

import { BenchmarkExplainer } from '@/components/BenchmarkOptIn';

/**
 * Creating and joining organisations.
 *
 * The join code is shown exactly once, and this component says so rather than
 * quietly relying on the reader to notice. Klyro stores an HMAC of the code,
 * not the code, so there is no "show it again" to build — the only recovery is
 * a new code, and the copy states that up front instead of letting someone
 * find out later.
 */
export default function OrgManager({ hasOrgs }: { hasOrgs: boolean }) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState<'create' | 'join' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  /*
   * Asked once, on the organisation that was just created, and never again.
   *
   * It is a prompt rather than a step: both answers dismiss it, neither blocks
   * anything, and declining is not a decision the reader has to come back and
   * confirm. The setting lives on the organisation page either way, so "not
   * yet" costs nothing.
   */
  const [askOptIn, setAskOptIn] = useState<{ id: string; name: string } | null>(null);
  const [optInBusy, setOptInBusy] = useState(false);

  async function post(path: string, body: unknown, which: 'create' | 'join') {
    setBusy(which);
    setError(null);
    setNotice(null);

    try {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = (await response.json()) as {
        error?: string;
        message?: string;
        organisation?: { id: string; name: string };
      };

      if (!response.ok) {
        setError(payload.error ?? 'Something went wrong.');
        return;
      }

      if (which === 'create' && payload.organisation) {
        setAskOptIn(payload.organisation);
      }

      setNotice(payload.message ?? 'Done.');
      setName('');
      setCode('');
      router.refresh();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(null);
    }
  }

  /** Answers the prompt. `false` simply dismisses it — the default is already off. */
  async function answerOptIn(contribute: boolean) {
    const target = askOptIn;
    if (!target) return;

    if (!contribute) {
      setAskOptIn(null);
      return;
    }

    setOptInBusy(true);
    try {
      await fetch(`/api/org/${target.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ benchmarkOptIn: true }),
      });
      setNotice(
        `${target.name} will contribute anonymised scores to the industry benchmarks. You can change this on the organisation's page at any time.`,
      );
      router.refresh();
    } catch {
      setError('Could not save that preference. The setting is on the organisation’s page.');
    } finally {
      setOptInBusy(false);
      setAskOptIn(null);
    }
  }

  return (
    <div className="grid gap-5 md:grid-cols-2">
      <section className="panel p-6">
        <p className="micro">Create</p>
        <h2 className="mt-2 text-[16px] font-semibold tracking-tight text-tx">
          Start an organisation
        </h2>
        <p className="mt-2 text-[12.5px] leading-relaxed text-tx-2">
          You become its owner. Assessments filed under an organisation are visible to its members
          and to nobody else — not to other organisations, and not to Klyro users outside it.
        </p>

        <form
          className="mt-5 flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void post('/api/org', { name }, 'create');
          }}
        >
          <input
            className="field"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Acme Security"
            required
            maxLength={120}
          />
          <button type="submit" className="btn-primary" disabled={busy !== null}>
            {busy === 'create' ? 'Creating…' : 'Create organisation'}
          </button>
        </form>
      </section>

      <section className="panel p-6">
        <p className="micro">Join</p>
        <h2 className="mt-2 text-[16px] font-semibold tracking-tight text-tx">Use a join code</h2>
        <p className="mt-2 text-[12.5px] leading-relaxed text-tx-2">
          An administrator can issue one. You join as a viewer — able to read the organisation’s
          assessments, not to add to them — until somebody changes your role.
        </p>

        <form
          className="mt-5 flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void post('/api/org/join', { code }, 'join');
          }}
        >
          <input
            className="field font-mono uppercase tracking-[0.08em]"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            placeholder="KLY-XXXXX-XXXXX"
            required
            spellCheck={false}
            autoCapitalize="characters"
          />
          <button type="submit" className="btn-ghost" disabled={busy !== null}>
            {busy === 'join' ? 'Checking…' : 'Join organisation'}
          </button>
        </form>
      </section>

      {askOptIn && (
        <section className="panel md:col-span-2 p-6">
          <p className="micro">One question</p>
          <h2 className="mt-2 text-[16px] font-semibold tracking-tight text-tx">
            Contribute {askOptIn.name}’s scores to the industry benchmarks?
          </h2>
          <p className="mt-2 max-w-[62ch] text-[12.5px] leading-relaxed text-tx-2">
            <BenchmarkExplainer /> Contributing is what makes the industry comparison worth
            reading — and it is off unless you say otherwise here or on the organisation’s page.
          </p>

          <div className="mt-5 flex flex-wrap gap-3">
            <button
              type="button"
              className="btn-primary"
              disabled={optInBusy}
              onClick={() => void answerOptIn(true)}
            >
              {optInBusy ? 'Saving…' : 'Yes, contribute'}
            </button>
            <button
              type="button"
              className="btn-ghost"
              disabled={optInBusy}
              onClick={() => void answerOptIn(false)}
            >
              Not yet
            </button>
          </div>
        </section>
      )}

      {(error || notice) && (
        <p
          role={error ? 'alert' : 'status'}
          className={`md:col-span-2 text-[12.5px] leading-relaxed ${
            error ? 'text-risk-bad' : 'text-tx-2'
          }`}
        >
          {error ?? notice}
        </p>
      )}

      {!hasOrgs && !notice && (
        <p className="md:col-span-2 text-[12px] leading-relaxed text-tx-3">
          You are not in any organisation yet. Personal assessments are private to you either way —
          an organisation is for sharing them with colleagues.
        </p>
      )}
    </div>
  );
}
