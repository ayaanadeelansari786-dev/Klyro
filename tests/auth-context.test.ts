import { describe, expect, it } from 'vitest';

import { ANONYMOUS, resolveOwner, roleAtLeast } from '@/lib/auth/context';

/**
 * Deciding who a scan belongs to.
 *
 * The database enforces who may *read* an assessment. This decides what gets
 * written in the first place, and it is the one place where a claim from the
 * request body — "file this under organisation X" — is turned into ownership.
 * A mistake here writes someone's private supplier analysis into an
 * organisation they do not belong to, and no policy would catch it, because
 * from the database's point of view the row is legitimately owned.
 */

/** A Supabase client stubbed down to the one call `resolveOwner` makes. */
function clientReturning(role: string | null) {
  return {
    from() {
      return {
        select() {
          return {
            eq() {
              return {
                eq() {
                  return {
                    maybeSingle: async () => ({
                      data: role ? { role } : null,
                      error: null,
                    }),
                  };
                },
              };
            },
          };
        },
      };
    },
  } as never;
}

describe('role ranking', () => {
  it('orders viewer below analyst below admin below owner', () => {
    expect(roleAtLeast('owner', 'admin')).toBe(true);
    expect(roleAtLeast('admin', 'analyst')).toBe(true);
    expect(roleAtLeast('analyst', 'viewer')).toBe(true);

    expect(roleAtLeast('viewer', 'analyst')).toBe(false);
    expect(roleAtLeast('analyst', 'admin')).toBe(false);
    expect(roleAtLeast('admin', 'owner')).toBe(false);
  });

  it('treats absent membership as no privilege at all', () => {
    // The distinction between "not a member" and "member with the lowest role"
    // has to survive: null must never satisfy a minimum.
    expect(roleAtLeast(null, 'viewer')).toBe(false);
  });
});

describe('resolving ownership', () => {
  it('gives a signed-out visitor no ownership, so nothing is stored', async () => {
    expect(await resolveOwner(clientReturning('owner'), null, 'some-org')).toEqual(ANONYMOUS);
  });

  it('files a signed-in user’s scan personally by default', async () => {
    const owner = await resolveOwner(clientReturning(null), { id: 'user-1' }, null);

    expect(owner).toMatchObject({ userId: 'user-1', orgId: null, createdBy: 'user-1' });
  });

  it('files under an organisation when the caller is an analyst there', async () => {
    const owner = await resolveOwner(clientReturning('analyst'), { id: 'user-1' }, 'org-1');

    expect(owner).toMatchObject({ userId: null, orgId: 'org-1', createdBy: 'user-1' });
  });

  it('refuses to file under an organisation the caller does not belong to', async () => {
    // The attack: post `orgId` for an organisation you are not in, and your
    // scan lands inside their data — or, worse, becomes readable by them.
    const owner = await resolveOwner(clientReturning(null), { id: 'attacker' }, 'someone-elses-org');

    expect(owner.orgId).toBeNull();
    expect(owner.userId).toBe('attacker');
    expect(owner.notice).toMatch(/not one you belong to/);
  });

  it('refuses to file under an organisation where the caller is only a viewer', async () => {
    const owner = await resolveOwner(clientReturning('viewer'), { id: 'user-1' }, 'org-1');

    expect(owner.orgId).toBeNull();
    expect(owner.userId).toBe('user-1');
    expect(owner.notice).toMatch(/viewers can read/i);
  });

  it('lets an admin and an owner file for the organisation', async () => {
    for (const role of ['admin', 'owner']) {
      const owner = await resolveOwner(clientReturning(role), { id: 'user-1' }, 'org-1');
      expect(owner.orgId).toBe('org-1');
    }
  });

  it('falls back to personal rather than losing the assessment', async () => {
    // Twenty seconds of network work has already produced a complete result.
    // Discarding it over a mis-selected dropdown would be the wrong trade.
    const owner = await resolveOwner(clientReturning(null), { id: 'user-1' }, 'org-1');

    expect(owner.userId).toBe('user-1');
    expect(owner.notice).toBeTruthy();
  });

  it('never sets both owners at once', async () => {
    for (const role of [null, 'viewer', 'analyst', 'admin', 'owner']) {
      const owner = await resolveOwner(clientReturning(role), { id: 'user-1' }, 'org-1');
      // The database has a check constraint for this too; both exist because
      // one is a guarantee and the other is a diagnosis.
      expect(Number(Boolean(owner.userId)) + Number(Boolean(owner.orgId))).toBe(1);
    }
  });
});
