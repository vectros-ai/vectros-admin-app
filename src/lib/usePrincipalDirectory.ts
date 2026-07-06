// ---------------------------------------------------------------------------
// usePrincipalDirectory — resolve access-profile principals to human labels.
//
// An access profile binds a *principal* — a user (`usr_<userId>`) or an API key
// (`key_<keyId>`) — to a role or inline scopes. The raw `usr_<uuid>` id is
// meaningless in the UI, so this hook loads the tenant's users once and maps
// each `usr_<id>` principal back to the user's email (the human-readable
// identifier the rest of the app shows). Keys have no name source, so they
// display as their id.
//
// The directory is tenant-wide (users are not context-partitioned), so it reads
// through the tenant's admin-context client — the same source the Members page
// uses — and is cached per tenant.
// ---------------------------------------------------------------------------

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';

import { useActiveTenantId } from '../auth';
import { vectrosApiClient } from '../api/vectrosApi';
import type { UserResponse } from '../api/vectrosApi';
import { drainPages, AUTH_PAGE_SIZE } from './drainPages';

/** The `usr_` / `key_` principal prefixes (mirrors the server's discriminator). */
export const PRINCIPAL_PREFIX_USER = 'usr_';
export const PRINCIPAL_PREFIX_KEY = 'key_';

/** The principal id for a user — `usr_<userId>`. */
export function userPrincipalId(userId: string): string {
  return `${PRINCIPAL_PREFIX_USER}${userId}`;
}

/** A principal resolved (or not) to a human label. */
export interface ResolvedPrincipal {
  readonly kind: 'user' | 'key' | 'unknown';
  /**
   * Human-readable label — a user's email, then their externalId (data-plane /
   * SDK-created users often have an externalId but no email, same fallback the
   * Members page uses), then the raw principal id as a last resort.
   */
  readonly label: string;
  /**
   * True when `label` is a real name (email / externalId) rather than the raw
   * id — lets the UI show the raw id as a secondary line only when it adds info.
   */
  readonly hasName: boolean;
  /** The raw principal id (`usr_<id>` / `key_<id>`), shown as secondary detail. */
  readonly principalId: string;
  /** The matched user, when the principal is a resolvable `usr_` id. */
  readonly user?: UserResponse;
  /** True for a `usr_` principal with no matching current user (e.g. removed). */
  readonly unresolved: boolean;
}

/** Best human label for a user: email, then externalId (mirrors Members). */
export function userLabel(user: UserResponse): string | undefined {
  return user.email ?? user.externalId ?? undefined;
}

export interface PrincipalDirectory {
  /** All tenant users (for an assign-by-name picker). */
  readonly users: ReadonlyArray<UserResponse>;
  readonly isLoading: boolean;
  readonly isError: boolean;
  /** Resolve a principal id to a human label. */
  readonly resolve: (principalId: string) => ResolvedPrincipal;
}

/**
 * Load the tenant's users and expose a principal → human-label resolver plus
 * the user list (for an assign-by-name picker).
 */
export function usePrincipalDirectory(): PrincipalDirectory {
  const tenant = useActiveTenantId();

  const usersQuery = useQuery({
    queryKey: ['principalDirectory', tenant],
    queryFn: () =>
      drainPages<UserResponse>((startFrom) =>
        vectrosApiClient(tenant).identity.listUsers(
          startFrom === undefined
            ? { limit: AUTH_PAGE_SIZE }
            : { startFrom, limit: AUTH_PAGE_SIZE },
        ),
      ),
  });

  const users = useMemo<UserResponse[]>(() => usersQuery.data ?? [], [usersQuery.data]);

  const byPrincipal = useMemo(() => {
    const map = new Map<string, UserResponse>();
    for (const u of users) {
      if (u.id) map.set(userPrincipalId(u.id), u);
    }
    return map;
  }, [users]);

  const resolve = useMemo(
    () =>
      (principalId: string): ResolvedPrincipal => {
        if (principalId.startsWith(PRINCIPAL_PREFIX_USER)) {
          const user = byPrincipal.get(principalId);
          const name = user ? userLabel(user) : undefined;
          return {
            kind: 'user',
            label: name ?? principalId,
            hasName: name !== undefined,
            principalId,
            ...(user ? { user } : {}),
            unresolved: !user,
          };
        }
        if (principalId.startsWith(PRINCIPAL_PREFIX_KEY)) {
          return { kind: 'key', label: principalId, hasName: false, principalId, unresolved: false };
        }
        return { kind: 'unknown', label: principalId, hasName: false, principalId, unresolved: false };
      },
    [byPrincipal],
  );

  return {
    users,
    isLoading: usersQuery.isLoading,
    isError: usersQuery.isError,
    resolve,
  };
}
