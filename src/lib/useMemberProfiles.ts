// ---------------------------------------------------------------------------
// useMemberProfiles — a member's AccessProfiles across EVERY app context.
//
// Backed by the OWNER-gated developer-API route `GET /developer/users/{id}
// /profiles` (`developerApi.ts#listUserProfiles`), not the Vectros API SDK:
// the SDK's own cross-context lookup (`auth.listProfilesForPrincipal`) only
// answers cross-context for a caller looking up ITSELF or holding the
// `context-directory-read` capability, and admin-app's browser bearer
// deliberately holds neither (cross-context admin authority stays
// server-side, never on a browser bearer). So this hook is **OWNER-only by
// construction** — the query is disabled for a non-owner session, and callers
// read `'unavailable'` to mean "ask for this some other way" (MembersPage
// falls back to its existing single-default-context read), not an error.
// ---------------------------------------------------------------------------

import { useQuery } from '@tanstack/react-query';

import { useCurrentTenant, useActiveTenantId } from '../auth';
import { useDeveloperApi } from '../api/developerApi';
import type { AccessProfileResponse } from '../api/vectrosApi';
import { accessQueryKeys } from './accessQueryKeys';
import { drainPages, AUTH_PAGE_SIZE } from './drainPages';

/**
 * `undefined` while loading; `'unavailable'` when this session isn't an
 * OWNER (the query never runs); `'error'` on a genuine (non-403) failure;
 * otherwise every access profile the member holds, across every context.
 */
export type MemberProfilesResult =
  | undefined
  | 'unavailable'
  | 'error'
  | ReadonlyArray<AccessProfileResponse>;

export function useMemberProfiles(memberId: string | undefined): MemberProfilesResult {
  const tenant = useActiveTenantId();
  const { activeMembership } = useCurrentTenant();
  const isOwner = activeMembership?.role === 'OWNER';
  const { listUserProfiles } = useDeveloperApi();

  const query = useQuery({
    queryKey: accessQueryKeys.memberProfiles(tenant, memberId ?? ''),
    queryFn: () =>
      drainPages<AccessProfileResponse>((startFrom) =>
        listUserProfiles(memberId!, startFrom, AUTH_PAGE_SIZE),
      ),
    enabled: isOwner && Boolean(memberId),
  });

  if (!isOwner) return 'unavailable';
  if (query.isError) return 'error';
  if (query.isSuccess) return query.data;
  return undefined;
}
