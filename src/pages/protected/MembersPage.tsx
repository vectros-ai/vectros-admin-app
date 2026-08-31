// ---------------------------------------------------------------------------
// MembersPage — admin-app's member management surface.
//
// Functional scope:
//   - List members for the current tenant via `client.identity.listUsers()`.
//   - Client-side filter chips for `type` (HUMAN / SERVICE) + `status`
//     (ACTIVE / PENDING / SUSPENDED). The Vectros API's GET /v1/users
//     doesn't support these as server-side params today, so admin-app
//     filters in-memory. Acceptable for any tenant with < ~1000 users;
//     revisit with server-side filtering if a real account hits the limit.
//   - "Invite member" button opens `<InviteMemberDialog>` for the
//     createInvite + AccessProfileRole-dropdown flow.
//   - Per-row actions: Resend invite (PENDING rows only) + Revoke (DELETE).
//   - AccessProfile chip per row: batch-loaded on page mount via
//     `getAccessProfile(default, usr_<userId>)`. The chip renders the
//     profile's roleId (falling back to principalId — no human-readable name
//     field on the model yet). Click routes to the profile editor at
//     `/access/contexts/default/profiles/<principalId>`.
//     A 404 renders a distinct "no profile" cell; any OTHER lookup failure
//     renders a distinct "couldn't load" cell rather than masquerading as
//     "no profile" (so a real backend error isn't silently swallowed).
//
// **Why `default` and not the reserved control-plane context.** A member's
// admin-app session is backed by the AccessProfile the token mint resolves,
// and that mint targets the base `default` context — a bearer pinned to any
// other context is what this page's calls must agree with, or they fail
// closed with a 403. The browser-held token mint rejects the reserved
// control-plane context outright, so THIS APP can never hold a bearer pinned
// there and can never read a profile stored there back.
//
// Note the scope of that claim: it is about the token this app mints, not
// about the context in general. A scoped API key minted server-side CAN be
// bound to the reserved context, and its authority IS resolved from the
// profile there — so those rows are not inert in general, only unreachable
// from here. Do not generalize this comment into "that context is dead".
//
// Tenant-aware: reads the active tenant from `useCurrentTenant()` and
// passes it to `vectrosApiClient(tenant)` so switching tenants in the
// AppLayout TenantSwitcher refetches against the new env on next render.
//
// **Context binding.** Every call below that names a `contextId` is made on a
// client whose bearer is pinned to that same context — here by omitting the
// factory's `contextId` (the mint resolves an omitted context to `default`,
// the value these calls pass). Naming a context the bearer isn't pinned to is
// a 403, so the two must move together; `MEMBERS_CONTEXT_ID` is the single
// value both sides read. Pinned by the context-binding test in
// `MembersPage.test.tsx`.
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
import SwapHorizIcon from '@mui/icons-material/SwapHoriz';
import { FormattedMessage, useIntl } from 'react-intl';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ApiErrorAlert,
  ConfirmDialog,
  LoadingBlock,
  RequestIdCaption,
  extractErrorMessage,
  useScopeGate,
} from '@vectros-ai/react';

import { useActiveTenantId, useAuth, useCurrentTenant } from '../../auth';
import type { AccountOwnerTransferResult } from '../../api/developerApi';
import { RESERVED_DEFAULT_CONTEXT_ID } from '../../lib/reservedContexts';
import { BRAND } from '../../brand';
import { VectrosError, vectrosApiClient } from '../../api/vectrosApi';
import type {
  AccessProfileResponse,
  CreateInviteResponse,
  UserResponse,
} from '../../api/vectrosApi';
import { drainPages, AUTH_PAGE_SIZE } from '../../lib/drainPages';
import { isMultiRoleComposed } from '../../lib/accessProfileRoles';
import { InviteMemberDialog } from './InviteMemberDialog';
import { TransferOwnershipDialog } from './TransferOwnershipDialog';

/**
 * The AppContext this page's member profiles live in. Aliased (rather than
 * used inline) so the binding it shares with the bearer above is stated once
 * and every call site below reads the same value.
 */
