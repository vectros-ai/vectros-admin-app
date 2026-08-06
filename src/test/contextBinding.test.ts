// ---------------------------------------------------------------------------
// contextBinding.test.ts — tests for the test helper.
//
// Not ceremony. `contextBinding.ts` is ~130 lines of pure assertion logic
// whose ONLY failure mode is silence: invert its comparison, drop a record, or
// widen a filter, and every suite that uses it stays green while checking
// nothing. That is precisely the "a guard that cannot fail proves nothing"
// shape it was written to catch, one level up — so each case below pins a
// condition the helper MUST reject, not merely one it accepts.
//
// Mutation-verified (2026-08-04), unmutated baseline green through the same
// path first. All seven mutations turn at least one case below red:
//   - `!==` → `===` in the agreement check
//   - `readString` returning undefined unconditionally
//   - dropping the reserved-context (legality) check
//   - dropping the tenant check
//   - comparing method-name SETS by length instead of value
//   - removing the `records.push`
//   - making the `expect.fail` branch unreachable (violations swallowed)
//
// The fifth SURVIVED the first run: every set case differed in SIZE, so a
// length comparison passed all of them. "FAILS a same-size set whose method
// NAMES differ" exists because of that, and is the case none of the others
// implied — which is the argument for running the mutations rather than
// reasoning about which ones would be caught.
// ---------------------------------------------------------------------------

import { describe, expect, it, vi } from 'vitest';

import {
  expectContextBindingHolds,
  makeBindingTrackedClient,
  resolveBearerContext,
} from './contextBinding';
import type { ContextBindingRecord } from './contextBinding';

const TENANT = 'tenant-a';

/** A minimal two-method mock client, shaped like the real sub-client tree. */
function makeClient() {
  return {
    auth: {
      listRoles: vi.fn().mockResolvedValue({ data: [], nextCursor: null }),
      getAccessProfile: vi.fn().mockResolvedValue({ principalId: 'usr_x' }),
    },
    identity: {
      listUsers: vi.fn().mockResolvedValue({ data: [], nextCursor: null }),
    },
  };
}

describe('resolveBearerContext', () => {
  it('resolves an omitted context to the base default context', () => {
    // The mint's own rule. If this drifts, every agreement check silently
    // changes meaning for context-less clients — which is most of admin-app.
    expect(resolveBearerContext(undefined)).toBe('default');
  });

  it('passes an explicit context through unchanged', () => {
    expect(resolveBearerContext('ctx-a')).toBe('ctx-a');
  });
});

describe('makeBindingTrackedClient', () => {
  it('records both halves of both bindings', async () => {
    const records: ContextBindingRecord[] = [];
    const factory = makeBindingTrackedClient(() => makeClient(), records);

    await factory(TENANT, 'ctx-a').auth.listRoles({ contextId: 'ctx-a', limit: 100 });

    expect(records).toEqual([
      {
        method: 'auth.listRoles',
        clientContextId: 'ctx-a',
        requestContextId: 'ctx-a',
        clientTenantId: TENANT,
        requestTenantId: undefined,
      },
    ]);
  });

  it('delegates to the underlying mock, preserving shape assertions', async () => {
    // The wrapper must not cost a suite its toHaveBeenCalledWith — otherwise a
    // test cannot check binding and shape in one case.
    const records: ContextBindingRecord[] = [];
    const client = makeClient();
    const factory = makeBindingTrackedClient(() => client, records);

    await factory(TENANT).auth.getAccessProfile({ contextId: 'default', principalId: 'usr_x' });

    expect(client.auth.getAccessProfile).toHaveBeenCalledWith({
      contextId: 'default',
      principalId: 'usr_x',
    });
  });

  it('memoizes per (tenant, context) so once-mocks are not re-served', async () => {
    // A drain calls the factory once per page. Rebuilding the client each time
    // resets mockResolvedValueOnce chains, so page 1 would be served forever
    // and the drain would silently duplicate it.
    const records: ContextBindingRecord[] = [];
    let builds = 0;
    const factory = makeBindingTrackedClient(() => {
      builds++;
      const c = makeClient();
      c.identity.listUsers
        .mockResolvedValueOnce({ data: [{ id: 'a' }], nextCursor: 'c1' })
        .mockResolvedValueOnce({ data: [{ id: 'b' }], nextCursor: null });
      return c;
    }, records);

    const first = await factory(TENANT).identity.listUsers({});
    const second = await factory(TENANT).identity.listUsers({ startFrom: 'c1' });

    expect(builds).toBe(1);
    expect(first).toEqual({ data: [{ id: 'a' }], nextCursor: 'c1' });
    expect(second).toEqual({ data: [{ id: 'b' }], nextCursor: null });
  });

  it('builds a separate client per distinct context slot', async () => {
    const records: ContextBindingRecord[] = [];
    const seen: (string | undefined)[] = [];
    const factory = makeBindingTrackedClient((ctx) => {
      seen.push(ctx);
      return makeClient();
    }, records);

    await factory(TENANT, 'ctx-a').auth.listRoles({ contextId: 'ctx-a' });
    await factory(TENANT, 'ctx-b').auth.listRoles({ contextId: 'ctx-b' });

    expect(seen).toEqual(['ctx-a', 'ctx-b']);
  });

  it('passes non-function properties through untouched', async () => {
    const records: ContextBindingRecord[] = [];
    const factory = makeBindingTrackedClient(
      () => ({ auth: { baseUrl: 'https://example.test', listRoles: vi.fn() } }),
      records,
    );
    expect(factory(TENANT).auth.baseUrl).toBe('https://example.test');
  });
});

