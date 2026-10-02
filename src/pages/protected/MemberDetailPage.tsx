// ---------------------------------------------------------------------------
// MemberDetailPage — admin-app's `/members/:id` detail view.
//
// Functional scope:
//   - Identity summary: id (+ the `usr_<id>` principal), email, externalId,
//     status, type, externalSubject, created — everything `UserResponse`
//     carries except the create-only `created` flag and the raw `payload`
//     (rendered separately below).
//   - Payload — schema-aware when the user carries a `schemaId`: resolved via
//     `schemasForSurface(..., 'user')` + `RecordFormFields` (disabled), the
//     SAME reusable primitives EntitiesTab.tsx already uses for identity
//     entities (`entity` surface) — this is that pattern's first `user`-surface
//     caller, per `SchemaSurface`'s own doc comment in `schemaSurfaces.ts`.
//     The raw JSON payload is ALWAYS rendered too, schema or not — same
//     reasoning as EntitiesTab's EntityDetailDialog: RecordFormFields silently
//     drops array/object fields and any key the schema doesn't declare, so
//     the raw view is what actually keeps "nothing silently hidden" true.
//   - Profiles across every app context, via `useMemberProfiles` —
//     OWNER-only (see that hook's module doc); a
//     SUB_USER session sees `members.profileCrossContextUnavailable` instead
//     of a guess.
//
// Read-only. Editing a member's identity fields happens nowhere in admin-app
// today (MembersPage doesn't offer it either) — out of scope here.
// ---------------------------------------------------------------------------

import { useMemo } from 'react';
import { Link as RouterLink, useParams } from 'react-router';
import { Box, Breadcrumbs, Link, Paper, Stack, Typography } from '@mui/material';
import { FormattedMessage, useIntl } from 'react-intl';
import { useQuery } from '@tanstack/react-query';
import { ApiErrorAlert, LoadingBlock, RecordFormFields, schemasForSurface } from '@vectros-ai/react';
import type { TypedSchema } from '@vectros-ai/react';

import { useActiveTenantId } from '../../auth';
import { vectrosApiClient } from '../../api/vectrosApi';
import { accessQueryKeys } from '../../lib/accessQueryKeys';
import { drainPages, AUTH_PAGE_SIZE } from '../../lib/drainPages';
import { userPrincipalId } from '../../lib/usePrincipalDirectory';
import { useMemberProfiles } from '../../lib/useMemberProfiles';
import { MemberProfileChipList } from '../../components/MemberProfileChipList';

