// ---------------------------------------------------------------------------
// Developer API client — the owner-gated control-plane surface.
//
// **Why this exists alongside the SDK (./vectrosApi).** The Vectros API (and
// its SDK) is reached with a short-lived bearer that is pinned to a single app
// context, so it can only ever see or act within that one context. Two
// operations are inherently tenant-wide and cannot be performed by any single
// context-pinned bearer:
//
//   - **Listing** every app context in the tenant. A context-pinned bearer
//     lists only its own context, so an owner cannot enumerate their contexts
//     through the Vectros API at all.
//   - **Creating** a new app context. Provisioning a context is an
//     account-owner act; the capability that authorizes it is never minted into
//     a browser-held bearer, so a client-side create is rejected.
//   - **Deleting** an app context. Teardown permanently erases the context and
//     everything in it, so the authority is likewise held server-side and gated
//     to account owners; the server additionally requires the contextId echoed
//     back as a `confirm` parameter before it will start the cascade.
//
// All three are served by the Developer API, which authenticates with the user's
// Cognito session (the same identity that mints Vectros API bearers) and is
// gated to account owners on the server. No provisioning-capable credential
// ever reaches the browser. Everything else about an app context — its detail,
// roles, and access profiles — is done through the SDK with a bearer minted for
// that specific context (see ./vectrosApi).
//
// **Forking.** The base URL comes from runtime config and the bearer is the
// Cognito id token obtained through the auth provider, so a fork that swaps the
// auth provider (or points at its own deployment) re-skins this file by changing
// config alone. The HTTP shape mirrors the Vectros API's: a JSON error envelope
// of `{ message, requestId }` and a `{ data, nextCursor }` page envelope.
// ---------------------------------------------------------------------------

import { useCallback } from 'react';

import { useAuth, useCurrentTenant } from '../auth';
import { API_CONFIG } from '../config';
import type { AdminLogsResponse, ScopedKeyResponse } from './vectrosApi';

/**
 * An app context as returned by the Developer API list/create routes. Mirrors
 * the Vectros API's app-context shape so the same row rendering works against
 * either source. `name`/`description`/timestamps are optional on the wire.
 */
export interface AppContextSummary {
  /** Opaque composite id; also the pagination cursor (`startFrom`). */
  readonly id?: string;
  /** The caller-chosen context identifier. */
  readonly contextId?: string;
  readonly name?: string;
  readonly description?: string;
  /** ISO-8601 UTC creation timestamp. */
  readonly createdAt?: string;
  /** ISO-8601 UTC last-modified timestamp. */
  readonly lastModified?: string;
  /** Lifecycle status: `active` | `purging` | `deleted`. */
  readonly status?: string;
}

/** One page of the `{ data, nextCursor }` list envelope. */
export interface AppContextPage {
  readonly data: ReadonlyArray<AppContextSummary>;
  readonly nextCursor: string | null;
}

/** Request body for creating an app context. */
export interface CreateAppContextInput {
  readonly contextId: string;
  readonly name?: string;
  readonly description?: string;
}

/** Which of the account's tenants a Developer API call targets. */
export type TenantKind = 'live' | 'test';

/**
 * An opt-in self-service signup rule on a registered issuer: a caller-nameable `signupType` paired
 * with the role a brand-new, no-invite exchange caller is bound to.
 */
export interface SelfSignupPolicy {
  readonly signup_type: string;
  readonly role_id: string;
}

/**
 * A registered trusted third-party IdP issuer, as returned by the Developer API's issuer routes.
 * Mirrors most of the Vectros API's issuer shape. Carries no secrets — `jwksUri` is a public
 * discovery endpoint, not a credential. **Gap:** the platform's `userinfoUri` field (an OIDC
 * userinfo-endpoint email-resolution fallback) isn't typed here and isn't shown by this UI —
 * this surface hasn't caught up to it yet. Use the CLI/SDK to read or set it.
 */
