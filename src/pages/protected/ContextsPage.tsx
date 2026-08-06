// ---------------------------------------------------------------------------
// ContextsPage — admin-app's `/access/contexts` list view.
//
// Functional scope:
//   - Lists every app context in the tenant, and creates new ones, through the
//     owner-gated developer API (see ../../api/developerApi). The partner-API
//     bearer is pinned to a single context, so it can neither enumerate the
//     tenant's contexts nor provision a new one — only the developer API,
//     authenticated by the Cognito session and gated to owners server-side, can.
//   - Per-row role + profile counts via parallel `useQueries`, each issued with
//     a bearer minted for that row's own context (a context-pinned bearer can
//     only read within its context). N+1 round trips total; fine for the
//     expected handful of contexts per tenant.
//   - Always lists every context as a row (including when there's only the
//     auto-seeded one) — clicking a row opens its detail. No auto-redirect:
//     the list is the primary surface and must stay visible/discoverable.
//   - Create context Dialog — three-field form (contextId, name,
//     description) with ID format validation mirroring the backend's
//     `^[a-z][a-z0-9-]{2,30}$` rule.
//   - Edit Dialog operates within the target context, so it uses a bearer
//     minted for it. It shares the create form's shape (contextId disabled —
//     immutable).
//   - Delete Dialog goes through the owner-gated developer API (like create:
//     teardown authority is held server-side; no browser credential can do it).
//     Deletion cascades — the context and everything in it is permanently
//     erased — so the dialog shows the live role + profile counts and requires
//     typing the contextId to confirm, mirroring the server's own `confirm`
//     echo contract. The reserved contexts' rows hide Delete entirely (the
//     server refuses them unconditionally — surfacing the action would set a
//     false expectation). Teardown is asynchronous: a deleted context lingers
//     with a "Deleting…" status marker until the backend finishes draining it.
//
// Built on TanStack Query; queryKeys come from `accessQueryKeys` so list /
// detail / invalidation paths stay in lockstep. Tenant + context resolution is
// implicit via the bearer-token claims — the SDK methods take no body tenantId.
// ---------------------------------------------------------------------------

