// ---------------------------------------------------------------------------
// contextBinding — a test helper that makes the bearer↔request relationship
// VISIBLE to a unit test.
//
// **The blind spot this exists to close.** A page reaches the API through
// `vectrosApiClient(tenantId, contextId?)`. Those two arguments PIN the bearer
// the returned client mints: a non-root credential may act only inside the
// tenant and context it is pinned to, so a request naming a DIFFERENT
// `contextId` (or `tenantId`) fails closed with a 403 server-side. Nothing in
// the client's TypeScript types couples them — `vectrosApiClient(tenant)
// .auth.listRoles({ contextId: 'elsewhere' })` compiles — and a suite that
// stubs `vectrosApiClient` as a bare `vi.fn()` (ignoring its arguments)
// asserts request SHAPE while staying completely blind to the mismatch. A
// whole page's worth of calls can 403 against the real API with the suite
// green.
//
// Two invariants, stated once here instead of re-derived per suite:
//
//   1. AGREEMENT — for every call naming a `contextId`/`tenantId`,
//      the client's own value must resolve equal to it, where
//      `resolveBearerContext(undefined) === 'default'` (the mint's rule: an
//      omitted context resolves to the base `default` context, so a
//      context-less client is pinned to `default`, NOT to "whatever the
//      request asks for").
//   2. LEGALITY — the resolved bearer context must not be the reserved
//      control-plane context. Agreement alone is not enough: pinning BOTH
//      sides to it is self-consistent and still broken, because the mint
//      rejects that context outright (400) before any binding check runs. That
//      is the more obvious of the two ways to "fix" a mismatch, so the helper
//      has to fail it.
//
// Usage: build the mock client factory with {@link makeBindingTrackedClient},
// wire it as `vectrosApiClient`'s implementation, exercise the component, then
// assert with {@link expectContextBindingHolds}, naming the exact set of
// context-scoped methods you expect — see that function on why a count is not
// good enough.
//
// **Three limitations, deliberately stated rather than silently held:**
//
// - It reads `contextId`/`tenantId` only as TOP-LEVEL properties of the first
//   argument. A call that nests them (e.g. `updateAppContext`'s
//   `{ contextId, body: { … } }` shape) or passes them positionally records
//   `undefined` and is EXEMPT from invariant 1 — it is not checked, and
//   "didn't name one" is indistinguishable here from "named one I didn't look
//   for". `expectedMethods` is what stops that becoming a silent exemption:
//   a method you expected to be context-scoped that records nothing fails.
// - It wraps OWN ENUMERABLE function properties of each sub-client. A real
//   (class-based) `VectrosClient` keeps its methods on the prototype, so this
//   wraps a plain-object mock only. That fails loudly (an empty wrapper), not
//   silently.
// - Both sides of the `default` comparison resolve through the SAME imported
//   `RESERVED_DEFAULT_CONTEXT_ID` — the components' via their own alias, the
//   bearer's via the fallback below. Changing that constant's value moves both
//   together and this helper cannot see it. The literal `'default'`
//   assertions in `MembersPage.test.tsx` / `InviteMemberDialog.test.tsx` are
//   what pin it to the value the API actually reserves; do not find/replace
//   them away.
// ---------------------------------------------------------------------------

import { expect } from 'vitest';

import {
  RESERVED_DEFAULT_CONTEXT_ID,
  RESERVED_VECTROS_ADMIN_CONTEXT_ID,
} from '../lib/reservedContexts';

/** One observed API call, with both halves of each binding. */
export interface ContextBindingRecord {
  /** `<subClient>.<method>`, e.g. `auth.listRoles` — for readable failures. */
  readonly method: string;
  /** The `contextId` the client (and so its bearer) was created with. */
  readonly clientContextId: string | undefined;
  /** The `contextId` named in the request, if it names one at the top level. */
  readonly requestContextId: string | undefined;
  /** The `tenantId` the client was created with. */
  readonly clientTenantId: string;
  /** The `tenantId` named in the request, if it names one at the top level. */
  readonly requestTenantId: string | undefined;
}

/**
 * The context a bearer is actually pinned to. An omitted `contextId` mints
 * against the base `default` context — both token-mint endpoints normalise an
 * absent context to it, and that is the rule this helper mirrors. It is also
 * why a context-less client is NOT a wildcard.
 */
export function resolveBearerContext(clientContextId: string | undefined): string {
  return clientContextId ?? RESERVED_DEFAULT_CONTEXT_ID;
}

/**
 * Wrap a mock client so every method call records both binding pairs.
 *
 * The built client is MEMOIZED per `(tenantId, contextId)` slot, mirroring the
 * real factory's own cache. Without that, a fixture using
 * `mockResolvedValueOnce(...)` chains (the pagination idiom) would be rebuilt
 * on every call and silently re-serve its first page forever.
 *
 * @param build   builds the mock client for a slot — receives the `contextId`
 *                asked for, so a fixture may vary its response per context.
 * @param records the array every observed call is appended to.
 * @returns a `vectrosApiClient`-shaped implementation to hand to
 *          `vi.mocked(vectrosApiClient).mockImplementation(...)`.
 */