export interface IssuerSummary {
  readonly issuerId?: string;
  readonly issuer?: string;
  readonly jwksUri?: string;
  readonly audience?: string;
  readonly contextId?: string;
  readonly subClaim?: string;
  readonly emailClaim?: string;
  /** `active` | `suspended`. A suspended issuer's tokens are rejected at exchange time identically
   *  to an unregistered issuer. */
  readonly status?: string;
  /** ISO-8601 UTC registration timestamp. */
  readonly createdAt?: string;
  readonly selfSignupPolicies?: ReadonlyArray<SelfSignupPolicy>;
}

/** One page of the `{ data, nextCursor }` issuer list envelope. */
export interface IssuerPage {
  readonly data: ReadonlyArray<IssuerSummary>;
  readonly nextCursor: string | null;
}

/**
 * Partial-update request body for a registered issuer's SAFE fields only. `issuer`/`jwksUri`/
 * `audience`/`contextId` are trust-anchor / routing-pin fields — they are not part of this input
 * shape at all, so this client can never even attempt to change them; the server would reject a
 * differing value anyway. Fields omitted here leave the stored value unchanged. **`userinfoUri` is
 * ALSO a platform safe field but isn't part of this input shape yet** — this UI can't set it; use
 * the CLI/SDK.
 */
export interface UpdateIssuerInput {
  readonly subClaim?: string;
  readonly emailClaim?: string;
  readonly status?: string;
  readonly selfSignupPolicies?: ReadonlyArray<SelfSignupPolicy>;
}

/** Response from a successful ownership transfer. */
export interface AccountOwnerTransferResult {
  readonly partnerId: string;
  /** The new owner's member id (the same `targetUserId` that was passed in). */
  readonly ownerUserId: string;
}

/**
 * One trigger execution that failed. Same field set the SDK's `GET /v1/trigger-failures` and the
 * `trigger.failed` webhook envelope carry, plus `contextId` — this route is account-wide, so which
 * context a failure came from is part of the shape here where it isn't on the single-context SDK
 * surface.
 */
export interface TriggerFailureEntry {
  readonly id: string;
  readonly contextId: string;
  readonly ruleId: string;
  readonly ruleName?: string;
  readonly category: string;
  readonly retryable?: boolean;
  readonly detail?: string;
  readonly correlationId?: string;
  readonly attempts?: number;
  readonly schemaId?: string;
  readonly event?: string;
  readonly recordId?: string;
  readonly executionDepth?: number;
  readonly durationMs?: number;
  /** ISO-8601 UTC — when this firing first failed. */
  readonly createdAt?: string;
  /** ISO-8601 UTC — the most recent failed attempt. */
  readonly updatedAt?: string;
}

/**
 * Query for the account-wide trigger-failures list. Omitting `contextId` walks every app context
 * in the account, in a fixed deterministic order (not one chronological timeline — see
 * {@link TriggerFailuresResponse}'s own doc); supplying it narrows to one context, which must
 * belong to this account or the call fails with a uniform not-found.
 */
export interface TriggerFailuresQuery {
  readonly contextId?: string;
  readonly ruleId?: string;
  readonly category?: string;
  readonly retryable?: boolean;
  /** ISO-8601 UTC — only failures that first occurred at or after this instant. */
  readonly from?: string;
  /** ISO-8601 UTC — only failures that first occurred before this instant. */
  readonly to?: string;
  readonly startFrom?: string;
  readonly limit?: number;
}

/**
 * One page of trigger failures. `incomplete`/`contextsNotSearched` name any app context this page
 * could not read (a transient fault) — a caller MUST surface these rather than let an honest gap
 * read as "nothing failed" (the same discipline `accessLog.coverageBody` states for disclosures).
 * Results are newest-first WITHIN a context; walked across contexts in a fixed order, not merged
 * into one account-wide timeline — a design tradeoff for a cursor whose size doesn't grow with the
 * account's context count.
 */
export interface TriggerFailuresResponse {
  readonly data: ReadonlyArray<TriggerFailureEntry>;
  readonly nextCursor: string | null;
  readonly incomplete: boolean;
  readonly contextsNotSearched: ReadonlyArray<string>;
  /** True when the account's context LIST itself (not a specific context's failures) could not be
   *  read — distinct from a name appearing in `contextsNotSearched`, which always holds real
   *  contextIds only. `incomplete` is also true whenever this is. */
  readonly contextListUnavailable: boolean;
}