import { useEffect, useId, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  IconButton,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import EditIcon from '@mui/icons-material/Edit';
import RefreshIcon from '@mui/icons-material/Refresh';
import { FormattedMessage, useIntl } from 'react-intl';
import {
  LoadingBlock,
  SubmitButton,
} from '@vectros-ai/react';
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';

import { useActiveTenantId } from '../../auth';
import { vectrosApiClient } from '../../api/vectrosApi';
import type {
  AccessProfileResponse,
  RoleResponse,
} from '../../api/vectrosApi';
import { useDeveloperApi } from '../../api/developerApi';
import type { AppContextSummary } from '../../api/developerApi';
import { ApiErrorAlert } from '../../components/ApiErrorAlert';
import { accessQueryKeys } from '../../lib/accessQueryKeys';
import { drainPages, AUTH_PAGE_SIZE } from '../../lib/drainPages';
import {
  RESERVED_VECTROS_ADMIN_CONTEXT_ID,
  RESERVED_DEFAULT_CONTEXT_ID,
} from '../../lib/reservedContexts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Lifecycle statuses of a context whose asynchronous teardown is under way. */
const TEARDOWN_STATUSES = new Set(['purging', 'deleted']);

/**
 * App context / role ID format: lowercase letter, then 2-30 chars of
 * lowercase letters, digits, or dashes. Mirrors the backend's context-id
 * format rule, applied client-side as a pre-submit guard so the user sees the
 * same error they'd get from the server, without the round-trip.
 */
const CONTEXT_ID_PATTERN = /^[a-z][a-z0-9-]{2,30}$/;


// ---------------------------------------------------------------------------
// ContextsPage
// ---------------------------------------------------------------------------

/** A per-row count: the number, `null` while loading, or 'error' on failure. */
type CountValue = number | null | 'error';

export function ContextsPage(): React.JSX.Element {
  const intl = useIntl();
  const queryClient = useQueryClient();
  const tenant = useActiveTenantId();
  const devApi = useDeveloperApi();

  // Top-level list query — the owner-gated developer API, the only surface that
  // can enumerate every context in the tenant (see the module header).
  const contextsQuery = useQuery({
    queryKey: accessQueryKeys.appContexts(),
    queryFn: () =>
      drainPages<AppContextSummary>((startFrom) =>
        devApi.listAppContexts(startFrom, AUTH_PAGE_SIZE),
      ),
  });
  // Stabilize the empty-fallback reference so dependent useMemo / useEffect
  // don't re-run on every render (lint: react-hooks/exhaustive-deps).
  const contexts = useMemo<AppContextSummary[]>(
    () => contextsQuery.data ?? [],
    [contextsQuery.data],
  );

  // Per-context parallel counts. We fetch roles + profiles for each
  // loaded context in parallel; the `useQueries` API returns an array of
  // QueryResult objects keyed by `queryKey` so they stay independently
  // refetchable + invalidatable from anywhere in the app.
  const countQueries = useQueries({
    queries: contexts.flatMap((ctx) => {
      const id = ctx.contextId;
      // The reserved control-plane context can't back a context-pinned bearer
      // (the partner API rejects an explicit mint for it outright), so a
      // per-row count fetch for it would only ever fail — skip it rather than
      // spin forever. Its row shows "—" instead (see ContextRow below).
      if (!id || id === RESERVED_VECTROS_ADMIN_CONTEXT_ID) return [];
      return [
        {
          queryKey: accessQueryKeys.roles(id),
          queryFn: () =>
            drainPages<RoleResponse>((startFrom) =>
              vectrosApiClient(tenant, id).auth.listRoles(
                startFrom === undefined
                  ? { contextId: id, limit: AUTH_PAGE_SIZE }
                  : { contextId: id, startFrom, limit: AUTH_PAGE_SIZE },
              ),
            ),
        },
        {
          queryKey: accessQueryKeys.profiles(id),
          queryFn: () =>
            drainPages<AccessProfileResponse>((startFrom) =>
              vectrosApiClient(tenant, id).auth.listAccessProfiles(
                startFrom === undefined
                  ? { contextId: id, limit: AUTH_PAGE_SIZE }
                  : { contextId: id, startFrom, limit: AUTH_PAGE_SIZE },
              ),
            ),
        },
      ];
    }),
  });
  // Build a lookup: contextId → { roles, profiles }, each a count, `null` while
  // loading, or 'error' when its query failed. countQueries' order matches the
  // flatMap above: roles first then profiles for each context.
  const counts = useMemo<
    Record<string, { roles: CountValue; profiles: CountValue }>
  >(() => {
    const result: Record<string, { roles: CountValue; profiles: CountValue }> = {};
    let i = 0;
    for (const ctx of contexts) {
      const id = ctx.contextId;
      // No entry for the reserved context — it contributed no queries above,
      // so there is nothing at countQueries[i] to consume for it. ContextRow
      // renders "—" for a missing entry rather than the loading placeholder.
      if (!id || id === RESERVED_VECTROS_ADMIN_CONTEXT_ID) continue;
      const tplQuery = countQueries[i];
      const profQuery = countQueries[i + 1];
      i += 2;
      // `undefined` = still loading, `'error'` = the count query failed (the
      // drain refuses to return a partial count, so a listing past the page
      // ceiling lands here too). Conflating the two rendered a permanent
      // "loading" placeholder for a count that was never coming.
      result[id] = {
        roles: tplQuery?.isError ? 'error' : tplQuery?.data ? tplQuery.data.length : null,
        profiles: profQuery?.isError ? 'error' : profQuery?.data ? profQuery.data.length : null,
      };
    }
    return result;
  }, [contexts, countQueries]);

  // Create / edit / delete dialog state.
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<AppContextSummary | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AppContextSummary | null>(null);

  const handleRefresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: accessQueryKeys.appContexts() });
  };

  // ---- render ---------------------------------------------------------

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
              <FormattedMessage id="access.contexts.title" />
            </Typography>
            <Typography variant="body1" color="text.secondary" sx={{ mt: 1 }}>
              <FormattedMessage
                id="access.contexts.subtitle"
                values={{ defaultContextId: <code>{RESERVED_DEFAULT_CONTEXT_ID}</code> }}
              />
            </Typography>
          </Box>
          <Button
            variant="contained"
            startIcon={<AddIcon />}
            onClick={() => setCreateOpen(true)}
            // Keep the label on one line — the header Stack was squeezing the
            // large button so its text wrapped to three lines.
            sx={{ whiteSpace: 'nowrap', flexShrink: 0 }}
          >
            <FormattedMessage id="access.contexts.createButton" />
          </Button>
        </Stack>
      </Box>

      {contextsQuery.isError && (
        <ApiErrorAlert error={contextsQuery.error}>
          <FormattedMessage id="access.contexts.loadError.friendly" />
        </ApiErrorAlert>
      )}

      {contextsQuery.isLoading && !contextsQuery.isError && (
        <LoadingBlock label={intl.formatMessage({ id: 'access.contexts.loading' })} />
      )}

      {contextsQuery.isSuccess && contexts.length === 0 && (
        <Paper sx={{ p: 4, textAlign: 'center' }}>
          <Typography variant="body1" color="text.secondary">
            <FormattedMessage
              id="access.contexts.empty"
              values={{ defaultContextId: <code>{RESERVED_VECTROS_ADMIN_CONTEXT_ID}</code> }}
            />
          </Typography>
        </Paper>
      )}

      {contextsQuery.isSuccess && contexts.length > 0 && (
        <>
          <Stack direction="row" alignItems="center" spacing={2}>
            <Box sx={{ flexGrow: 1 }} />
            <Tooltip title={intl.formatMessage({ id: 'access.shared.refresh' })}>
              <span>
                <IconButton
                  onClick={handleRefresh}
                  disabled={contextsQuery.isFetching}
                  aria-label={intl.formatMessage({ id: 'access.shared.refresh' })}
                >
                  <RefreshIcon />
                </IconButton>
              </span>
            </Tooltip>
          </Stack>

          <TableContainer component={Paper}>
            <Table aria-label={intl.formatMessage({ id: 'access.contexts.title' })}>
              <TableHead>
                <TableRow>
                  <TableCell sx={{ fontWeight: 600 }}>
                    <FormattedMessage id="access.contexts.columnId" />
                  </TableCell>
                  <TableCell sx={{ fontWeight: 600 }}>
                    <FormattedMessage id="access.contexts.columnName" />
                  </TableCell>
                  <TableCell sx={{ fontWeight: 600 }}>
                    <FormattedMessage id="access.contexts.columnDescription" />
                  </TableCell>
                  <TableCell sx={{ fontWeight: 600 }} align="right">
                    <FormattedMessage id="access.contexts.columnRolesCount" />
                  </TableCell>
                  <TableCell sx={{ fontWeight: 600 }} align="right">
                    <FormattedMessage id="access.contexts.columnProfilesCount" />
                  </TableCell>
                  <TableCell sx={{ fontWeight: 600 }}>
                    <FormattedMessage id="access.contexts.columnCreated" />
                  </TableCell>
                  <TableCell sx={{ fontWeight: 600 }} align="right">
                    <FormattedMessage id="access.contexts.columnActions" />
                  </TableCell>
                  {/* Trailing chevron column — signposts that the row opens detail. */}
                  <TableCell sx={{ width: 40 }} aria-hidden />
                </TableRow>
              </TableHead>
              <TableBody>
                {contexts.map((ctx, index) => (
                  <ContextRow
                    key={ctx.contextId ?? ctx.id ?? `ctx-${index}`}
                    context={ctx}
                    counts={ctx.contextId ? counts[ctx.contextId] : undefined}
                    onEdit={() => setEditTarget(ctx)}
                    onDelete={() => setDeleteTarget(ctx)}
                  />
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </>
      )}

      {/* Create / Edit dialog (shared shape, mode-switched). */}
      <ContextEditorDialog
        mode={editTarget !== null ? 'edit' : 'create'}
        open={createOpen || editTarget !== null}
        target={editTarget}
        onClose={() => {
          setCreateOpen(false);
          setEditTarget(null);
        }}
      />

      {/* Delete confirmation (typed contextId echo). */}
      <ContextDeleteDialog
        target={deleteTarget}
        counts={deleteTarget?.contextId ? counts[deleteTarget.contextId] : undefined}
        onClose={() => setDeleteTarget(null)}
      />
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// ContextRow — one table row. Extracted so per-row logic (action visibility
// on the reserved vectros-admin context, count rendering with loading state)
// is co-located.
// ---------------------------------------------------------------------------

function ContextRow({
  context,
  counts,
  onEdit,
  onDelete,
}: {
  context: AppContextSummary;
  counts: { roles: CountValue; profiles: CountValue } | undefined;
  onEdit: () => void;
  onDelete: () => void;
}): React.JSX.Element {
  const intl = useIntl();
  const navigate = useNavigate();
  const id = context.contextId ?? '';
  // The reserved contexts can never be deleted (the server refuses them
  // unconditionally), so their rows hide the Delete action rather than offer a
  // guaranteed failure. A context already tearing down hides it too — there is
  // nothing further to delete.
  const reserved =
    id === RESERVED_VECTROS_ADMIN_CONTEXT_ID || id === RESERVED_DEFAULT_CONTEXT_ID;
  const tearingDown = TEARDOWN_STATUSES.has(context.status ?? '');
  const deletable = Boolean(id) && !reserved && !tearingDown;
  // The control-plane context can't back a context-pinned bearer (the partner
  // API rejects an explicit mint for it outright), so its role/profile counts
  // are never fetched (see ContextsPage's countQueries above) and its Edit
  // action — which would mint the same way — would only ever fail. `default`
  // has no such restriction and keeps both.
  const metricsUnavailable = id === RESERVED_VECTROS_ADMIN_CONTEXT_ID;
  const editable = Boolean(id) && !metricsUnavailable;

  const open = (): void => {
    if (id) navigate(`/access/contexts/${id}`);
  };
  // Keyboard affordance: a <tr> is not natively focusable/operable, so
  // keyboard users could otherwise only reach a context via the Edit icon.
  // Enter / Space on the focused row opens its detail page, matching the
  // pointer click — without changing the row's table semantics.
  const onKeyDown = (event: React.KeyboardEvent<HTMLTableRowElement>): void => {
    if (!id) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      open();
    }
  };

  /** Cell for a per-row count: a number, a load failure, or not-yet-resolved. */
  const countCell = (value: CountValue): React.ReactNode =>
    value === 'error' ? (
      <Box
        component="span"
        aria-label={intl.formatMessage({ id: 'access.contexts.countError' })}
        sx={{ color: 'error.main' }}
      >
        <FormattedMessage id="access.contexts.countErrorShort" />
      </Box>
    ) : value == null ? (
      <Box
        component="span"
        aria-label={intl.formatMessage({ id: 'access.contexts.countLoading' })}
        sx={{ color: 'text.disabled' }}
      >
        <FormattedMessage id="access.contexts.countPlaceholder" />
      </Box>
    ) : (
      value
    );

  return (
    <TableRow
      hover
      onClick={open}
      {...(id
        ? {
            tabIndex: 0,
            onKeyDown,
            'aria-label': intl.formatMessage(
              { id: 'access.contexts.openRow' },
              { contextId: id },
            ),
          }
        : {})}
      sx={{ cursor: id ? 'pointer' : 'default' }}
    >
      <TableCell sx={{ fontFamily: 'monospace', fontSize: 13 }}>
        {context.contextId ?? '—'}
        {/* Teardown is asynchronous — the row lingers while the backend drains
            the context, so mark it rather than leave a just-deleted context
            looking untouched. */}
        {tearingDown && (
          <Box component="span" sx={{ ml: 1, color: 'text.disabled', fontFamily: 'inherit' }}>
            <FormattedMessage id="access.contexts.purging" />
          </Box>
        )}
      </TableCell>
      <TableCell>{context.name ?? '—'}</TableCell>
      <TableCell sx={{ color: 'text.secondary' }}>
        {context.description ?? '—'}
      </TableCell>
      <TableCell align="right">
        {metricsUnavailable ? (
          <Tooltip title={intl.formatMessage({ id: 'access.contexts.metricsUnavailable' })}>
            <Box component="span" sx={{ color: 'text.disabled' }}>—</Box>
          </Tooltip>
        ) : (
          countCell(counts?.roles ?? null)
        )}
      </TableCell>
      <TableCell align="right">
        {metricsUnavailable ? (
          <Tooltip title={intl.formatMessage({ id: 'access.contexts.metricsUnavailable' })}>
            <Box component="span" sx={{ color: 'text.disabled' }}>—</Box>
          </Tooltip>
        ) : (
          countCell(counts?.profiles ?? null)
        )}
      </TableCell>
      <TableCell sx={{ color: 'text.secondary', fontSize: 13 }}>
        {context.createdAt ? new Date(context.createdAt).toLocaleDateString() : '—'}
      </TableCell>
      {/* Actions cell stops row-click propagation: the pencil edits this
          context's metadata (name/description) — a different action from the
          row click, which opens the context's detail. The tooltip names it
          explicitly so the two affordances don't read as the same thing. */}
      <TableCell align="right" onClick={(e) => e.stopPropagation()}>
        {editable && (
          <Tooltip title={intl.formatMessage({ id: 'access.contexts.editDetails' })}>
            <IconButton
              size="small"
              onClick={onEdit}
              aria-label={intl.formatMessage({ id: 'access.contexts.editDetails' })}
            >
              <EditIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        )}
        {/* Delete goes through the owner-gated developer API (teardown
            authority is server-side — see the module header). Hidden on the
            reserved contexts and on rows already tearing down: the server
            refuses those unconditionally, so offering the action would only
            promise a failure. */}
        {deletable && (
          <Tooltip title={intl.formatMessage({ id: 'access.shared.delete' })}>
            <IconButton
              size="small"
              onClick={onDelete}
              aria-label={intl.formatMessage({ id: 'access.shared.delete' })}
            >
              <DeleteOutlineIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        )}
      </TableCell>
      {/* Trailing chevron — the affordance that the row itself opens detail
          (kept OUT of the stop-propagation actions cell so it follows the row
          click). Decorative; the row's own aria-label names the action. */}
      <TableCell align="center" sx={{ width: 40, color: 'text.disabled' }}>
        {id ? <ChevronRightIcon fontSize="small" aria-hidden /> : null}
      </TableCell>
    </TableRow>
  );
}

// ---------------------------------------------------------------------------
// ContextEditorDialog — shared between create + edit modes. Only differs in
// the contextId field (editable + validated on create; disabled on edit).
// ---------------------------------------------------------------------------

interface ContextEditorDialogProps {
  mode: 'create' | 'edit';
  open: boolean;
  target: AppContextSummary | null;
  onClose: () => void;
}

function ContextEditorDialog({
  mode,
  open,
  target,
  onClose,
}: ContextEditorDialogProps): React.JSX.Element {
  const intl = useIntl();
  const queryClient = useQueryClient();
  const tenant = useActiveTenantId();
  const devApi = useDeveloperApi();

  const titleElementId = useId();
  const idHelperId = useId();

  // Local form state. Reset whenever the dialog re-opens (different target).
  const [contextId, setContextId] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  const contextIdInvalid =
    mode === 'create' && contextId !== '' && !CONTEXT_ID_PATTERN.test(contextId);
  const canSubmit =
    name.trim() !== '' &&
    (mode === 'edit' || (contextId !== '' && !contextIdInvalid));

  const mutation = useMutation({
    // Resolves to void — the dialog only invalidates + closes on success, so the
    // two branches' differing response shapes don't need to be reconciled.
    mutationFn: async (): Promise<void> => {
      if (mode === 'create') {
        // Creating a context is an owner-gated provisioning act → developer API.
        await devApi.createAppContext({
          contextId,
          name: name.trim(),
          ...(description.trim() ? { description: description.trim() } : {}),
        });
        return;
      }
      // Edit operates within the target context, so it uses a bearer minted for
      // that context. The server ignores body.contextId on update (it's
      // path-supplied + immutable); an empty description means "clear". The SDK
      // wraps the body in an envelope: `{ contextId, body: {...} }`.
      await vectrosApiClient(tenant, target!.contextId!).auth.updateAppContext({
        contextId: target!.contextId!,
        body: {
          contextId: target!.contextId!,
          name: name.trim(),
          ...(description.trim() ? { description: description.trim() } : {}),
        },
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: accessQueryKeys.appContexts() });
      onClose();
    },
  });

  // Seed the form whenever the dialog re-opens (different target), and drop any
  // prior submit failure so a reopened dialog starts clean.
  useEffect(() => {
    if (!open) return;
    setContextId(target?.contextId ?? '');
    setName(target?.name ?? '');
    setDescription(target?.description ?? '');
    mutation.reset();
    // `mutation` is stable across renders; depend only on the open/target inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, target]);

  const titleId = mode === 'create' ? 'access.contexts.createDialog.title' : 'access.contexts.editDialog.title';

  return (
    <Dialog
      open={open}
      onClose={() => !mutation.isPending && onClose()}
      maxWidth="sm"
      fullWidth
      aria-labelledby={titleElementId}
    >
      <DialogTitle id={titleElementId}>
        <FormattedMessage id={titleId} />
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2.5} sx={{ pt: 1 }}>
          <TextField
            label={intl.formatMessage({ id: 'access.contexts.createDialog.idLabel' })}
            value={contextId}
            onChange={(e) => setContextId(e.target.value)}
            disabled={mode === 'edit'}
            error={contextIdInvalid}
            helperText={
              contextIdInvalid ? (
                <FormattedMessage id="access.contexts.createDialog.idInvalid" />
              ) : (
                <FormattedMessage id="access.contexts.createDialog.idHelper" />
              )
            }
            FormHelperTextProps={{ id: idHelperId }}
            inputProps={{ maxLength: 31, spellCheck: false, 'aria-describedby': idHelperId }}
            sx={{ '& input': { fontFamily: 'monospace' } }}
          />
          <TextField
            label={intl.formatMessage({ id: 'access.contexts.createDialog.nameLabel' })}
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
          <TextField
            label={intl.formatMessage({ id: 'access.contexts.createDialog.descriptionLabel' })}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            multiline
            minRows={2}
            maxRows={6}
          />
          {mutation.isError && (
            <ApiErrorAlert error={mutation.error}>
              <FormattedMessage
                id={
                  mode === 'create'
                    ? 'access.contexts.createDialog.createError.friendly'
                    : 'access.contexts.editDialog.saveError.friendly'
                }
              />
            </ApiErrorAlert>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={mutation.isPending}>
          <FormattedMessage id="access.shared.cancel" />
        </Button>
        <SubmitButton
          variant="contained"
          onClick={() => mutation.mutate()}
          disabled={!canSubmit}
          pending={mutation.isPending}
        >
          <FormattedMessage
            id={mode === 'create' ? 'access.contexts.createDialog.create' : 'access.shared.save'}
          />
        </SubmitButton>
      </DialogActions>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// ContextDeleteDialog — typed-confirmation teardown. Deletion cascades (the
// context and ALL of its contents are permanently erased), so instead of the
// old strict-refusal-when-non-zero rule this dialog surfaces the live role +
// profile counts as a "here's what you're deleting" warning and requires the
// user to type the contextId — the same echo the server itself demands via the
// `confirm` parameter before starting the cascade.
// ---------------------------------------------------------------------------

function ContextDeleteDialog({
  target,
  counts,
  onClose,
}: {
  target: AppContextSummary | null;
  counts: { roles: CountValue; profiles: CountValue } | undefined;
  onClose: () => void;
}): React.JSX.Element {
  const intl = useIntl();
  const queryClient = useQueryClient();
  const devApi = useDeveloperApi();
  const titleElementId = useId();
  const confirmHelperId = useId();

  const [typedId, setTypedId] = useState('');

  const mutation = useMutation({
    mutationFn: () => {
      if (!target?.contextId) return Promise.reject(new Error('No target'));
      // Teardown is an owner-gated act like create — developer API, not the
      // context-pinned partner bearer.
      return devApi.deleteAppContext(target.contextId);
    },
    onSuccess: () => {
      // The list refetch shows the context in its transitional "Deleting…"
      // state until the asynchronous cascade finishes draining it.
      void queryClient.invalidateQueries({ queryKey: accessQueryKeys.appContexts() });
      onClose();
    },
  });

  // Reset the typed echo + any prior failure whenever the dialog closes so
  // reopening (possibly for a different context) starts clean.
  useEffect(() => {
    if (target === null) {
      setTypedId('');
      mutation.reset();
    }
    // `mutation` is stable; only the target gate matters here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  // A count that FAILED to load must not read as "loaded" here: this dialog
  // uses the numbers to state a destroy's blast radius, and treating an
  // unavailable count as absent would let the sentence be omitted as though
  // the context were empty. 'error' is excluded alongside null, so the
  // sentence appears only when both numbers are real.
  const roleCount = typeof counts?.roles === 'number' ? counts.roles : null;
  const profileCount = typeof counts?.profiles === 'number' ? counts.profiles : null;
  const countsLoaded = roleCount != null && profileCount != null;
  // The destructive CTA arms only when the typed echo matches exactly —
  // mirroring the server's own confirm contract.
  const canDelete = target?.contextId != null && typedId === target.contextId;

  const handleClose = (): void => {
    if (!mutation.isPending) onClose();
  };

  return (
    <Dialog
      open={target !== null}
      onClose={handleClose}
      maxWidth="sm"
      fullWidth
      aria-labelledby={titleElementId}
    >
      <DialogTitle id={titleElementId}>
        <FormattedMessage
          id="access.contexts.deleteConfirm.title"
          values={{ contextId: target?.contextId ?? '' }}
        />
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2}>
          {mutation.isError && (
            <ApiErrorAlert error={mutation.error}>
              <FormattedMessage id="access.contexts.deleteConfirm.error.friendly" />
            </ApiErrorAlert>
          )}
          <DialogContentText component="div">
            <FormattedMessage id="access.contexts.deleteConfirm.body" />
            {/* Live counts, when loaded, make the blast radius concrete. */}
            {countsLoaded && (roleCount > 0 || profileCount > 0) && (
              <>
                {' '}
                <FormattedMessage
                  id="access.contexts.deleteConfirm.bodyCounts"
                  values={{ roles: roleCount, profiles: profileCount }}
                />
              </>
            )}
          </DialogContentText>
          <TextField
            label={intl.formatMessage({ id: 'access.contexts.deleteConfirm.confirmLabel' })}
            value={typedId}
            onChange={(e) => setTypedId(e.target.value)}
            helperText={
              <FormattedMessage
                id="access.contexts.deleteConfirm.confirmHelper"
                values={{ contextId: <code>{target?.contextId ?? ''}</code> }}
              />
            }
            FormHelperTextProps={{ id: confirmHelperId }}
            inputProps={{
              spellCheck: false,
              'aria-describedby': confirmHelperId,
            }}
            sx={{ '& input': { fontFamily: 'monospace' } }}
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={mutation.isPending}>
          <FormattedMessage id="access.shared.cancel" />
        </Button>
        <SubmitButton
          color="error"
          variant="contained"
          onClick={() => mutation.mutate()}
          disabled={!canDelete}
          pending={mutation.isPending}
        >
          <FormattedMessage id="access.contexts.deleteConfirm.cta" />
        </SubmitButton>
      </DialogActions>
    </Dialog>
  );
}
