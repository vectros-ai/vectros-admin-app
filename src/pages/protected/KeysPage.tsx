// ---------------------------------------------------------------------------
// KeysPage — Scoped Keys (ssk_*) management surface.
//
// Functional scope (list view):
//   - List scoped keys via the account-wide developer API
//     (`useDeveloperApi().listScopedKeys()`), which returns every key across both
//     environments and ALL app contexts. The rendered rows are then scoped to the
//     TenantSwitcher's ACTIVE environment (Live/Test) client-side, so switching
//     environments narrows the list the same way the sibling admin pages do. The
//     fetch stays account-wide DELIBERATELY: the endpoint does accept an optional
//     `tenantId` environment filter, but requesting one environment would make the
//     cached list env-specific and force a refetch on every switcher toggle. One
//     account-wide list serving both environments is the cheaper shape here, and
//     the filter below is then pure presentation over the caller's own, already-
//     bounded and context-confined list. A context-pinned bearer only ever sees
//     its own context's keys, so the account-wide view lives on the owner-gated
//     developer API; the `tenantId` + `contextId` columns surface where each
//     visible key lives.
//   - Revoke a key via `devApi.revokeScopedKey(keyId)`, gated by a confirmation
//     dialog that surfaces the ~5-minute authorizer cache window so admins aren't
//     surprised by lingering 401s.
//   - Per-row chips for user type (HUMAN / SERVICE) + key status (active /
//     revoked).
//
// Built on TanStack Query: useQuery for the list + useMutation for revoke.
// Refresh button invalidates ['scopedKeys'].
//
// "Create scoped key" opens the 5-step <ScopedKeyCreateDialog> wizard
// (user → key name → context → profile → review).
// ---------------------------------------------------------------------------

import { useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  IconButton,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
} from '@mui/material';
import { ApiErrorAlert, ConfirmDialog, LoadingBlock, RequestIdCaption } from '@vectros-ai/react';
import { ScopedKeyCreateDialog } from './ScopedKeyCreateDialog';
import RefreshIcon from '@mui/icons-material/Refresh';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import AddIcon from '@mui/icons-material/Add';
import PersonIcon from '@mui/icons-material/Person';
import SmartToyIcon from '@mui/icons-material/SmartToy';
import { FormattedMessage, useIntl } from 'react-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useActiveTenantId, useCurrentTenant } from '../../auth';
import { useDeveloperApi } from '../../api/developerApi';
import type { ScopedKeyResponse } from '../../api/vectrosApi';