/**
 * Query for the account activity log. `startTime` is required (ISO-8601 UTC);
 * everything else narrows the result. Omitting `contextId` returns activity
 * across every app context in the account — a single context-pinned credential
 * cannot produce that account-wide view, which is why this rides the Developer
 * API. Supplying `contextId` narrows to one context.
 */
export interface AdminLogsQuery {
  /** Start of the window, ISO-8601 UTC (e.g. `2025-01-15T09:00:00Z`). */
  readonly startTime: string;
  /** End of the window, ISO-8601 UTC; defaults to now when omitted. */
  readonly endTime?: string;
  /** Resource filter (e.g. `documents`), or omit for all resources. */
  readonly resource?: string;
  /** HTTP method filter, or omit for all methods. */
  readonly method?: string;
  /** API key id filter, or omit for all keys. */
  readonly keyId?: string;
  /** App context filter, or omit for every context in the account. */
  readonly contextId?: string;
  /** When true, only entries with a status of 400+ are returned. */
  readonly errorsOnly?: boolean;
  /** Max entries to return (server clamps to its hard cap). */
  readonly limit?: number;
}

/**
 * Error thrown by a failed Developer API call. Shaped to match how the rest of
 * the app reads API errors — `statusCode` and a `body` envelope carrying the
 * server's `message` + `requestId` — so it flows through `@vectros-ai/react`'s
 * `ApiErrorAlert` and the request-id correlation line unchanged.
 */
export class DeveloperApiError extends Error {
  readonly statusCode: number;
  readonly body: { readonly message?: string; readonly requestId?: string };

  constructor(statusCode: number, body: { message?: string; requestId?: string }) {
    super(body.message ?? `Developer API request failed (${statusCode})`);
    this.name = 'DeveloperApiError';
    this.statusCode = statusCode;
    this.body = body;
  }
}

/** Join the configured base URL (which may end in `/`) with a route path. */
function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

/**
 * Parse a Developer API response: returns the decoded JSON on success, throws a
 * {@link DeveloperApiError} carrying the server's `{ message, requestId }` on a
 * non-2xx (degrading gracefully when the body is empty or not JSON).
 */
async function parse<T>(resp: Response): Promise<T> {
  const text = await resp.text();
  let json: unknown = undefined;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      // Non-JSON body (e.g. an upstream gateway error page) — leave json unset.
    }
  }
  if (!resp.ok) {
    const envelope = (json ?? {}) as { message?: string; requestId?: string };
    throw new DeveloperApiError(resp.status, envelope);
  }
  return json as T;
}

/**
 * The Developer API calls the app needs, bound to a tenant kind + a way to
 * obtain the Cognito id token. Pure (no React) so it is directly unit-testable;
 * the {@link useDeveloperApi} hook supplies the bindings at the call site.
 */
