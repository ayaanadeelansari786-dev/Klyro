'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Deleting an organisation, and saying what that actually destroys.
 *
 * The cascade is the whole design problem here. Removing an organisation
 * removes every assessment filed under it — not from the owner's view, from
 * the database, for every member at once — along with its join codes and its
 * roster. There is no soft delete and no recovery, so the interface's job is
 * to make sure nobody reaches the button believing this only removes a folder
 * they stopped using.
 *
 * Three things do that work. The consequence is stated in counts the reader
 * can check against the page they are standing on, not in the abstract. The
 * panel stays closed until deliberately opened. And confirming means typing
 * the organisation's name, which is the one gesture that cannot be performed
 * by muscle memory.
 *
 * Rendered only for owners. A viewer or admin is not shown a control they
 * cannot use — the members panel already states who can delete, which is the
 * right place to learn it. The actual enforcement is neither of those: the
 * DELETE policy on `organisations` is `app.has_org_role(id, 'owner')`, and
 * this component being absent is a courtesy, not a boundary.
 */
export default function DeleteOrgPanel({
  orgId,
  orgName,
  memberCount,
  assessmentCount,
}: {
  orgId: string;
  orgName: string;
  memberCount: number;
  assessmentCount: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const matches = typed.trim() === orgName.trim();

  async function remove() {
    if (!matches || busy) return;
    setBusy(true);
    setError(null);

    try {
      const response = await fetch(`/api/org/${orgId}`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirm: typed.trim() }),
      });
      const payload = (await response.json()) as { error?: string };

      if (!response.ok) {
        setError(payload.error ?? 'Could not delete the organisation.');
        setBusy(false);
        return;
      }

      /*
       * Leave before refreshing. This page reads a row that no longer exists,
       * so refreshing in place would render `notFound()` at the URL of the
       * thing just deleted — technically correct and a poor way to be told
       * the action worked. `refresh` still runs, so the organisations list
       * that comes next is not the cached one containing this row.
       */
      router.push('/org');
      router.refresh();
    } catch {
      setError('Could not reach the server. Try again.');
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <section className="panel p-6">
        <p className="micro">Delete organisation</p>
        <p className="mt-3 max-w-[62ch] text-[12.5px] leading-relaxed text-tx-2">
          Deleting {orgName} also deletes every assessment filed under it. This cannot be undone.
        </p>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="btn-ghost mt-4 px-3 py-1.5 text-[12px]"
          style={{ color: 'rgb(var(--risk-bad))' }}
        >
          Delete this organisation
        </button>
      </section>
    );
  }

  return (
    <section className="panel p-6" style={{ borderColor: 'rgb(var(--risk-bad) / 0.4)' }}>
      <p className="micro" style={{ color: 'rgb(var(--risk-bad))' }}>
        Delete organisation
      </p>

      <p className="mt-3 max-w-[62ch] text-[12.5px] leading-relaxed text-tx-2">
        This permanently deletes:
      </p>
      <ul className="mt-2 max-w-[62ch] space-y-1 text-[12.5px] leading-relaxed text-tx-2">
        <li>
          · <span className="text-tx">{assessmentCount}</span> saved assessment
          {assessmentCount === 1 ? '' : 's'}, for every member, not just for you
        </li>
        <li>
          · the roster of <span className="text-tx">{memberCount}</span> member
          {memberCount === 1 ? '' : 's'}, and any live join code
        </li>
      </ul>
      <p className="mt-3 max-w-[62ch] text-[11.5px] leading-relaxed text-tx-3">
        Anonymised scores already contributed to the shared industry benchmarks stay in the corpus —
        they carry no reference to this organisation and cannot be traced back to it. Everything
        else is gone, and there is no recovery.
      </p>

      <label className="mt-5 block text-[11.5px] text-tx-3" htmlFor="confirm-org-name">
        Type <span className="font-mono text-tx">{orgName}</span> to confirm
      </label>
      <input
        id="confirm-org-name"
        type="text"
        value={typed}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => setTyped(event.target.value)}
        className="mt-2 w-full max-w-[320px] border border-line bg-ground px-3 py-2 font-mono text-[13px] text-tx
          outline-none transition-colors focus:border-line-strong focus-visible:outline
          focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-seal-ink"
      />

      {error && (
        <p className="mt-3 text-[12px]" style={{ color: 'rgb(var(--risk-bad))' }}>
          {error}
        </p>
      )}

      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          onClick={remove}
          disabled={!matches || busy}
          className="btn-ghost px-3 py-1.5 text-[12px] disabled:cursor-not-allowed disabled:opacity-40"
          style={{ color: 'rgb(var(--risk-bad))' }}
        >
          {busy ? 'Deleting…' : 'Delete permanently'}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setTyped('');
            setError(null);
          }}
          disabled={busy}
          className="text-[12px] text-tx-3 transition-colors hover:text-tx-2"
        >
          Cancel
        </button>
      </div>
    </section>
  );
}
