// ---------------------------------------------------------------------------
// Shared predicate for the `roleId` / `roleIds` access-profile shape
// (multi-role composition, 0.41.0): `roleId` is present only when exactly
// one role composes; a profile composing 2+ roles returns `roleIds` only,
// with `roleId` absent. Three call sites across this app each re-derived
// this same fact independently — factored out here so a future edge-case
// change (e.g. how an empty `roleIds: []` array should read) lands once
// instead of drifting between them.
// ---------------------------------------------------------------------------

import type { AccessProfileResponse } from '../api/vectrosApi';

/**
 * Whether a profile's role source is a composition of 2+ roles, as opposed
 * to a single role (`roleId`) or an inline-scopes profile (neither field).
 * Accepts a partial shape so callers with only `{ roleId, roleIds }` in
 * hand (e.g. a table row) don't need the full response type.
 */
export function isMultiRoleComposed(
  profile: Pick<AccessProfileResponse, 'roleId' | 'roleIds'> | null | undefined,
): boolean {
  return !profile?.roleId && (profile?.roleIds?.length ?? 0) > 0;
}
