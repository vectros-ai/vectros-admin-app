// ---------------------------------------------------------------------------
// Vectros API client — admin-app's @vectros-ai/sdk wiring.
//
// **Why the SDK (not hand-rolled axios):** admin-app is the canonical
// public-reference app for partners building on top of the Vectros API.
// "Use our SDK" is the partner story; hand-rolling our own HTTP client
// here would contradict the framing. The SDK is type-safe (regenerated
// from the backend's OpenAPI spec per MR), so admin-app's call sites
// stay in sync with backend changes by construction — adding a new
// field or endpoint on the backend means we get it for free on the
// next SDK version bump.
//
// **Auth bridge:** the SDK accepts a `Supplier<BearerToken>` (which is
// `() => Promise<string>`), letting us delegate token resolution to the
// existing `vectrosApiTokenCache.getVectrosApiToken(env)`. The cache's
// race-condition defenses (in-flight Promise coalescing + cacheGeneration
// counter) carry over unchanged.
//
// **Per-(tenant, context) client instances:** Partner Dev Admins manage TWO
// tenants (live + test), and each tenant has one or more app contexts. The
// SDK's bearer-token Supplier is closed over both at construction time, so we
// keep one VectrosClient per (tenant, context) pair, cached lazily in a
// module-level Map. The base URL is the same for all of them — the tenant +
// context discrimination happens server-side via the bearer token's claims.
//
// **Why the optional `contextId`.** A minted bearer is pinned to a single app
// context and may act ONLY within it (a non-root credential is context-confined
// server-side). The control-plane pages (Members, Scoped Keys, Logs) operate in
// the reserved admin context, so they omit `contextId` and get the default
// admin-context bearer. The context-scoped pages (an app context's detail, its
// roles and access profiles) MUST pass the context they're operating in, so the
// bearer is minted for that context — otherwise every call naming a different
// context fails closed with a 403. Listing or creating contexts themselves is a
// tenant-wide, owner-gated operation no single context-pinned bearer can
// perform; those go through the developer API instead (see ./developerApi).
//
// **Distribution model:** `@vectros-ai/sdk` is a published npm package,
// pinned by exact version in `package.json`; bumping it is a deliberate
// action. A fork installs it from npm like any other dependency — the
// app code stays identical.
//
// The SDK is generated from the partner API's OpenAPI spec.
// ---------------------------------------------------------------------------

import { VectrosClient } from '@vectros-ai/sdk';

import { getVectrosApiToken } from '../auth';
import type { TenantId } from '../auth';
import { API_CONFIG } from '../config';

/**
 * Lazy-init cache. One VectrosClient per (tenant, context) pair — the auth
 * callback is bound to both. Keyed by `${tenantId}|${contextId ?? ''}`; the
 * `|` separator cannot appear in a tenant id or a validated context id, so the
 * join is unambiguous and the no-context key (`<tenantId>|`) stays distinct.
 */
const clientsByKey = new Map<string, VectrosClient>();

/** Composite cache key for a (tenant, context) slot — see {@link clientsByKey}. */
function clientKey(tenantId: TenantId, contextId?: string): string {
  return `${tenantId}|${contextId ?? ''}`;
}

/**
 * Get the configured `VectrosClient` for a tenant and (optionally) an app
 * context. Lazily instantiates + caches; subsequent calls with the same
 * arguments return the same instance so consumers don't spawn extra clients
 * per render.
 *
 * Usage from pages:
 *
 *     const tenant = useActiveTenantId();
 *     // Control-plane page (reserved admin context) — omit the context:
 *     const users = await vectrosApiClient(tenant).identity.listUsers();
 *     // Context-scoped page (operating inside `ctxId`) — pass it:
 *     const roles = await vectrosApiClient(tenant, ctxId).auth.listRoles({ contextId: ctxId });
 *
 * The SDK exposes sub-clients on the returned `VectrosClient`:
 *   - `.identity` — listUsers / createUser / getUser / updateUser / deleteUser
 *   - `.auth` — createInvite / resendInvite / scoped-keys (4 methods) /
 *     getAdminLogs / appContexts (5) / accessProfiles (6) / profileRoles
 *     (5) / mintToken / getJwks / getUsage / ping / listProfilesForPrincipal
 *   - `.documents`, `.folders`, `.inference`, `.records`, `.schemas`,
 *     `.search` — domain-data surfaces (out of scope for admin-app's
 *     Members/Keys/Logs pages but available for forks).
 *
 * Request / response types are reachable via `import type { Vectros } from
 * '../api/vectrosApi'` — then `Vectros.UserResponse`, `Vectros.CreateInviteRequest`,
 * etc.
 */
export function vectrosApiClient(tenantId: TenantId, contextId?: string): VectrosClient {
  const key = clientKey(tenantId, contextId);
  let client = clientsByKey.get(key);
  if (!client) {
    client = new VectrosClient({
      // The SDK accepts `environment` as a Supplier<string>. Every tenant +
      // context shares one base URL (the Vectros-API host); the discrimination
      // happens via the bearer token's claims, not the URL.
      environment: API_CONFIG.vectrosApiBase,
      // Bearer-token Supplier — closed over `tenantId` + `contextId`. The cache's
      // coalescing + generation defenses handle concurrent callers + the
      // logout-during-mint race, and key on the same (tenant, context) slot.
      token: (): Promise<string> => getVectrosApiToken(tenantId, contextId),
    });
    clientsByKey.set(key, client);
  }
  return client;
}

