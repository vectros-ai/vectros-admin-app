// ---------------------------------------------------------------------------
// namespaceRegistry — the shared, override-aware namespace registry client.
//
// `GET /v1/namespaces` splits by OWNER, not by filter: omit `?contextId=` and
// you get the tenant-wide registrations only; supply it and you get exactly
// that context's OWN registrations — never both in one call. The namespaces a
// context actually sees are the union of the two, with the context's own row
// SHADOWING a same-named tenant-wide row of the same name (the platform's own
// namespace-resolution rule). Every consumer that needs "the namespaces
// registered for context X" — the entity browser (entityBacked only) and the
// namespace-authoring suggestions in ScopeEditor / identity overrides (every
// registration, not just entity-backed) — needs this same two-call merge, so
// it lives here once rather than twice.
//
// `org` and `client` are NOT built-ins: a new tenant registers zero
// namespaces, this included, and there is no name special-casing anywhere in
// this module.
// ---------------------------------------------------------------------------

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';

import { useActiveTenantId } from '../auth';
import type { TenantId } from '../auth';
import { vectrosApiClient } from '../api/vectrosApi';
import type { NamespaceResponse } from '../api/vectrosApi';
import { accessQueryKeys } from './accessQueryKeys';
import { drainPages, AUTH_PAGE_SIZE } from './drainPages';

/**
 * One resolved namespace registration, as seen by a specific context: either
 * the tenant-wide row, or that context's own row shadowing it. `contextId`
 * is `null` for a tenant-wide registration (mirrors the wire shape) — never
 * this hook's *calling* context, so a caller resolving namespace X for
 * context A that turns out to be tenant-wide sees `contextId: null`, not `A`.
 */
export interface RegisteredNamespace {
  readonly namespace: string;
  readonly entityBacked: boolean;
  readonly contextId: string | null;
  readonly defaultSchemaId: string | null;
}

function toRegisteredNamespace(raw: NamespaceResponse): RegisteredNamespace | null {
  if (!raw.namespace) return null;
  return {
    namespace: raw.namespace,
    entityBacked: raw.entityBacked === true,
    contextId: raw.contextId ?? null,
    defaultSchemaId: raw.defaultSchemaId ?? null,
  };
}

/**
 * Merge a tenant-wide page with one context's own page: the context's own
 * row shadows a same-named tenant-wide row (the platform's own namespace-
 * resolution rule), and every namespace with no context-owned override
 * passes through unchanged.
 * Declared order is tenant-wide first, then any context-own namespace not
 * already shadowed — order isn't meaningful to any consumer, but is kept
 * deterministic for testability.
 */
export function mergeNamespaces(
  tenantWide: readonly NamespaceResponse[],
  contextOwn: readonly NamespaceResponse[],
): RegisteredNamespace[] {
  const own = new Map<string, RegisteredNamespace>();
  for (const raw of contextOwn) {
    const ns = toRegisteredNamespace(raw);
    if (ns) own.set(ns.namespace, ns);
  }
  const merged: RegisteredNamespace[] = [];
  const seen = new Set<string>();
  for (const raw of tenantWide) {
    const ns = toRegisteredNamespace(raw);
    if (!ns) continue;
    const shadowed = own.get(ns.namespace);
    merged.push(shadowed ?? ns);
    seen.add(ns.namespace);
  }
  for (const ns of own.values()) {
    if (!seen.has(ns.namespace)) merged.push(ns);
  }
  return merged;
}

export interface NamespaceRegistryResult {
  /** The merged, override-aware namespace list. `[]` while loading. */
  readonly namespaces: readonly RegisteredNamespace[];
  readonly isLoading: boolean;
  readonly isError: boolean;
  /** The first failing query's error, if any — enough for an `ApiErrorAlert`. */
  readonly error: unknown;
}

/**
 * The namespaces context `ctxId` can see: tenant-wide ∪ its own, merged per
 * {@link mergeNamespaces}. Two independent queries (so either can be cached
 * and invalidated on its own — the tenant-wide page is shared by every
 * context, the context-own page is not) combined client-side.
 *
 * `tenantOverride` is for a caller that operates in a DIFFERENT tenant than
 * the globally active one (e.g. a wizard step with its own env/tenant
 * picker) — omit it to use the active tenant. Always call `useActiveTenantId`
 * (a hook can't be called conditionally); the override, when given, simply
 * wins.
 */
export function useNamespaceRegistry(
  ctxId: string,
  tenantOverride?: TenantId,
): NamespaceRegistryResult {
  const activeTenant = useActiveTenantId();
  const tenant = tenantOverride ?? activeTenant;

  const tenantWideQuery = useQuery({
    queryKey: accessQueryKeys.namespacesTenantWide(tenant),
    queryFn: () =>
      drainPages<NamespaceResponse>((startFrom) =>
        vectrosApiClient(tenant).identity.listNamespaces(
          startFrom === undefined ? { limit: AUTH_PAGE_SIZE } : { startFrom, limit: AUTH_PAGE_SIZE },
        ),
      ),
  });

  const contextOwnQuery = useQuery({
    queryKey: accessQueryKeys.namespacesForContext(tenant, ctxId),
    queryFn: () =>
      drainPages<NamespaceResponse>((startFrom) =>
        vectrosApiClient(tenant, ctxId).identity.listNamespaces(
          startFrom === undefined
            ? { contextId: ctxId, limit: AUTH_PAGE_SIZE }
            : { contextId: ctxId, startFrom, limit: AUTH_PAGE_SIZE },
        ),
      ),
    enabled: ctxId !== '',
  });

  const namespaces = useMemo(
    () => mergeNamespaces(tenantWideQuery.data ?? [], contextOwnQuery.data ?? []),
    [tenantWideQuery.data, contextOwnQuery.data],
  );

  return {
    namespaces,
    isLoading: tenantWideQuery.isLoading || contextOwnQuery.isLoading,
    isError: tenantWideQuery.isError || contextOwnQuery.isError,
    error: tenantWideQuery.error ?? contextOwnQuery.error,
  };
}