export function MemberDetailPage(): React.JSX.Element {
  const intl = useIntl();
  const tenant = useActiveTenantId();
  const { id = '' } = useParams<{ id: string }>();

  const userQuery = useQuery({
    queryKey: accessQueryKeys.member(tenant, id),
    queryFn: () => vectrosApiClient(tenant).identity.getUser({ id }),
    enabled: id !== '',
  });
  const user = userQuery.data;

  // Schema resolution — same shape as EntitiesTab's useSchemasForEntitySurface,
  // on the `user` surface instead of `entity`. A 403 here (this session may
  // not hold `schemas:r`) isn't retried — the raw-payload fallback below
  // handles it, not a spinner loop.
  const schemasQuery = useQuery({
    queryKey: accessQueryKeys.userSurfaceSchemas(tenant),
    queryFn: () =>
      drainPages((startFrom) =>
        vectrosApiClient(tenant).schemas.listSchemas(
          startFrom === undefined
            ? { surface: 'user', limit: AUTH_PAGE_SIZE }
            : { surface: 'user', startFrom, limit: AUTH_PAGE_SIZE },
        ),
      ),
    retry: false,
  });
  const schemasById = useMemo(() => {
    const userSchemas = schemasForSurface(schemasQuery.data ?? [], 'user');
    const map = new Map<string, TypedSchema>();
    for (const s of userSchemas) if (s.id) map.set(s.id, s);
    return map;
  }, [schemasQuery.data]);
  const schema = user?.schemaId ? schemasById.get(user.schemaId) : undefined;
  const payload = (user?.payload ?? {}) as Record<string, unknown>;

  const profiles = useMemberProfiles(id || undefined);

  const label = user?.email ?? user?.externalId ?? id;

  return (
    <Stack spacing={3}>
      <Breadcrumbs aria-label={intl.formatMessage({ id: 'members.detail.breadcrumbRoot' })}>
        <Link component={RouterLink} to="/members" color="inherit" underline="hover">
          <FormattedMessage id="members.title" />
        </Link>
        <Typography color="text.primary" sx={{ fontFamily: 'monospace', fontSize: 14 }}>
          {label}
        </Typography>
      </Breadcrumbs>

      <Box>
        <Typography variant="h4" component="h1" sx={{ fontWeight: 700 }}>
          {label}
        </Typography>
        {id && (
          <Typography variant="body2" color="text.secondary" sx={{ fontFamily: 'monospace' }}>
            {userPrincipalId(id)}
          </Typography>
        )}
      </Box>

      {userQuery.isError && (
        <ApiErrorAlert error={userQuery.error}>
          <FormattedMessage id="members.detail.loadErrorBody" />
        </ApiErrorAlert>
      )}

      {userQuery.isLoading && (
        <LoadingBlock label={intl.formatMessage({ id: 'members.detail.loading' })} />
      )}

      {user && (
        <Stack spacing={3}>
          <Paper sx={{ p: 3 }}>
            <Typography variant="overline" color="text.secondary" component="div" sx={{ mb: 1.5 }}>
              <FormattedMessage id="members.detail.identitySectionTitle" />
            </Typography>
            <Stack spacing={1.5}>
              <DetailRow labelId="members.detail.fieldId" value={user.id} monospace />
              <DetailRow labelId="members.columnEmail" value={user.email} />
              <DetailRow labelId="members.detail.fieldExternalId" value={user.externalId} monospace />
              <DetailRow
                labelId="members.columnStatus"
                value={
                  user.status &&
                  intl.formatMessage({
                    id:
                      user.status === 'ACTIVE'
                        ? 'members.statusActive'
                        : user.status === 'PENDING'
                          ? 'members.statusPending'
                          : 'members.statusSuspended',
                  })
                }
              />
              <DetailRow
                labelId="members.columnType"
                value={
                  user.type &&
                  intl.formatMessage({
                    id: user.type === 'SERVICE' ? 'members.typeService' : 'members.typeHuman',
                  })
                }
              />
              <DetailRow
                labelId="members.detail.fieldExternalSubject"
                value={user.externalSubject}
                monospace
              />
              <DetailRow
                labelId="members.detail.fieldCreated"
                value={user.createdAt ? new Date(user.createdAt).toLocaleString() : undefined}
              />
            </Stack>
          </Paper>

          <Paper sx={{ p: 3 }}>
            <Typography variant="overline" color="text.secondary" component="div" sx={{ mb: 1.5 }}>
              <FormattedMessage id="members.detail.profilesSectionTitle" />
            </Typography>
            <MemberProfileChipList result={profiles} />
          </Paper>

          <Paper sx={{ p: 3 }}>
            <Typography variant="overline" color="text.secondary" component="div" sx={{ mb: 1.5 }}>
              <FormattedMessage id="members.detail.payloadSectionTitle" />
            </Typography>
            <Stack spacing={2}>
              {/* `schema` resolving to undefined is ambiguous while `schemasQuery` is
                  still in flight — `user` (gating this whole section) and the
                  schemas list are two independently-timed queries, and the user can
                  easily resolve first. Wait for schemasQuery to settle before
                  claiming "no schema", or a member who DOES have one flashes this
                  message for a moment. */}
              {!schema && !schemasQuery.isLoading && (
                <Typography variant="body2" color="text.secondary">
                  <FormattedMessage
                    id={
                      schemasQuery.isError
                        ? 'members.detail.schemaUnavailable'
                        : 'members.detail.schemaNotFound'
                    }
                  />
                </Typography>
              )}

              {schema && (
                <RecordFormFields
                  fields={schema.fields ?? []}
                  value={payload}
                  errors={{}}
                  renderHints={schema.renderHints}
                  rawOnlyNoteId="members.detail.rawOnlyNote"
                  disabled
                  onChange={() => {}}
                />
              )}

              {/* Always present — see the block comment atop this file. */}
              <Box>
                {schema && (
                  <Typography variant="caption" color="text.secondary" component="div" sx={{ mb: 0.5 }}>
                    <FormattedMessage id="members.detail.rawPayloadLabel" />
                  </Typography>
                )}
                <Box
                  component="pre"
                  sx={{
                    m: 0,
                    p: 1.5,
                    bgcolor: 'action.hover',
                    borderRadius: 1,
                    fontSize: 12,
                    overflow: 'auto',
                    maxHeight: 320,
                  }}
                >
                  {JSON.stringify(payload, null, 2)}
                </Box>
              </Box>
            </Stack>
          </Paper>
        </Stack>
      )}
    </Stack>
  );
}

/** One labeled field in the identity summary — omits the row entirely when `value` is absent. */
function DetailRow({
  labelId,
  value,
  monospace = false,
}: {
  labelId: string;
  value: string | undefined | false;
  monospace?: boolean;
}): React.JSX.Element | null {
  if (!value) return null;
  return (
    <Stack direction="row" spacing={2} alignItems="baseline">
      <Typography variant="body2" color="text.secondary" sx={{ minWidth: 160 }}>
        <FormattedMessage id={labelId} />
      </Typography>
      <Typography variant="body2" sx={monospace ? { fontFamily: 'monospace' } : undefined}>
        {value}
      </Typography>
    </Stack>
  );
}
