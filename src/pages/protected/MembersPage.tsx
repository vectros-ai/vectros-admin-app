// ---------------------------------------------------------------------------
// MembersPage — admin-app's member management surface.
//
// Functional scope:
//   - List members for the current tenant via `client.identity.listUsers()`.
//   - Client-side filter chips for `type` (HUMAN / SERVICE) + `status`
//     (ACTIVE / PENDING / SUSPENDED). The Vectros API's GET /v1/users
//     doesn't support these as server-side params today, so admin-app
//     filters in-memory. Acceptable for any tenant with < ~1000 users;
//     revisit with server-side filtering if a real partner hits the limit.
//   - "Invite member" button opens `<InviteMemberDialog>` for the
//     createInvite + AccessProfileRole-dropdown flow.
//   - Per-row actions: Resend invite (PENDING rows only) + Revoke (DELETE).
//   - AccessProfile chip per row: batch-loaded on page mount via
//     `getAccessProfile(vectros-admin, usr_<userId>)`. The chip renders the
//     profile's roleId (falling back to principalId — no human-readable name
//     field on the model yet). Click routes to the profile editor at
//     `/access/contexts/vectros-admin/profiles/<principalId>`.
//     A 404 renders a distinct "no profile" cell; any OTHER lookup failure
//     renders a distinct "couldn't load" cell rather than masquerading as
//     "no profile" (so a real backend error isn't silently swallowed).
//
// Tenant-aware: reads the active tenant from `useCurrentTenant()` and
// passes it to `vectrosApiClient(tenant)` so switching tenants in the
// AppLayout TenantSwitcher refetches against the new env on next render.
// ---------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { Link as RouterLink } from 'react-router';
import {
  Alert,
  Box,
  Button,
  Chip,
  IconButton,
  Link,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import ForwardToInboxIcon from '@mui/icons-material/ForwardToInbox';
import { FormattedMessage, useIntl } from 'react-intl';
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { ConfirmDialog, LoadingBlock } from '@vectros-ai/react';

import { useActiveTenantId } from '../../auth';
import { BRAND } from '../../brand';
import { VectrosError, vectrosApiClient } from '../../api/vectrosApi';
import type {
  AccessProfileResponse,
  CreateInviteResponse,
  UserResponse,
} from '../../api/vectrosApi';
import { drainPages, AUTH_PAGE_SIZE } from '../../lib/drainPages';
import { ApiErrorAlert } from '../../components/ApiErrorAlert';
import { RequestIdCaption } from '../../components/RequestIdCaption';
import { InviteMemberDialog } from './InviteMemberDialog';

const ADMIN_CONTEXT_ID = 'vectros-admin';

type TypeFilter = 'all' | 'HUMAN' | 'SERVICE';
type StatusFilter = 'all' | 'ACTIVE' | 'PENDING' | 'SUSPENDED';

export function MembersPage(): React.JSX.Element {
  const intl = useIntl();
  const tenant = useActiveTenantId();
  const queryClient = useQueryClient();

  // Members list — single query keyed on the active tenant. Switching
  // tenants in the TenantSwitcher swaps queryKey → automatic refetch.
  const membersQuery = useQuery({
    queryKey: ['members', tenant],
    // identity.listUsers is cursor-paginated (SDK 0.23, default 20/page); drain
    // so the members table is complete for tenants with more than one page.
    queryFn: () =>
      drainPages<UserResponse>((startFrom) =>
        vectrosApiClient(tenant).identity.listUsers(
          startFrom === undefined
            ? { limit: AUTH_PAGE_SIZE }
            : { startFrom, limit: AUTH_PAGE_SIZE },
        ),
      ),
  });
  const members = membersQuery.data ?? null;

  // Per-member AccessProfile lookups — fanned out as parallel queries.
  // A 404 (PENDING users + legacy rows without a profile) is settled to
  // `null` — a normal "no profile" state, NOT an error — so a missing
  // profile doesn't poison the row. Any OTHER error (e.g. 500) is RE-THROWN
  // so the query lands in `isError` and the row can surface a distinct
  // "couldn't load" affordance rather than silently conflating it with 404.
  const profileQueries = useQueries({
    queries: (members ?? [])
      .filter((m) => Boolean(m.id))
      .map((m) => ({
        queryKey: ['accessProfile', tenant, m.id] as const,
        queryFn: async (): Promise<AccessProfileResponse | null> => {
          try {
            return await vectrosApiClient(tenant).auth.getAccessProfile({
              contextId: ADMIN_CONTEXT_ID,
              principalId: `usr_${m.id!}`,
            });
          } catch (err) {
            if (err instanceof VectrosError && err.statusCode === 404) return null;
            throw err;
          }
        },
      })),
  });

  // Derive a principalId → profile-cell-state map from the parallel results.
  // `undefined` → still loading (renders "Loading…"); a resolved value
  // (profile object or `null` for a 404) renders normally; the `error`
  // sentinel marks a genuine non-404 failure so the cell shows a distinct
  // "couldn't load" affordance instead of masquerading as "no profile".
  type ProfileCell = AccessProfileResponse | null | 'error';
  const profilesByPrincipal = useMemo(() => {
    const map: Record<string, ProfileCell> = {};
    const validMembers = (members ?? []).filter((m) => Boolean(m.id));
    validMembers.forEach((m, i) => {
      const q = profileQueries[i];
      if (q?.isError) {
        map[`usr_${m.id!}`] = 'error';
      } else if (q?.isSuccess) {
        map[`usr_${m.id!}`] = q.data ?? null;
      }
    });
    return map;
  }, [members, profileQueries]);

  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

  const [inviteOpen, setInviteOpen] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<UserResponse | null>(null);

  // A transient page-level SUCCESS banner (revoke / resend confirmations).
  // Errors no longer share this surface: a revoke error renders IN the
  // ConfirmDialog, and a resend error renders as an <ApiErrorAlert> below
  // (so its requestId surfaces). This removes the old dual-severity Alert.
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Mutations — both invalidate ['members', tenant] on success so the
  // table refetches automatically. `actionInFlight` derives from both
  // mutations' `isPending` flags to guard the per-row action buttons.
  const resendMutation = useMutation({
    mutationFn: (vars: { email: string; roleId: string }) =>
      vectrosApiClient(tenant).auth.resendInvite({
        email: vars.email,
        contextId: ADMIN_CONTEXT_ID,
        accessProfile: { roleId: vars.roleId },
      }),
    onSuccess: (_data, vars) => {
      setSuccessMessage(intl.formatMessage({ id: 'members.resendSuccess' }, { email: vars.email }));
      void queryClient.invalidateQueries({ queryKey: ['members', tenant] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (vars: { id: string }) =>
      vectrosApiClient(tenant).identity.deleteUser({ id: vars.id }),
    onSuccess: (_data, _vars, _ctx) => {
      const email = revokeTarget?.email ?? '';
      setSuccessMessage(intl.formatMessage({ id: 'members.revokeSuccess' }, { email }));
      setRevokeTarget(null);
      void queryClient.invalidateQueries({ queryKey: ['members', tenant] });
    },
  });

  const actionInFlight = resendMutation.isPending || deleteMutation.isPending;

  // The resend invite that hit a non-role guard or backend failure. `null`
  // role-guard sets a dedicated message; an SDK failure is read off the
  // mutation so its requestId can surface via <ApiErrorAlert>.
  const [resendGuardMessage, setResendGuardMessage] = useState<string | null>(null);

  const filteredMembers = useMemo(() => {
    if (!members) return [];
    return members.filter((m) => {
      if (typeFilter !== 'all' && m.type !== typeFilter) return false;
      if (statusFilter !== 'all' && m.status !== statusFilter) return false;
      return true;
    });
  }, [members, typeFilter, statusFilter]);

  const handleInviteSuccess = (_response: CreateInviteResponse): void => {
    void queryClient.invalidateQueries({ queryKey: ['members', tenant] });
  };

  // Resend re-mints a fresh token. The SDK's resendInvite requires the
  // same body shape as createInvite; we re-derive what we can from the
  // current row (email + the bound role). For a fully-fledged resend
  // preserving original TTL knobs the platform would need a slimmer
  // `{ userId }` shape — captured as a backend follow-up.
  const handleResend = (member: UserResponse): void => {
    if (!member.email || !member.id) return;
    setSuccessMessage(null);
    setResendGuardMessage(null);
    resendMutation.reset();
    const profile = profilesByPrincipal[`usr_${member.id}`];
    const roleId =
      profile && profile !== 'error' ? profile.roleId : undefined;
    if (!roleId) {
      setResendGuardMessage(intl.formatMessage({ id: 'members.resendNoRole' }));
      return;
    }
    resendMutation.mutate({ email: member.email, roleId });
  };

  const handleRevokeConfirm = (): void => {
    if (!revokeTarget?.id) return;
    setSuccessMessage(null);
    deleteMutation.mutate({ id: revokeTarget.id });
  };

  // Close the revoke confirm and drop any prior failure so reopening on
  // another row starts clean (the ConfirmDialog error slot would otherwise
  // re-show the stale error).
  const handleRevokeClose = (): void => {
    setRevokeTarget(null);
    deleteMutation.reset();
  };

  return (
    <Stack spacing={3}>
      <Box>
        <Stack direction="row" alignItems="flex-start" justifyContent="space-between" spacing={2}>
          <Box>
            <Typography variant="h4" component="h1" sx={{ fontWeight: 700 }}>
              <FormattedMessage id="members.title" />
            </Typography>
            <Typography variant="body1" color="text.secondary" sx={{ mt: 1 }}>
              <FormattedMessage
                id="members.subtitle"
                values={{ productName: BRAND.productName }}
              />
            </Typography>
          </Box>
          <Button
            variant="contained"
            onClick={() => setInviteOpen(true)}
            // Match the other list-header action buttons (default size); keep the
            // label on one line so the header Stack can't wrap it.
            sx={{ whiteSpace: 'nowrap', flexShrink: 0 }}
          >
            <FormattedMessage id="members.inviteButton" />
          </Button>
        </Stack>
      </Box>

      {successMessage && (
        <Alert severity="success" role="status" onClose={() => setSuccessMessage(null)}>
          {successMessage}
        </Alert>
      )}

      {resendGuardMessage && (
        <Alert severity="error" role="alert" onClose={() => setResendGuardMessage(null)}>
          {resendGuardMessage}
        </Alert>
      )}

      {resendMutation.isError && (
        <ApiErrorAlert error={resendMutation.error}>
          <FormattedMessage id="members.resendErrorBody" />
        </ApiErrorAlert>
      )}

      {/* Filters */}
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems={{ sm: 'center' }}>
        <Stack direction="row" spacing={1} alignItems="center">
          <Typography variant="body2" color="text.secondary">
            <FormattedMessage id="members.filterType" />
          </Typography>
          <ToggleButtonGroup
            value={typeFilter}
            exclusive
            size="small"
            onChange={(_, v: TypeFilter | null) => v !== null && setTypeFilter(v)}
            aria-label={intl.formatMessage({ id: 'members.filterType' })}
          >
            <ToggleButton value="all">
              <FormattedMessage id="members.filterAll" />
            </ToggleButton>
            <ToggleButton value="HUMAN">
              <FormattedMessage id="members.typeHuman" />
            </ToggleButton>
            <ToggleButton value="SERVICE">
              <FormattedMessage id="members.typeService" />
            </ToggleButton>
          </ToggleButtonGroup>
        </Stack>
        <Stack direction="row" spacing={1} alignItems="center">
          <Typography variant="body2" color="text.secondary">
            <FormattedMessage id="members.filterStatus" />
          </Typography>
          <ToggleButtonGroup
            value={statusFilter}
            exclusive
            size="small"
            onChange={(_, v: StatusFilter | null) => v !== null && setStatusFilter(v)}
            aria-label={intl.formatMessage({ id: 'members.filterStatus' })}
          >
            <ToggleButton value="all">
              <FormattedMessage id="members.filterAll" />
            </ToggleButton>
            <ToggleButton value="ACTIVE">
              <FormattedMessage id="members.statusActive" />
            </ToggleButton>
            <ToggleButton value="PENDING">
              <FormattedMessage id="members.statusPending" />
            </ToggleButton>
            <ToggleButton value="SUSPENDED">
              <FormattedMessage id="members.statusSuspended" />
            </ToggleButton>
          </ToggleButtonGroup>
        </Stack>
        <Box sx={{ flexGrow: 1 }} />
        <Tooltip title={intl.formatMessage({ id: 'members.refresh' })}>
          <span>
            <IconButton
              onClick={() => {
                void queryClient.invalidateQueries({ queryKey: ['members', tenant] });
                void queryClient.invalidateQueries({ queryKey: ['accessProfile', tenant] });
              }}
              disabled={membersQuery.isFetching}
              aria-label={intl.formatMessage({ id: 'members.refresh' })}
            >
              <RefreshIcon />
            </IconButton>
          </span>
        </Tooltip>
      </Stack>

      {/* Body — loading / error / empty / table */}
      {membersQuery.isError && (
        <ApiErrorAlert error={membersQuery.error}>
          <FormattedMessage id="members.loadErrorBody" />
        </ApiErrorAlert>
      )}

      {membersQuery.isPending && (
        <LoadingBlock label={intl.formatMessage({ id: 'members.loading' })} />
      )}

      {members !== null && filteredMembers.length === 0 && !membersQuery.isError && (
        <Paper sx={{ p: 4, textAlign: 'center' }}>
          <Typography variant="body1" color="text.secondary">
            <FormattedMessage id="members.empty" />
          </Typography>
        </Paper>
      )}

      {members !== null && filteredMembers.length > 0 && (
        <TableContainer component={Paper}>
          <Table aria-label={intl.formatMessage({ id: 'members.title' })}>
            <TableHead>
              <TableRow>
                <TableCell>
                  <FormattedMessage id="members.columnEmail" />
                </TableCell>
                <TableCell>
                  <FormattedMessage id="members.columnType" />
                </TableCell>
                <TableCell>
                  <FormattedMessage id="members.columnStatus" />
                </TableCell>
                <TableCell>
                  <FormattedMessage id="members.columnProfile" />
                </TableCell>
                <TableCell align="right">
                  <FormattedMessage id="members.columnActions" />
                </TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {filteredMembers.map((member, idx) => {
                const principalId = member.id ? `usr_${member.id}` : '';
                const profile = profilesByPrincipal[principalId];
                // Stable key: prefer the id, then email/externalId, then the
                // row index (never Math.random(), which re-keys every render
                // and would defeat React reconciliation).
                const rowKey = member.id ?? member.email ?? member.externalId ?? `row-${idx}`;
                return (
                  <TableRow key={rowKey}>
                    <TableCell>{member.email ?? member.externalId ?? '—'}</TableCell>
                    <TableCell>
                      <FormattedMessage
                        id={member.type === 'SERVICE' ? 'members.typeService' : 'members.typeHuman'}
                      />
                    </TableCell>
                    <TableCell>
                      <Chip
                        label={
                          <FormattedMessage
                            id={
                              member.status === 'ACTIVE'
                                ? 'members.statusActive'
                                : member.status === 'PENDING'
                                  ? 'members.statusPending'
                                  : 'members.statusSuspended'
                            }
                          />
                        }
                        size="small"
                        color={
                          member.status === 'ACTIVE'
                            ? 'success'
                            : member.status === 'PENDING'
                              ? 'warning'
                              : 'default'
                        }
                      />
                    </TableCell>
                    <TableCell>
                      {profile === undefined ? (
                        <Typography variant="caption" color="text.secondary">
                          <FormattedMessage id="members.profileLoading" />
                        </Typography>
                      ) : profile === 'error' ? (
                        <Typography variant="body2" color="error">
                          <FormattedMessage id="members.profileError" />
                        </Typography>
                      ) : profile === null ? (
                        <Typography variant="body2" color="text.secondary">
                          <FormattedMessage id="members.profileNone" />
                        </Typography>
                      ) : (
                        <Link
                          component={RouterLink}
                          to={`/access/contexts/${ADMIN_CONTEXT_ID}/profiles/${encodeURIComponent(profile.principalId ?? '')}`}
                          variant="body2"
                        >
                          {profile.roleId ?? profile.principalId}
                        </Link>
                      )}
                    </TableCell>
                    <TableCell align="right">
                      <Stack direction="row" spacing={0.5} justifyContent="flex-end">
                        {member.status === 'PENDING' && (
                          <Tooltip title={intl.formatMessage({ id: 'members.actionResend' })}>
                            <span>
                              <IconButton
                                size="small"
                                onClick={() => void handleResend(member)}
                                disabled={actionInFlight}
                                aria-label={intl.formatMessage({ id: 'members.actionResend' })}
                              >
                                <ForwardToInboxIcon fontSize="small" />
                              </IconButton>
                            </span>
                          </Tooltip>
                        )}
                        <Tooltip title={intl.formatMessage({ id: 'members.actionRevoke' })}>
                          <span>
                            <IconButton
                              size="small"
                              onClick={() => setRevokeTarget(member)}
                              disabled={actionInFlight}
                              aria-label={intl.formatMessage({ id: 'members.actionRevoke' })}
                            >
                              <DeleteOutlineIcon fontSize="small" />
                            </IconButton>
                          </span>
                        </Tooltip>
                      </Stack>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      <InviteMemberDialog
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        onSuccess={handleInviteSuccess}
      />

      {/* Revoke confirmation — ConfirmDialog bakes in a collision-free
          aria-labelledby, a pending-guarded dismissal, the SubmitButton
          spinner, and an in-dialog role="alert" error slot (so a failed
          revoke is announced IN the modal, never occluded behind it). */}
      <ConfirmDialog
        open={revokeTarget !== null}
        onClose={handleRevokeClose}
        onConfirm={() => void handleRevokeConfirm()}
        pending={deleteMutation.isPending}
        title={
          <FormattedMessage
            id="members.revokeConfirmTitle"
            values={{ email: revokeTarget?.email ?? '' }}
          />
        }
        body={<FormattedMessage id="members.revokeConfirmBody" />}
        confirmLabel={<FormattedMessage id="members.revokeConfirmCta" />}
        cancelLabel={<FormattedMessage id="members.revokeCancelCta" />}
        error={
          deleteMutation.isError ? (
            <>
              <FormattedMessage id="members.revokeErrorBody" />
              <RequestIdCaption error={deleteMutation.error} />
            </>
          ) : undefined
        }
      />
    </Stack>
  );
}
