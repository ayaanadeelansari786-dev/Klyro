'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import type { OrgRole } from '@/lib/auth/context';

/**
 * The member list, and — for an administrator — the controls that change it.
 *
 * The roles existed in the schema from the beginning and there was no way to
 * assign one. Everybody who joined by code arrived as a viewer and stayed
 * one, which meant they could read the organisation's assessments and never
 * add to them: the scan form's "save this assessment to" control only offers
 * organisations the reader may actually write to, so for a viewer it does not
 * appear at all. An organisation could therefore fill up with people who
 * could see the portfolio and not contribute to it, with nothing anywhere
 * explaining why.
 *
 * What each role may do is spelled out under the list rather than left to the
 * word itself. "Analyst" does not tell anyone that this is the rank at which
 * saving to the organisation starts working, and that is the single fact
 * somebody choosing a role most needs.
 *
 * The rules about who may change whom are the database's, not this
 * component's — see the route. This renders a disabled control where the
 * server would refuse, which is a courtesy to save a round trip, and shows
 * the server's answer when it refuses anyway.
 */

export interface RosterMember {
  userId: string;
  name: string;
  role: OrgRole;
  isYou: boolean;
}

const ROLES: { value: OrgRole; label: string }[] = [
  { value: 'viewer', label: 'Viewer' },
  { value: 'analyst', label: 'Analyst' },
  { value: 'admin', label: 'Admin' },
  { value: 'owner', label: 'Owner' },
];

export default function MemberRoster({
  orgId,
  members,
  myRole,
}: {
  orgId: string;
  members: RosterMember[];
  myRole: OrgRole | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const isAdmin = myRole === 'admin' || myRole === 'owner';
  const isOwner = myRole === 'owner';

  async function send(method: 'PATCH' | 'DELETE', userId: string, role?: OrgRole) {
    setBusy(userId);
    setError(null);
    setNotice(null);

    try {
      const response = await fetch(`/api/org/${orgId}/members`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(role ? { userId, role } : { userId }),
      });
      const payload = (await response.json()) as { error?: string; message?: string };

      if (!response.ok) {
        setError(payload.error ?? 'That did not work.');
        return;
      }

      setNotice(payload.message ?? null);
      // The roster, the role summary line, and the join-code panel's own
      // permission gate all read from the server. Refreshing is what keeps
      // them agreeing with each other after a change.
      router.refresh();
    } catch {
      setError('Could not reach the server. Try again.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="panel overflow-hidden">
      <p className="micro px-6 py-4">Members</p>

      <ul className="border-t border-line">
        {members.map((member) => {
          /*
           * An owner's row is editable only by another owner — the same test
           * the UPDATE policy applies, mirrored here so an admin sees a
           * settled state rather than a control that always fails.
           */
          const editable = isAdmin && (member.role !== 'owner' || isOwner);
          const working = busy === member.userId;

          return (
            <li
              key={member.userId}
              className="ledger-row flex flex-wrap items-center gap-x-4 gap-y-2 px-6 py-3.5"
            >
              <span className="min-w-0 flex-1 truncate text-[13.5px] text-tx">
                {member.name}
                {member.isYou && <span className="ml-2 text-[11.5px] text-tx-3">you</span>}
              </span>

              {editable ? (
                <label className="flex items-center gap-2">
                  <span className="sr-only">Role for {member.name}</span>
                  <select
                    value={member.role}
                    disabled={working}
                    onChange={(event) => send('PATCH', member.userId, event.target.value as OrgRole)}
                    className="rounded border border-line bg-raised px-2 py-1 text-[12px] text-tx-2
                      outline-none transition-colors hover:border-line-strong focus:border-line-strong
                      disabled:opacity-50 focus-visible:outline focus-visible:outline-2
                      focus-visible:outline-offset-2 focus-visible:outline-seal-ink"
                  >
                    {ROLES.map((role) => (
                      <option
                        key={role.value}
                        value={role.value}
                        /* Only an owner can create an owner. Rendering the
                           option disabled rather than hiding it is the
                           difference between "you cannot do this" and "this
                           does not exist". */
                        disabled={role.value === 'owner' && !isOwner}
                      >
                        {role.label}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <span className="chip">{member.role}</span>
              )}

              {editable && !member.isYou && (
                <button
                  type="button"
                  disabled={working}
                  onClick={() => send('DELETE', member.userId)}
                  className="text-[11.5px] text-tx-3 transition-colors hover:text-tx disabled:opacity-50"
                >
                  Remove
                </button>
              )}
            </li>
          );
        })}
      </ul>

      {(error || notice) && (
        <p
          role="status"
          className="border-t border-line px-6 py-3 text-[12px]"
          style={error ? { color: 'rgb(var(--risk-bad))' } : undefined}
        >
          {error ?? notice}
        </p>
      )}

      <p className="border-t border-line px-6 py-4 text-[11.5px] leading-relaxed text-tx-3">
        Viewers read the organisation&rsquo;s assessments. <span className="text-tx-2">Analysts</span>{' '}
        can also save an assessment to it — below that rank the option does not appear on the scan
        form at all. Administrators manage members and the join code. Owners can additionally
        promote another owner and delete the organisation, and an organisation always keeps at least
        one.
      </p>
    </section>
  );
}