const MEMBERS_CONTEXT_ID = RESERVED_DEFAULT_CONTEXT_ID;

type TypeFilter = 'all' | 'HUMAN' | 'SERVICE';
type StatusFilter = 'all' | 'ACTIVE' | 'PENDING' | 'SUSPENDED';

export function MembersPage(): React.JSX.Element {
  const intl = useIntl();
  const tenant = useActiveTenantId();
  const { activeMembership } = useCurrentTenant();
  const { user } = useAuth();
  const queryClient = useQueryClient();

  // Only an OWNER's Cognito session can call POST /developer/account-owner —
  // the developer-API router's OWNER-only-by-default gate 403s a sub-user
  // unconditionally, so a non-owner never sees the action at all.
  const isOwner = activeMembership?.role === 'OWNER';

  // Members list — single query keyed on the active tenant. Switching
  // tenants in the TenantSwitcher swaps queryKey → automatic refetch.
  //
  // **Known gap: a user with no AccessProfile in this page's context (see
  // MEMBERS_CONTEXT_ID above) does not appear here, even though the user
  // exists.** For a context-confined bearer — which every admin-app session
  // holds, by the same token-mint constraint documented above — the server
  // resolves this list by joining through that context's AccessProfiles, not
  // by a plain tenant-wide scan. A user who exists but hasn't (yet) been
  // granted a profile there is simply absent from the join, with no error and
  // no indication anything is missing. This is a property of the underlying
  // list call itself, not of pagination or caching — draining every page (see
  // below) does not surface such a user, and neither does a refresh.
  const membersQuery = useQuery({
    queryKey: ['members', tenant],
    // identity.listUsers is cursor-paginated (SDK 0.23, default 20/page); drain
    // so every returned page is read — see the caveat above for what "every
    // returned page" does and doesn't guarantee.
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
              contextId: MEMBERS_CONTEXT_ID,
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
  const [transferTarget, setTransferTarget] = useState<UserResponse | null>(null);

  // A transient page-level SUCCESS banner (revoke / resend confirmations).
  // Errors no longer share this surface: a revoke error renders IN the
  // ConfirmDialog, and a resend error renders as an <ApiErrorAlert> below
  // (so its requestId surfaces). This removes the old dual-severity Alert.
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Mutations — both invalidate ['members', tenant] on success so the
  // table refetches automatically. `actionInFlight` derives from these two
  // mutations' `isPending` flags PLUS the transfer dialog being open (its
  // own mutation lives inside TransferOwnershipDialog, so its pending state
  // isn't visible here — `transferTarget !== null` stands in for it) to
  // guard the per-row action buttons. Belt-and-braces: the dialog's own
  // modal backdrop already blocks clicks on the table underneath it while
  // open, so this is defense in depth, not the only thing stopping a
  // concurrent Resend/Revoke during a transfer.
  const resendMutation = useMutation({
    mutationFn: (vars: { email: string; roleId: string }) =>
      vectrosApiClient(tenant).auth.resendInvite({
        email: vars.email,
        contextId: MEMBERS_CONTEXT_ID,
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

  const actionInFlight =
    resendMutation.isPending || deleteMutation.isPending || transferTarget !== null;

  // Client-side scope gate for Resend. The backend's `/resend` route requires
  // `users:c` + `users:r` + `users:u` (the `c` requirement is a deliberate,
  // retained rule, not an oversight); without this check the button rendered
  // unconditionally and an under-scoped sub-user got a bare 403 on click.
  // `useScopeGate().can()` is ops-aware (unions across every unqualified
  // `users:*` entry, whether split across rows or combined into one), so this
  // no longer needs a local re-implementation of that grammar — a second copy
  // is exactly the shape that has previously let a letter-level gap slip in.
  // Cosmetic only: the backend remains authoritative and still 403s a
  // forged/stale token.
  const { can: canPerformAction, loading: scopeLoading } = useScopeGate();
  const canResendInvite = canPerformAction('users:cru');
  // Same discipline as Resend, for the other two backend-enforced actions on
  // this page: Revoke calls `identity.deleteUser`, which requires `users:d`;
  // Invite calls the create route, which requires `users:c`. Each rendered
  // unconditionally before this, so an under-scoped sub-user could click
  // through to a bare 403.
  const canRevokeMember = canPerformAction('users:d');
  const canInvite = canPerformAction('users:c');

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

  // The transfer already happened server-side by the time this fires — the
  // banner reports it, it doesn't ask for confirmation. Refetching the list
  // is best-effort: this session's OWNER-gated read of it may itself now
  // 403 (the caller just gave up the role that let them list AccessProfiles
  // in MEMBERS_CONTEXT_ID), and the existing `membersQuery.isError` alert
  // already has a path for that.
  const handleTransferSuccess = (_result: AccountOwnerTransferResult, email: string): void => {
    setTransferTarget(null);
    setSuccessMessage(intl.formatMessage({ id: 'members.transferSuccess' }, { email }));
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
    const roleId = profile && profile !== 'error' ? profile.roleId : undefined;
    // roleId is absent for a 2+-role composition (roleIds-only, 0.41.0) as
    // well as for a genuinely role-less member — resendInvite takes a
    // single roleId (same shape as createInvite), so a multi-role member
    // can't be resent from here today. Distinguish the two rather than
    // reporting "no role" for someone who genuinely has roles (the same
    // roleId-only blind spot as ProfileEditor/RoleEditor/ContextDetailPage).
    const isMultiRole =
      !!profile && profile !== 'error' && !profile.roleId && (profile.roleIds?.length ?? 0) > 0;
    if (isMultiRole) {
      setResendGuardMessage(intl.formatMessage({ id: 'members.resendMultiRole' }));
      return;
    }
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

  // 0.40.0: DELETE /v1/users/{id} now 409s rather than succeeding when it
  // would remove the account's last OWNER — a real, explained refusal, not a
  // generic failure. But a 409 here is NOT exclusively that: the same
  // endpoint also 409s when the target has access in another app context
  // (a context-confined caller must remove them via the profile-delete
  // route instead), and on a concurrent-delete race — and the backend
  // throws the SAME error class for the last-owner and other-context cases,
  // so there is no status-code-only way to tell them apart. Surface the
  // server's own message (which DOES name the right cause and the right
  // next step) beneath the generic title, rather than asserting "last
  // owner" for every 409 — same pattern as ProfileEditor/RoleEditor.
  const revokeErrorDetail = extractErrorMessage(deleteMutation.error);

  return (
    <Stack spacing={3}>
      <Box>
        <Stack direction="row" alignItems="flex-start" justifyContent="space-between" spacing={2}>
          <Box>
            <Typography variant="h4" component="h1" sx={{ fontWeight: 700 }}>
              <FormattedMessage id="members.title" />
            </Typography>
            <Typography variant="body1" color="text.secondary" sx={{ mt: 1 }}>
              <FormattedMessage id="members.subtitle" values={{ productName: BRAND.productName }} />
            </Typography>
          </Box>
          <Tooltip
            title={
              !canInvite && !scopeLoading
                ? intl.formatMessage({ id: 'members.inviteForbidden' })
                : ''
            }
          >
            {/* flexShrink lives on the span, not the Button: the span (not the
                Button) is the direct child of the header Stack now that the
                Tooltip needs a wrapper around a disabled control, so that's
                the flex item whose shrinking needs to be stopped. */}
            <span style={{ flexShrink: 0 }}>
              <Button
                variant="contained"
                onClick={() => setInviteOpen(true)}
                disabled={!canInvite}
                // Keep the label on one line so the header Stack can't wrap it.
                sx={{ whiteSpace: 'nowrap' }}
              >
                <FormattedMessage id="members.inviteButton" />
              </Button>
            </span>
          </Tooltip>
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
                // Transfer-ownership row eligibility. Only an OWNER can call
                // POST /developer/account-owner (the developer router 403s
                // any other caller unconditionally), so this hides for a
                // sub-user rather than rendering permanently disabled on
                // every row. Row-eligible only: HUMAN (a SERVICE principal
                // has no Cognito session to sign in with and hold
                // ownership), ACTIVE (a PENDING invite has no
                // externalSubject yet — the backend's own 400 for that
                // case), and not the caller's own row. `isSelf` requires
                // `user?.sub` to be genuinely present — a bare
                // `member.externalSubject === user?.sub` would read BOTH
                // sides as `undefined` (session still loading, or a legacy
                // row with no externalSubject) and misfire as "this IS me"
                // for every such row; that legacy case must still show the
                // action and let the backend refuse with its own "not
                // signed in" message, not be silently hidden. The backend
                // remains authoritative for all of this either way.
                const isSelf = Boolean(user?.sub && member.externalSubject === user.sub);
                const canTransferOwnership =
                  isOwner && member.type === 'HUMAN' && member.status === 'ACTIVE' && !isSelf;
                // Computed once per eligible row and reused for both the Tooltip
                // title and the IconButton's aria-label below, rather than
                // formatting the same message twice.
                const transferLabel = canTransferOwnership
                  ? intl.formatMessage({ id: 'members.actionTransferOwnership' })
                  : '';
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
                          to={`/access/contexts/${MEMBERS_CONTEXT_ID}/profiles/${encodeURIComponent(profile.principalId ?? '')}`}
                          variant="body2"
                        >
                          {profile.roleId ??
                            (isMultiRoleComposed(profile)
                              ? intl.formatMessage(
                                  { id: 'access.profiles.sourceMultiRole' },
                                  {
                                    count: profile.roleIds?.length ?? 0,
                                    roleIds: (profile.roleIds ?? []).join(', '),
                                  },
                                )
                              : profile.principalId)}
                        </Link>
                      )}
                    </TableCell>
                    <TableCell align="right">
                      <Stack direction="row" spacing={0.5} justifyContent="flex-end">
                        {canTransferOwnership && (
                          <Tooltip title={transferLabel}>
                            <span>
                              <IconButton
                                size="small"
                                onClick={() => setTransferTarget(member)}
                                disabled={actionInFlight}
                                aria-label={transferLabel}
                              >
                                <SwapHorizIcon fontSize="small" />
                              </IconButton>
                            </span>
                          </Tooltip>
                        )}
                        {member.status === 'PENDING' && (
                          <Tooltip
                            title={intl.formatMessage({
                              // While the scope gate is still minting, `canResendInvite`
                              // reads false the same as a genuine denial would — don't
                              // show "forbidden" copy to an about-to-be-authorized user
                              // for the brief window before the mint resolves.
                              id:
                                canResendInvite || scopeLoading
                                  ? 'members.actionResend'
                                  : 'members.actionResendForbidden',
                            })}
                          >
                            <span>
                              <IconButton
                                size="small"
                                onClick={() => void handleResend(member)}
                                disabled={actionInFlight || !canResendInvite}
                                aria-label={intl.formatMessage({ id: 'members.actionResend' })}
                              >
                                <ForwardToInboxIcon fontSize="small" />
                              </IconButton>
                            </span>
                          </Tooltip>
                        )}
                        <Tooltip
                          title={intl.formatMessage({
                            // Same loading-flash handling as Resend above: don't
                            // show "forbidden" copy for the brief window before
                            // the mint resolves.
                            id:
                              canRevokeMember || scopeLoading
                                ? 'members.actionRevoke'
                                : 'members.actionRevokeForbidden',
                          })}
                        >
                          <span>
                            <IconButton
                              size="small"
                              onClick={() => setRevokeTarget(member)}
                              disabled={actionInFlight || !canRevokeMember}
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

      <TransferOwnershipDialog
        member={transferTarget}
        onClose={() => setTransferTarget(null)}
        onSuccess={handleTransferSuccess}
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
              {revokeErrorDetail && (
                <Typography variant="caption" component="p" sx={{ mt: 0.5, opacity: 0.85 }}>
                  {revokeErrorDetail}
                </Typography>
              )}
              <RequestIdCaption error={deleteMutation.error} />
            </>
          ) : undefined
        }
      />
    </Stack>
  );
}