export interface DeveloperApi {
  /** List one page of the tenant's app contexts. */
  listAppContexts(startFrom?: string, limit?: number): Promise<AppContextPage>;
  /** Create (or idempotently return) an app context. */
  createAppContext(input: CreateAppContextInput): Promise<AppContextSummary>;
  /**
   * Tear down an app context — permanently erases the context and everything
   * in it (records, documents, folders, schemas, roles, access profiles). The
   * server requires the contextId echoed as a `confirm` parameter and responds
   * 202: the cascade runs asynchronously, with the context reported as
   * `purging` until it finishes draining.
   */
  deleteAppContext(contextId: string): Promise<void>;
  /**
   * List one page of the tenant's registered trusted issuers. Registering a new issuer requires a
   * root key or the non-grantable `provisioning:c` capability — neither ever reaches the browser —
   * so, like app-context creation, no client-side create exists here; this is read + edit only.
   */
  listIssuers(startFrom?: string, limit?: number): Promise<IssuerPage>;
  /**
   * Update an issuer's safe fields (`subClaim`/`emailClaim`/`status`/`selfSignupPolicies` — NOT the
   * platform's full safe-field set, see {@link UpdateIssuerInput}'s own doc re: `userinfoUri`).
   * Setting `status: 'suspended'` rejects the issuer's tokens at exchange time identically to an
   * unregistered issuer. The trust-anchor fields (`issuer`/`jwksUri`/`audience`) and the routing-pin
   * `contextId` are immutable and not part of {@link UpdateIssuerInput} at all — rotating one means
   * deleting and re-registering the issuer (via the CLI/SDK — not exposed in this UI).
   */
  updateIssuer(issuerId: string, input: UpdateIssuerInput): Promise<IssuerSummary>;
  /**
   * List every scoped API key in the account, across both environments and ALL
   * app contexts. A context-pinned bearer only ever sees its own context's keys,
   * so this account-wide view lives on the Developer API instead.
   */
  listScopedKeys(): Promise<ReadonlyArray<ScopedKeyResponse>>;
  /**
   * Revoke a scoped API key by id, regardless of which app context it is bound
   * to. Idempotent — revoking an already-revoked key succeeds.
   */
  revokeScopedKey(keyId: string): Promise<void>;
  /**
   * Read the account activity log across every app context (or a single one when
   * {@link AdminLogsQuery.contextId} is set). Tenant-wide by design.
   */
  getAdminLogs(query: AdminLogsQuery): Promise<AdminLogsResponse>;
  /**
   * Read a page of trigger execution failures across every app context (or a single one when
   * {@link TriggerFailuresQuery.contextId} is set). Account-wide by design — the single-context SDK
   * surface (`client.triggers` / `GET /v1/trigger-failures`) can't produce this view.
   */
  getTriggerFailures(query: TriggerFailuresQuery): Promise<TriggerFailuresResponse>;
  /**
   * Transfer this account's OWNER role to another member
   * (`POST /developer/account-owner`). `targetUserId` is a member id
   * (the same id MembersPage lists), not a raw Cognito subject; the server
   * resolves it internally and requires the target to already be a member who
   * has signed in at least once.
   *
   * **Account-wide, not tenant-scoped**: unlike every other method here, this
   * one never reads {@link TenantKind} — on success the new owner gains OWNER
   * authority across BOTH the live and test tenants in one call, regardless of
   * which tenant kind this `DeveloperApi` instance was constructed for.
   *
   * **Irreversible for the CALLER**: their own OWNER-gated `/developer/*`
   * access ends immediately on success; only the new owner can transfer it
   * back. Already-minted credentials (`st_*`, `ssk_*`, `sk_*`) are NOT
   * revoked — they keep working until they expire or are rotated.
   */
  transferOwnership(targetUserId: string): Promise<AccountOwnerTransferResult>;
}