export function makeBindingTrackedClient<C extends Record<string, Record<string, unknown>>>(
  build: (contextId: string | undefined) => C,
  records: ContextBindingRecord[],
): (tenantId: string, contextId?: string) => C {
  const bySlot = new Map<string, C>();
  return (tenantId: string, contextId?: string): C => {
    const slot = `${tenantId}|${contextId ?? ''}`;
    const cached = bySlot.get(slot);
    if (cached) return cached;

    const client = build(contextId);
    const wrapped: Record<string, Record<string, unknown>> = {};
    for (const [subName, sub] of Object.entries(client)) {
      const wrappedSub: Record<string, unknown> = {};
      for (const [methodName, method] of Object.entries(sub)) {
        if (typeof method !== 'function') {
          wrappedSub[methodName] = method;
          continue;
        }
        wrappedSub[methodName] = (...args: unknown[]): unknown => {
          records.push({
            method: `${subName}.${methodName}`,
            clientContextId: contextId,
            requestContextId: readString(args[0], 'contextId'),
            clientTenantId: tenantId,
            requestTenantId: readString(args[0], 'tenantId'),
          });
          // Delegate to the ORIGINAL mock fn, so a test holding a reference to
          // it can still assert shape with toHaveBeenCalledWith.
          return (method as (...a: unknown[]) => unknown)(...args);
        };
      }
      wrapped[subName] = wrappedSub;
    }
    const result = wrapped as C;
    bySlot.set(slot, result);
    return result;
  };
}

/** Pull a top-level string property off a request argument, if it carries one. */
function readString(arg: unknown, key: string): string | undefined {
  if (typeof arg !== 'object' || arg === null) return undefined;
  const value = (arg as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Assert both binding invariants over every recorded call, and that the set of
 * context-scoped methods observed is EXACTLY `expectedMethods`.
 *
 * The set — not a count. A scalar floor is satisfiable by the wrong calls: add
 * a member to a fixture and one more per-row lookup covers for a mutation that
 * dropped a different call entirely, leaving that call unchecked with the
 * assertion still green. Naming the methods makes a dropped call fail and an
 * unexpected new one visible.
 *
 * @param records        every call observed during the test
 * @param expectedMethods the `sub.method` names that MUST each appear at least
 *                        once among the context-scoped calls, and the only
 *                        ones that may
 */
export function expectContextBindingHolds(
  records: readonly ContextBindingRecord[],
  expectedMethods: readonly string[],
): void {
  const scoped = records.filter((r) => r.requestContextId !== undefined);

  expect(
    [...new Set(scoped.map((r) => r.method))].sort(),
    'context-scoped methods observed (all calls seen: ' +
      `${records.map((r) => r.method).join(', ') || 'none'})`,
  ).toEqual([...new Set(expectedMethods)].sort());

  const violations: string[] = [];

  // AGREEMENT — only meaningful for a call that names a context.
  for (const r of scoped) {
    const bearerContext = resolveBearerContext(r.clientContextId);
    const pinned =
      r.clientContextId === undefined ? 'omitted' : `'${r.clientContextId}'`;
    if (bearerContext !== r.requestContextId) {
      violations.push(
        `${r.method}: bearer pinned to '${bearerContext}' (client contextId ${pinned}) ` +
          `but request named '${r.requestContextId}' — this 403s server-side`,
      );
    }
  }

  // LEGALITY — over EVERY record, not just the scoped ones. The mint fails on
  // the bearer's own context, so a client pinned to the reserved context is
  // broken whether or not its request happens to name a context; scoping this
  // to `scoped` exempted exactly the tenant-wide calls that ride the same
  // bearer.
  for (const r of records) {
    if (resolveBearerContext(r.clientContextId) === RESERVED_VECTROS_ADMIN_CONTEXT_ID) {
      violations.push(
        `${r.method}: bearer pinned to the reserved control-plane context ` +
          `'${RESERVED_VECTROS_ADMIN_CONTEXT_ID}' — no bearer can be minted for it, ` +
          `so this 400s at the mint before the request is ever sent`,
      );
    }
  }

  // The tenant is the other pinned dimension; a request naming a different one
  // is the same class of failure and just as invisible without this.
  for (const r of records) {
    if (r.requestTenantId !== undefined && r.requestTenantId !== r.clientTenantId) {
      violations.push(
        `${r.method}: bearer pinned to tenant '${r.clientTenantId}' but request ` +
          `named '${r.requestTenantId}'`,
      );
    }
  }

  // `expect(violations).toEqual([])` would render as "expected [ Array(1) ] to
  // deeply equal []" — the diff carries the detail but the MESSAGE does not, so
  // the explanations above never reach a CI log or a `.toThrow` matcher. Fail
  // explicitly with the text inline instead; these messages are the whole point
  // of the check, and a guard whose failure output says nothing is half a guard.
  if (violations.length > 0) {
    expect.fail(
      `context/tenant binding violations:\n  - ${violations.join('\n  - ')}`,
    );
  }
}
