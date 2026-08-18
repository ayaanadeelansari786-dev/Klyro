'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

import { getBrowserClient } from '@/lib/supabase/browser';

type Mode = 'signin' | 'signup';

/**
 * Sign in and sign up, in one panel.
 *
 * Accounts are optional in Klyro — the assessment runs identically without
 * one — so this is deliberately not a wall. The copy says what an account
 * actually buys rather than assuming the reader wants one.
 */
export default function AuthPanel({ initialMode = 'signin' }: { initialMode?: Mode }) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>(initialMode);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const supabase = getBrowserClient();

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setNotice(null);

    if (!supabase) {
      setError('Accounts are not configured for this deployment. Assessments still run without one.');
      return;
    }

    setBusy(true);
    try {
      if (mode === 'signup') {
        const { data, error: signUpError } = await supabase.auth.signUp({
          email,
          password,
          // Read by the profile trigger in migration 0003.
          options: { data: { display_name: displayName.trim() || undefined } },
        });

        if (signUpError) throw signUpError;

        // With email confirmation switched on, Supabase returns a user and no
        // session. Saying so beats a form that appears to do nothing.
        if (data.user && !data.session) {
          setNotice('Check your email to confirm the address, then sign in.');
          return;
        }
      } else {
        const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
        if (signInError) throw signInError;
      }

      router.refresh();
      router.push('/app');
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel p-6 sm:p-8">
      <p className="micro">{mode === 'signup' ? 'Create an account' : 'Sign in'}</p>
      <h1 className="mt-3 text-[22px] font-semibold tracking-tight text-tx">
        {mode === 'signup' ? 'Keep your assessments' : 'Welcome back'}
      </h1>
      <p className="mt-3 max-w-[46ch] text-[13px] leading-relaxed text-tx-2">
        Assessments run without an account and always will. Signing in adds two things: a history of
        what you have assessed, and the ability to compare two assessments of the same domain to see
        what changed.
      </p>

      <form onSubmit={submit} className="mt-7 flex flex-col gap-3">
        {mode === 'signup' && (
          <label className="flex flex-col gap-1.5">
            <span className="micro">Name</span>
            <input
              className="field"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="How colleagues will see you"
              autoComplete="name"
            />
          </label>
        )}

        <label className="flex flex-col gap-1.5">
          <span className="micro">Email</span>
          <input
            className="field"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
          />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="micro">Password</span>
          <input
            className="field"
            type="password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
          />
        </label>

        {error && (
          <p role="alert" className="text-[12.5px] leading-relaxed text-risk-bad">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="text-[12.5px] leading-relaxed text-tx-2">
            {notice}
          </p>
        )}

        <button type="submit" className="btn-primary mt-2" disabled={busy}>
          {busy ? 'Working…' : mode === 'signup' ? 'Create account' : 'Sign in'}
        </button>
      </form>

      <button
        type="button"
        onClick={() => {
          setMode(mode === 'signup' ? 'signin' : 'signup');
          setError(null);
          setNotice(null);
        }}
        className="mt-5 text-[12.5px] text-tx-2 underline decoration-line-strong underline-offset-4 transition-colors hover:text-tx"
      >
        {mode === 'signup' ? 'Already have an account? Sign in' : 'No account? Create one'}
      </button>
    </div>
  );
}