/** Construct a {@link DeveloperApi} from its dependencies. */
export function createDeveloperApi(deps: {
  readonly baseUrl: string;
  readonly tenant: TenantKind;
  readonly getIdToken: () => Promise<string | null>;
}): DeveloperApi {
  const authHeader = async (): Promise<Record<string, string>> => {
    const token = await deps.getIdToken();
    if (!token) {
      // No session — surface as a 401 in the same envelope shape a server
      // would, so callers handle it through the one error path.
      throw new DeveloperApiError(401, { message: 'Not authenticated' });
    }
    return { Authorization: `Bearer ${token}` };
  };

  return {
    async listAppContexts(startFrom, limit) {
      const params = new URLSearchParams({ tenant: deps.tenant });
      if (startFrom) params.set('startFrom', startFrom);
      if (limit !== undefined) params.set('limit', String(limit));
      const resp = await fetch(
        endpoint(deps.baseUrl, `/developer/app-contexts?${params.toString()}`),
        { method: 'GET', headers: await authHeader() },
      );
      return parse<AppContextPage>(resp);
    },

    async createAppContext(input) {
      const params = new URLSearchParams({ tenant: deps.tenant });
      const resp = await fetch(
        endpoint(deps.baseUrl, `/developer/app-contexts?${params.toString()}`),
        {
          method: 'POST',
          headers: { ...(await authHeader()), 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        },
      );
      return parse<AppContextSummary>(resp);
    },

    async deleteAppContext(contextId) {
      // The server's irreversible-operation contract: the contextId must be
      // echoed back as `confirm`, or the request is rejected with a 400.
      const params = new URLSearchParams({ tenant: deps.tenant, confirm: contextId });
      const resp = await fetch(
        endpoint(
          deps.baseUrl,
          `/developer/app-contexts/${encodeURIComponent(contextId)}?${params.toString()}`,
        ),
        { method: 'DELETE', headers: await authHeader() },
      );
      // 202 with an empty body on success; parse() still maps errors.
      await parse<void>(resp);
    },

    async listIssuers(startFrom, limit) {
      const params = new URLSearchParams({ tenant: deps.tenant });
      if (startFrom) params.set('startFrom', startFrom);
      if (limit !== undefined) params.set('limit', String(limit));
      const resp = await fetch(
        endpoint(deps.baseUrl, `/developer/issuers?${params.toString()}`),
        { method: 'GET', headers: await authHeader() },
      );
      return parse<IssuerPage>(resp);
    },

    async updateIssuer(issuerId, input) {
      const params = new URLSearchParams({ tenant: deps.tenant });
      const resp = await fetch(
        endpoint(deps.baseUrl, `/developer/issuers/${encodeURIComponent(issuerId)}?${params.toString()}`),
        {
          method: 'PUT',
          headers: { ...(await authHeader()), 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        },
      );
      return parse<IssuerSummary>(resp);
    },

    async listScopedKeys() {
      const resp = await fetch(endpoint(deps.baseUrl, `/developer/scoped-keys`), {
        method: 'GET',
        headers: await authHeader(),
      });
      // Same `{ data, nextCursor }` page envelope as the app-context list; the
      // account's key count is small, so a single unpaginated page is returned.
      const page = await parse<{ data?: ReadonlyArray<ScopedKeyResponse> }>(resp);
      return page.data ?? [];
    },

    async revokeScopedKey(keyId) {
      const resp = await fetch(
        endpoint(deps.baseUrl, `/developer/scoped-keys/${encodeURIComponent(keyId)}`),
        { method: 'DELETE', headers: await authHeader() },
      );
      // 204 with an empty body on success; parse() still maps errors.
      await parse<void>(resp);
    },

    async getAdminLogs(query) {
      const params = new URLSearchParams({ tenant: deps.tenant, startTime: query.startTime });
      if (query.endTime) params.set('endTime', query.endTime);
      if (query.resource) params.set('resource', query.resource);
      if (query.method) params.set('method', query.method);
      if (query.keyId) params.set('keyId', query.keyId);
      if (query.contextId) params.set('contextId', query.contextId);
      if (query.errorsOnly) params.set('errorsOnly', 'true');
      if (query.limit !== undefined) params.set('limit', String(query.limit));
      const resp = await fetch(
        endpoint(deps.baseUrl, `/developer/logs?${params.toString()}`),
        { method: 'GET', headers: await authHeader() },
      );
      return parse<AdminLogsResponse>(resp);
    },

    async getTriggerFailures(query) {
      const params = new URLSearchParams({ tenant: deps.tenant });
      if (query.contextId) params.set('contextId', query.contextId);
      if (query.ruleId) params.set('ruleId', query.ruleId);
      if (query.category) params.set('category', query.category);
      if (query.retryable !== undefined) params.set('retryable', String(query.retryable));
      if (query.from) params.set('from', query.from);
      if (query.to) params.set('to', query.to);
      if (query.startFrom) params.set('startFrom', query.startFrom);
      if (query.limit !== undefined) params.set('limit', String(query.limit));
      const resp = await fetch(
        endpoint(deps.baseUrl, `/developer/trigger-failures?${params.toString()}`),
        { method: 'GET', headers: await authHeader() },
      );
      return parse<TriggerFailuresResponse>(resp);
    },

    async transferOwnership(targetUserId) {
      // No `tenant` param — see the interface doc: this acts on the whole
      // account, not one tenant kind.
      const resp = await fetch(endpoint(deps.baseUrl, `/developer/account-owner`), {
        method: 'POST',
        headers: { ...(await authHeader()), 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetUserId }),
      });
      return parse<AccountOwnerTransferResult>(resp);
    },
  };
}

/**
 * React hook returning a {@link DeveloperApi} bound to the active tenant. Reads
 * the id token from the auth provider and the tenant's live/test kind from the
 * active membership — both already resolved by the providers the app mounts.
 *
 * Throws if there is no active membership: the app-context pages render behind
 * the tenant gate, so a missing membership is a wiring bug, and silently
 * defaulting the tenant kind could target the wrong tenant.
 */
export function useDeveloperApi(tenantOverride?: TenantKind): DeveloperApi {
  const { getIdToken } = useAuth();
  const { activeMembership } = useCurrentTenant();

  if (!activeMembership) {
    throw new Error(
      'useDeveloperApi: no active tenant membership. The developer-API pages ' +
        'must render inside the tenant gate (or, in tests, a CurrentTenantProvider ' +
        'seeded with an active membership).',
    );
  }
  // Defaults to the active tenant's kind; a caller operating in a DIFFERENT
  // environment (e.g. the scoped-key wizard's env radio) overrides it so the
  // whole flow stays in one tenant.
  const tenant: TenantKind =
    tenantOverride ?? (activeMembership.tenantKind === 'test' ? 'test' : 'live');

  // Stable across renders for the same tenant kind so dependent queryFns don't
  // re-create their identity on every render.
  const listAppContexts = useCallback(
    (startFrom?: string, limit?: number) =>
      createDeveloperApi({ baseUrl: API_CONFIG.developerApiBase, tenant, getIdToken }).listAppContexts(
        startFrom,
        limit,
      ),
    [tenant, getIdToken],
  );
  const createAppContext = useCallback(
    (input: CreateAppContextInput) =>
      createDeveloperApi({ baseUrl: API_CONFIG.developerApiBase, tenant, getIdToken }).createAppContext(input),
    [tenant, getIdToken],
  );
  const deleteAppContext = useCallback(
    (contextId: string) =>
      createDeveloperApi({ baseUrl: API_CONFIG.developerApiBase, tenant, getIdToken }).deleteAppContext(contextId),
    [tenant, getIdToken],
  );
  const listIssuers = useCallback(
    (startFrom?: string, limit?: number) =>
      createDeveloperApi({ baseUrl: API_CONFIG.developerApiBase, tenant, getIdToken }).listIssuers(
        startFrom,
        limit,
      ),
    [tenant, getIdToken],
  );
  const updateIssuer = useCallback(
    (issuerId: string, input: UpdateIssuerInput) =>
      createDeveloperApi({ baseUrl: API_CONFIG.developerApiBase, tenant, getIdToken }).updateIssuer(
        issuerId,
        input,
      ),
    [tenant, getIdToken],
  );
  const listScopedKeys = useCallback(
    () => createDeveloperApi({ baseUrl: API_CONFIG.developerApiBase, tenant, getIdToken }).listScopedKeys(),
    [tenant, getIdToken],
  );
  const revokeScopedKey = useCallback(
    (keyId: string) =>
      createDeveloperApi({ baseUrl: API_CONFIG.developerApiBase, tenant, getIdToken }).revokeScopedKey(keyId),
    [tenant, getIdToken],
  );
  const getAdminLogs = useCallback(
    (query: AdminLogsQuery) =>
      createDeveloperApi({ baseUrl: API_CONFIG.developerApiBase, tenant, getIdToken }).getAdminLogs(query),
    [tenant, getIdToken],
  );
  const getTriggerFailures = useCallback(
    (query: TriggerFailuresQuery) =>
      createDeveloperApi({ baseUrl: API_CONFIG.developerApiBase, tenant, getIdToken }).getTriggerFailures(
        query,
      ),
    [tenant, getIdToken],
  );
  const transferOwnership = useCallback(
    (targetUserId: string) =>
      createDeveloperApi({ baseUrl: API_CONFIG.developerApiBase, tenant, getIdToken }).transferOwnership(
        targetUserId,
      ),
    [tenant, getIdToken],
  );

  return {
    listAppContexts,
    createAppContext,
    deleteAppContext,
    listIssuers,
    updateIssuer,
    listScopedKeys,
    revokeScopedKey,
    getAdminLogs,
    getTriggerFailures,
    transferOwnership,
  };
}
