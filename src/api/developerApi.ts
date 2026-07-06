// ---------------------------------------------------------------------------
// Developer API client — the owner-gated control-plane surface.
//
// **Why this exists alongside the SDK (./vectrosApi).** The partner API (and
// its SDK) is reached with a short-lived bearer that is pinned to a single app
// context, so it can only ever see or act within that one context. Two
// operations are inherently tenant-wide and cannot be performed by any single
// context-pinned bearer:
//
//   - **Listing** every app context in the tenant. A context-pinned bearer
//     lists only its own context, so an owner cannot enumerate their contexts
//     through the partner API at all.
//   - **Creating** a new app context. Provisioning a context is an
//     account-owner act; the capability that authorizes it is never minted into
//     a browser-held bearer, so a client-side create is rejected.
//
// Both are served by the Developer API, which authenticates with the user's
// Cognito session (the same identity that mints partner-API bearers) and is
// gated to account owners on the server. No provisioning-capable credential
// ever reaches the browser. Everything else about an app context — its detail,
// roles, and access profiles — is done through the SDK with a bearer minted for
// that specific context (see ./vectrosApi).
//
// **Forking.** The base URL comes from runtime config and the bearer is the
// Cognito id token obtained through the auth provider, so a fork that swaps the
// auth provider (or points at its own deployment) re-skins this file by changing
// config alone. The HTTP shape mirrors the partner API's: a JSON error envelope
// of `{ message, requestId }` and a `{ data, nextCursor }` page envelope.
// ---------------------------------------------------------------------------

import { useCallback } from 'react';

import { useAuth, useCurrentTenant } from '../auth';
import { API_CONFIG } from '../config';

/**
 * An app context as returned by the Developer API list/create routes. Mirrors
 * the partner API's app-context shape so the same row rendering works against
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
 * Error thrown by a failed Developer API call. Shaped to match how the rest of
 * the app reads API errors — `statusCode` and a `body` envelope carrying the
 * server's `message` + `requestId` — so it flows through {@link
 * ../components/ApiErrorAlert} and the request-id correlation line unchanged.
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
 * The two Developer API calls the app needs, bound to a tenant kind + a way to
 * obtain the Cognito id token. Pure (no React) so it is directly unit-testable;
 * the {@link useDeveloperApi} hook supplies the bindings at the call site.
 */
export interface DeveloperApi {
  /** List one page of the tenant's app contexts. */
  listAppContexts(startFrom?: string, limit?: number): Promise<AppContextPage>;
  /** Create (or idempotently return) an app context. */
  createAppContext(input: CreateAppContextInput): Promise<AppContextSummary>;
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
export function useDeveloperApi(): DeveloperApi {
  const { getIdToken } = useAuth();
  const { activeMembership } = useCurrentTenant();

  if (!activeMembership) {
    throw new Error(
      'useDeveloperApi: no active tenant membership. The developer-API pages ' +
        'must render inside the tenant gate (or, in tests, a CurrentTenantProvider ' +
        'seeded with an active membership).',
    );
  }
  const tenant: TenantKind = activeMembership.tenantKind === 'test' ? 'test' : 'live';

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

  return { listAppContexts, createAppContext };
}