export function KeysPage(): React.JSX.Element {
  const intl = useIntl();
  const { activeMembership } = useCurrentTenant();
  const activeTenantId = useActiveTenantId();
  const devApi = useDeveloperApi();
  const queryClient = useQueryClient();

  // Server-state — every scoped key in the account, across both environments and
  // ALL app contexts. The list comes from the account-wide Developer API (a
  // context-pinned bearer only ever sees its own context's keys). The queryKey is
  // intentionally NOT tenant-namespaced — the same account-wide list backs both
  // environments, so switching the TenantSwitcher re-derives the visible rows
  // (below) without refetching a new bucket.
  const keysQuery = useQuery({
    queryKey: ['scopedKeys'],
    queryFn: () => devApi.listScopedKeys(),
  });
  const keys = keysQuery.data ?? null;

  // Scope the RENDERED rows to the TenantSwitcher's active environment (Live/Test).
  // The fetch above is account-wide by choice (see the header note), so this filter
  // is pure presentation over the caller's own, already-bounded list — leak-safe,
  // and reactive to the switcher (activeTenantId changes → the filtered set
  // recomputes on the next render). It is defense in depth, not the enforcement:
  // every key here belongs to the caller's own account either way.
  const visibleKeys =
    keys === null ? null : keys.filter((key) => key.tenantId === activeTenantId);

  // UI state (correct domain — stays as useState).
  const [revokeTarget, setRevokeTarget] = useState<ScopedKeyResponse | null>(null);
  // Success-only status banner. Revoke FAILURES surface inside the
  // ConfirmDialog (so a failed revoke is never occluded behind the open
  // modal — the canonical "error behind the dialog" bug). The query's own
  // load error renders via <ApiErrorAlert> below.
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const revokeMutation = useMutation({
    mutationFn: (vars: { keyId: string }) => devApi.revokeScopedKey(vars.keyId),
    onSuccess: () => {
      const keyName = revokeTarget?.keyName ?? '';
      setSuccessMessage(intl.formatMessage({ id: 'keys.revokeSuccess' }, { keyName }));
      setRevokeTarget(null);
      revokeMutation.reset();
      void queryClient.invalidateQueries({ queryKey: ['scopedKeys'] });
    },
    // onError intentionally omitted — the error stays on revokeMutation.error
    // and renders IN the ConfirmDialog's error slot.
  });

  const handleRevokeConfirm = (): void => {
    if (!revokeTarget?.keyId) return;
    revokeMutation.mutate({ keyId: revokeTarget.keyId });
  };

  // Closing the dialog resets the mutation so a prior failure doesn't
  // reappear when a different key's dialog is opened.
  const handleRevokeClose = (): void => {
    if (revokeMutation.isPending) return;
    setRevokeTarget(null);
    revokeMutation.reset();
  };

  return (
    <Stack spacing={3}>
      <Box>
        <Stack
          direction="row"
          alignItems="flex-start"
          justifyContent="space-between"
          spacing={2}
        >
          <Box>
            <Typography variant="h4" component="h1" sx={{ fontWeight: 700 }}>
              <FormattedMessage id="keys.title" />
            </Typography>
            <Typography variant="body1" color="text.secondary" sx={{ mt: 1 }}>
              <FormattedMessage id="keys.subtitle" />
            </Typography>
          </Box>
          <Button
            variant="contained"
            startIcon={<AddIcon />}
            onClick={() => setCreateOpen(true)}
            // Match the other list-header create buttons (default size); keep the
            // label on one line so the header Stack can't wrap it.
            sx={{ whiteSpace: 'nowrap', flexShrink: 0 }}
          >
            <FormattedMessage id="keys.createButton" />
          </Button>
        </Stack>
      </Box>

      {successMessage && (
        <Alert
          severity="success"
          role="status"
          onClose={() => setSuccessMessage(null)}
        >
          {successMessage}
        </Alert>
      )}

      {/* Header controls — refresh, primarily; column filters land later. */}
      <Stack direction="row" alignItems="center" spacing={2}>
        <Box sx={{ flexGrow: 1 }} />
        <Tooltip title={intl.formatMessage({ id: 'keys.refresh' })}>
          <span>
            <IconButton
              onClick={() => {
                void queryClient.invalidateQueries({ queryKey: ['scopedKeys'] });
              }}
              disabled={keysQuery.isFetching}
              aria-label={intl.formatMessage({ id: 'keys.refresh' })}
            >
              <RefreshIcon />
            </IconButton>
          </span>
        </Tooltip>
      </Stack>

      {keysQuery.isError && (
        <ApiErrorAlert error={keysQuery.error}>
          <FormattedMessage
            id="keys.loadError"
            values={{
              message:
                keysQuery.error instanceof Error
                  ? keysQuery.error.message
                  : String(keysQuery.error),
            }}
          />
        </ApiErrorAlert>
      )}

      {keys === null && !keysQuery.isError && (
        <LoadingBlock label={intl.formatMessage({ id: 'keys.loading' })} />
      )}

      {/* Account has no scoped keys at all — the create-a-key prompt. */}
      {keys !== null && keys.length === 0 && !keysQuery.isError && (
        <Paper sx={{ p: 4, textAlign: 'center' }}>
          <Typography variant="body1" color="text.secondary">
            <FormattedMessage id="keys.empty" />
          </Typography>
        </Paper>
      )}

      {/* Keys exist, but none in the active environment — switching the
          TenantSwitcher to the other environment surfaces the rest. */}
      {visibleKeys !== null &&
        keys!.length > 0 &&
        visibleKeys.length === 0 &&
        !keysQuery.isError && (
          <Paper sx={{ p: 4, textAlign: 'center' }}>
            <Typography variant="body1" color="text.secondary">
              <FormattedMessage id="keys.emptyForEnv" />
            </Typography>
          </Paper>
        )}

      {visibleKeys !== null && visibleKeys.length > 0 && (
        <TableContainer component={Paper}>
          <Table aria-label={intl.formatMessage({ id: 'keys.title' })}>
            <TableHead>
              <TableRow>
                <TableCell>
                  <FormattedMessage id="keys.columnName" />
                </TableCell>
                <TableCell>
                  <FormattedMessage id="keys.columnUser" />
                </TableCell>
                <TableCell>
                  <FormattedMessage id="keys.columnContext" />
                </TableCell>
                <TableCell>
                  <FormattedMessage id="keys.columnTenant" />
                </TableCell>
                <TableCell>
                  <FormattedMessage id="keys.columnStatus" />
                </TableCell>
                <TableCell>
                  <FormattedMessage id="keys.columnCreated" />
                </TableCell>
                <TableCell align="right">
                  <FormattedMessage id="keys.columnActions" />
                </TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {visibleKeys.map((key) => {
                const isActive = key.status === 'active';
                return (
                  <TableRow key={key.keyId ?? `${key.tenantId}#${key.contextId}#${key.userId}#${key.createdAt}`}>
                    <TableCell>{key.keyName ?? '—'}</TableCell>
                    <TableCell>
                      <Stack direction="row" spacing={1} alignItems="center">
                        <Typography
                          variant="body2"
                          sx={{ fontFamily: 'monospace', fontSize: 12 }}
                        >
                          {key.userId ?? '—'}
                        </Typography>
                        {key.userType && (
                          <Chip
                            size="small"
                            icon={
                              key.userType === 'SERVICE' ? (
                                <SmartToyIcon fontSize="small" />
                              ) : (
                                <PersonIcon fontSize="small" />
                              )
                            }
                            label={
                              <FormattedMessage
                                id={
                                  key.userType === 'SERVICE'
                                    ? 'members.typeService'
                                    : 'members.typeHuman'
                                }
                              />
                            }
                          />
                        )}
                      </Stack>
                    </TableCell>
                    <TableCell>{key.contextId ?? '—'}</TableCell>
                    <TableCell sx={{ fontFamily: 'monospace', fontSize: 12 }}>
                      {key.tenantId ?? '—'}
                    </TableCell>
                    <TableCell>
                      <Chip
                        label={
                          <FormattedMessage
                            id={isActive ? 'keys.statusActive' : 'keys.statusRevoked'}
                          />
                        }
                        size="small"
                        color={isActive ? 'success' : 'default'}
                      />
                    </TableCell>
                    <TableCell sx={{ color: 'text.secondary', fontSize: 13 }}>
                      {key.createdAt ? new Date(key.createdAt).toLocaleDateString() : '—'}
                    </TableCell>
                    <TableCell align="right">
                      <Tooltip title={intl.formatMessage({ id: 'keys.actionRevoke' })}>
                        <span>
                          <IconButton
                            size="small"
                            onClick={() => setRevokeTarget(key)}
                            disabled={!isActive || revokeMutation.isPending}
                            aria-label={intl.formatMessage({ id: 'keys.actionRevoke' })}
                          >
                            <DeleteOutlineIcon fontSize="small" />
                          </IconButton>
                        </span>
                      </Tooltip>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      {/* Create scoped key — opens the 5-step wizard. On success the
          wizard internally invalidates ['scopedKeys'] so the
          table refetches without explicit wiring here. Closing the
          dialog (either via Done on confirmation, or Cancel earlier)
          is the only thing KeysPage handles directly. */}
      <ScopedKeyCreateDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        initialEnv={activeMembership?.tenantKind ?? 'live'}
      />

      {/* Revoke confirmation — ConfirmDialog bakes in aria-labelledby,
          pending-guarded dismissal, and an IN-DIALOG role="alert" error
          slot so a failed revoke is announced and never occluded behind
          the open modal. The error slot carries the requestId
          via <ApiErrorAlert>'s sibling <RequestIdCaption> shape. */}
      <ConfirmDialog
        open={revokeTarget !== null}
        title={<FormattedMessage id="keys.revokeConfirmTitle" />}
        body={
          // Inline (`component="span"`, display:block) — ConfirmDialog renders
          // `body` inside a <p> (DialogContentText); a block <div> there is
          // invalid DOM nesting (React 19 hydration warning).
          <>
            <Box component="span" sx={{ display: 'block', mb: 2 }}>
              <FormattedMessage
                id="keys.revokeConfirmBody"
                values={{
                  keyName: <strong>{revokeTarget?.keyName ?? ''}</strong>,
                  userId: <code>{revokeTarget?.userId ?? ''}</code>,
                }}
              />
            </Box>
            <Box component="span" sx={{ display: 'block', color: 'warning.main' }}>
              <FormattedMessage id="keys.revokeConfirmWarning" />
            </Box>
          </>
        }
        confirmLabel={<FormattedMessage id="keys.revokeConfirmCta" />}
        cancelLabel={<FormattedMessage id="keys.revokeCancelCta" />}
        onConfirm={handleRevokeConfirm}
        onClose={handleRevokeClose}
        pending={revokeMutation.isPending}
        error={
          revokeMutation.isError ? (
            <>
              <FormattedMessage
                id="keys.revokeError"
                values={{
                  message:
                    revokeMutation.error instanceof Error
                      ? revokeMutation.error.message
                      : String(revokeMutation.error),
                }}
              />
              <RequestIdCaption error={revokeMutation.error} />
            </>
          ) : undefined
        }
      />
    </Stack>
  );
}