describe('expectContextBindingHolds', () => {
  /** Record builder — defaults to a well-formed, passing call. */
  function rec(over: Partial<ContextBindingRecord> = {}): ContextBindingRecord {
    return {
      method: 'auth.listRoles',
      clientContextId: undefined,
      requestContextId: 'default',
      clientTenantId: TENANT,
      requestTenantId: undefined,
      ...over,
    };
  }

  it('passes a context-less client naming default', () => {
    expectContextBindingHolds([rec()], ['auth.listRoles']);
  });

  it('passes an explicitly pinned client naming its own context', () => {
    expectContextBindingHolds(
      [rec({ clientContextId: 'ctx-a', requestContextId: 'ctx-a' })],
      ['auth.listRoles'],
    );
  });

  // ---- the cases that must FAIL -----------------------------------------

  it('FAILS the exact bug this branch fixes: default bearer, control-plane request', () => {
    expect(() =>
      expectContextBindingHolds(
        [rec({ clientContextId: undefined, requestContextId: 'vectros-admin' })],
        ['auth.listRoles'],
      ),
    ).toThrow(/bearer pinned to 'default'.*request named 'vectros-admin'/s);
  });

  it('FAILS a self-consistent pin to the reserved control-plane context', () => {
    // The OTHER way to "fix" a mismatch — move the bearer instead of the
    // request. Agreement holds; the mint 400s. Without the legality check this
    // is the regression that walks straight past the guard.
    expect(() =>
      expectContextBindingHolds(
        [rec({ clientContextId: 'vectros-admin', requestContextId: 'vectros-admin' })],
        ['auth.listRoles'],
      ),
    ).toThrow(/reserved control-plane context/);
  });

  it('FAILS a reserved-context bearer even on a call that names NO context', () => {
    // The tenant-wide calls ride the same bearer as the scoped ones. Checking
    // legality only over context-scoped records exempted exactly those, so a
    // page whose only reserved-context-pinned call was tenant-wide passed.
    expect(() =>
      expectContextBindingHolds(
        [
          rec({ clientContextId: 'vectros-admin', requestContextId: undefined,
                method: 'identity.listUsers' }),
        ],
        [],
      ),
    ).toThrow(/reserved control-plane context/);
  });

  it('FAILS a mismatch between two ordinary contexts', () => {
    expect(() =>
      expectContextBindingHolds(
        [rec({ clientContextId: 'ctx-a', requestContextId: 'ctx-b' })],
        ['auth.listRoles'],
      ),
    ).toThrow(/403s server-side/);
  });

  it('FAILS a tenant mismatch even when the context agrees', () => {
    expect(() =>
      expectContextBindingHolds(
        [rec({ requestTenantId: 'tenant-b' })],
        ['auth.listRoles'],
      ),
    ).toThrow(/bearer pinned to tenant 'tenant-a'.*named 'tenant-b'/s);
  });

  it('FAILS when an expected context-scoped call never happened', () => {
    // The vacuity guard. A component that silently stops making one of its
    // calls must fail here, not quietly weaken the assertion.
    expect(() =>
      expectContextBindingHolds([rec()], ['auth.listRoles', 'auth.createInvite']),
    ).toThrow();
  });

  it('FAILS on zero observed calls', () => {
    expect(() => expectContextBindingHolds([], ['auth.listRoles'])).toThrow();
  });

  it('FAILS a same-size set whose method NAMES differ', () => {
    // Found by mutation testing: every other set case above differs in SIZE,
    // so comparing sizes instead of names passed all of them. One call
    // swapped for another is the realistic regression — a page rewired to a
    // different endpoint keeps the count and changes the meaning.
    expect(() =>
      expectContextBindingHolds([rec({ method: 'auth.listRoles' })], ['auth.createInvite']),
    ).toThrow();
  });

  it('FAILS when an unexpected context-scoped call appears', () => {
    expect(() =>
      expectContextBindingHolds(
        [rec(), rec({ method: 'auth.deleteEverything' })],
        ['auth.listRoles'],
      ),
    ).toThrow();
  });

  it('does not exempt a call from the method set just because it repeats', () => {
    // Three lookups + one resend must still require BOTH names — a count-based
    // floor would be satisfied by the three alone.
    expect(() =>
      expectContextBindingHolds(
        [rec(), rec(), rec(), rec()],
        ['auth.listRoles', 'auth.resendInvite'],
      ),
    ).toThrow();
  });

  it('ignores calls that name no contextId (tenant-wide reads)', () => {
    // identity.listUsers is tenant-wide; it must not be forced into the set.
    expectContextBindingHolds(
      [rec(), rec({ method: 'identity.listUsers', requestContextId: undefined })],
      ['auth.listRoles'],
    );
  });
});