/**
 * Test-only helper. Clears the per-(tenant, context) client cache so each test
 * starts with fresh instances. NOT exported from the auth barrel; only test
 * files import this directly.
 */
export function __resetVectrosApiClientCacheForTest(): void {
  clientsByKey.clear();
}

// ---------------------------------------------------------------------------
// Re-exports for consumer convenience.
//
// The SDK's request/response types live under the `Vectros` namespace
// (Fern's convention — re-exported from `index$8` etc. in the dist). We
// re-export the namespace so pages can do:
//
//     import { vectrosApiClient } from '../api/vectrosApi';
//     import type { Vectros } from '../api/vectrosApi';
//
//     const user: Vectros.UserResponse = await client.identity.getUser({ id });
//     // (list endpoints return the { data, nextCursor } page envelope — see drainPages)
//
// Top-level types (`VectrosClient`, `VectrosError`, `VectrosTimeoutError`)
// are exposed directly for the common error-handling pattern:
//
//     try { ... } catch (e) {
//       if (e instanceof VectrosError) ...
//     }
// ---------------------------------------------------------------------------

// Vectros is the SDK's catch-all namespace (request/response types +
// runtime namespaces like `UserResponse.Status`). Re-exported as a
// value (no `type` keyword) so consumers can use `Vectros.X` as both
// type and value.
export { Vectros } from '@vectros-ai/sdk';
export type { VectrosClient } from '@vectros-ai/sdk';
export { VectrosError, VectrosTimeoutError } from '@vectros-ai/sdk';

// Type re-exports for the SDK shapes admin-app's pages consume.
//
// **Why derived from method return types** (rather than `Vectros.UserResponse`
// etc. directly): a handful of SDK types (UserResponse, ScopedKeyResponse,
// AppContextResponse, etc.) are declared as `interface X` paired with a
// companion `declare namespace X { const Status = ... }` for enum
// constants. When re-exported through the SDK's `index_X as X` namespace
// re-export pattern, TypeScript's name resolution loses the interface
// merge across the indirection — `Vectros.UserResponse` then resolves to
// the namespace value, not the interface type. Deriving from method
// return signatures (`ReturnType<VectrosClient['identity']['getUser']>`)
// sidesteps the issue because the SDK's method signatures reference the
// interface directly, not via the indirection.
import type { VectrosClient as _VectrosClient } from '@vectros-ai/sdk';

type _Identity = _VectrosClient['identity'];
type _Auth = _VectrosClient['auth'];

export type UserResponse = Awaited<ReturnType<_Identity['getUser']>>;
export type CreateInviteResponse = Awaited<ReturnType<_Auth['createInvite']>>;
export type ScopedKeyResponse = Awaited<ReturnType<_Auth['getScopedKey']>>;
export type AdminLogsResponse = Awaited<ReturnType<_Auth['getAdminLogs']>>;
/** A single parsed log entry from `AdminLogsResponse.entries[]`. */
export type LogEntry = AdminLogsResponse['entries'][number];
export type AppContextResponse = Awaited<ReturnType<_Auth['getAppContext']>>;
export type AccessProfileResponse = Awaited<ReturnType<_Auth['getAccessProfile']>>;
export type RoleResponse = Awaited<
  ReturnType<_Auth['getRole']>
>;

// Request types are passed directly into method calls so we extract them
// from the first parameter position.
export type CreateInviteRequest = Parameters<_Auth['createInvite']>[0];
export type CreateScopedKeyRequest = Parameters<_Auth['createScopedKey']>[0];
export type GetAdminLogsRequest = Parameters<_Auth['getAdminLogs']>[0];

// Read-access (accounting-of-disclosures) log — GET /v1/admin/access-log. The
// subject-scoped §164.528 query: who read a subject's data, when, and whether
// any sensitive value was actually revealed. The request carries the query axes
// (subject / context / optional filters + time window + cursor); the response is
// the `{ data, nextCursor }` page envelope.
export type GetAccessLogRequest = NonNullable<Parameters<_Auth['getAccessLog']>[0]>;
export type ReadAccessLogPage = Awaited<ReturnType<_Auth['getAccessLog']>>;
/** A single read-access row from `ReadAccessLogPage.data[]`. */
export type ReadAccessLogRow = NonNullable<ReadAccessLogPage['data']>[number];

// Typed status-coded error subclasses (ConflictError, BadRequestError, etc.)
// live under the `Vectros` namespace — see the SDK's index.d.ts. Consumer
// pages dispatch on `err instanceof VectrosError && err.statusCode === N`
// rather than pulling the namespaced typed-error classes individually. The
// VectrosError base already exposes `body: unknown` for inspecting the
// error response body, which is what admin-app's domain-specific catch
// handlers (e.g., the `email_already_associated` precheck
// branch) actually need.
