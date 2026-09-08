// ---------------------------------------------------------------------------
// RoleEditor — admin-app's `/access/contexts/:ctxId/roles/:tplId` and
// `/roles/new` editor.
//
// Functional scope:
//   - Create mode (route ends in `/new`): blank form; on save POSTs and
//     navigates to the new role's edit page.
//   - Edit mode (route ends in a real roleId): fetches the role;
//     on save PATCHes and stays on the page (the design's deferred
//     "navigate back to list with Snackbar" UX would also be valid —
//     staying on the page makes successive small edits frictionless).
//   - Reuses `ScopeEditor` verbatim — exported helpers
//     (`emptyClause`, `validateClauses`, `formatScopeClauseValidationError`)
//     drive the in-place validation pattern.
//   - Dirty-state guard via `useBeforeNavigate`.
//   - Sticky bottom save bar (Cancel + Save) for the long-form flow.
//   - **Propagation banner** (edit mode, when refs > 0): explains that
//     role changes propagate to N profiles within the authorizer's
//     policy-cache window. The "View referencing profiles" link routes to
//     the Profiles tab with a `?roleId=` filter.
//   - Clone Dialog: collects new roleId + new name; on submit creates
//     a new role with the source's scopes copied verbatim; routes to
//     the new role's edit page.
//   - Delete Dialog: strict-refusal when the role is still referenced. Client-
//     side filters `listAccessProfiles(ctxId)` for refs; if any, the Delete
//     button stays disabled with the "Reassign or delete those profiles
//     first" helper. The server enforces the same rule authoritatively.
//
// Why full page (not Dialog):
//   - ScopeEditor with N clauses gets tall — modal dialog scrolling is
//     awkward. The page format gives the editor room to breathe.
//   - Deep-linkable URLs ("look at this role I'm editing").
//   - Sticky save bar requires page-level layout control.
// ---------------------------------------------------------------------------

import { useEffect, useId, useMemo, useState } from 'react';
import {
  Link as RouterLink,
  useNavigate,
  useParams,
} from 'react-router';
import {
  Alert,
  AppBar,
  Box,
  Breadcrumbs,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Link,
  Stack,
  TextField,
  Toolbar,
  Typography,
} from '@mui/material';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import { FormattedMessage, useIntl } from 'react-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiErrorAlert, LoadingBlock, SubmitButton, extractErrorMessage, statusCodeOf } from '@vectros-ai/react';

import {
  ScopeEditor,
  emptyClause,
  normalizeScopes,
  validateClauses,
  formatScopeClauseValidationError,
  toWireScopeClauses,
} from '../../components/ScopeEditor';
import type { ScopeClause } from '../../components/ScopeEditor';
import { useActiveTenantId } from '../../auth';
import { vectrosApiClient } from '../../api/vectrosApi';
import type { AccessProfileResponse, RoleResponse } from '../../api/vectrosApi';
import { accessQueryKeys } from '../../lib/accessQueryKeys';
import { drainPages, AUTH_PAGE_SIZE } from '../../lib/drainPages';
import { useBeforeNavigate } from '../../lib/useBeforeNavigate';

// ---------------------------------------------------------------------------
// Constants — a roleId uses the same format as a context id (one rule for both).
// ---------------------------------------------------------------------------

const ROLE_ID_PATTERN = /^[a-z][a-z0-9-]{2,30}$/;

// ---------------------------------------------------------------------------
// RoleEditor
// ---------------------------------------------------------------------------

export function RoleEditor(): React.JSX.Element {
  const intl = useIntl();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const tenant = useActiveTenantId();
  const { ctxId = '', tplId = '' } = useParams<{ ctxId: string; tplId: string }>();

  const isCreate = tplId === 'new';

  // Form state.
  const [roleId, setRoleId] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [scopes, setScopes] = useState<ScopeClause[]>(() => [emptyClause()]);
  // Raw save error (null when none). Kept as the thrown error — not a
  // pre-stringified message — so <ApiErrorAlert> can surface the
  // requestId. A 409 on create is a duplicate-id domain conflict, rendered as
  // a specific inline message instead.
  const [saveError, setSaveError] = useState<unknown>(null);

  // Dialog state.
  const [cloneOpen, setCloneOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  // Edit mode: fetch the role.
  const roleQuery = useQuery({
    queryKey: accessQueryKeys.role(ctxId, tplId),
    queryFn: () =>
      vectrosApiClient(tenant, ctxId).auth.getRole({
        contextId: ctxId,
        roleId: tplId,
      }),
    enabled: !isCreate && ctxId !== '' && tplId !== '',
  });

  // Edit mode: fetch profiles to count refs (for the propagation banner +
  // the delete-refs guard). Same queryKey as ContextDetailPage's Profiles
  // tab so navigating between them reuses cached data.
  const profilesQuery = useQuery({
    queryKey: accessQueryKeys.profiles(ctxId),
    queryFn: () =>
      drainPages<AccessProfileResponse>((startFrom) =>
        vectrosApiClient(tenant, ctxId).auth.listAccessProfiles(
          startFrom === undefined
            ? { contextId: ctxId, limit: AUTH_PAGE_SIZE }
            : { contextId: ctxId, startFrom, limit: AUTH_PAGE_SIZE },
        ),
      ),
    enabled: !isCreate && ctxId !== '',
  });
  // `roleId` is present only when a profile composes exactly one role
  // (0.41.0) — a profile referencing this role alongside others returns
  // `roleIds` only, with `roleId` absent. Counting `roleId` alone
  // undercounts (down to 0) for a role that's only ever referenced via
  // multi-role composition, which would show "no profiles reference this
  // role" and enable Delete when that's false — the server independently
  // refuses the delete either way (`effectiveRoleIds().contains(roleId)`),
  // but the UI must not tell the operator the opposite of what's true.
  const referencingCount = useMemo<number>(
    () =>
      (profilesQuery.data ?? []).filter(
        (p) => p.roleId === tplId || (p.roleIds?.includes(tplId) ?? false),
      ).length,
    [profilesQuery.data, tplId],
  );

  // On loaded entity: prefill the form (edit mode).
  // The loaded entity is the source-of-truth dirty-state baseline.
  const [baseline, setBaseline] = useState<RoleResponse | null>(null);
  useEffect(() => {
    if (isCreate || !roleQuery.data) return;
    const loaded = roleQuery.data;
    setRoleId(loaded.roleId ?? '');
    setName(loaded.name ?? '');
    setDescription(loaded.description ?? '');
    setScopes(normalizeScopes(loaded.scopes));
    setBaseline(loaded);
  }, [isCreate, roleQuery.data]);

  // Dirty-state computation. Compare current form to the baseline (edit
  // mode) or to a "blank" baseline (create mode — any content = dirty).
  const dirty = useMemo<boolean>(() => {
    if (isCreate) {
      return (
        roleId !== '' ||
        name !== '' ||
        description !== '' ||
        scopes.some((c) => c.allowed_actions.length > 0)
      );
    }
    if (!baseline) return false;
    const nameMatches = name === (baseline.name ?? '');
    const descMatches = description === (baseline.description ?? '');
    // Compare against the baseline projected through the SAME normalizer
    // used to seed the form (incl. data_scope + empty→[emptyClause()]), so a
    // freshly loaded, unedited form is never spuriously dirty.
    const scopesMatch =
      JSON.stringify(scopes) === JSON.stringify(normalizeScopes(baseline.scopes));
    return !nameMatches || !descMatches || !scopesMatch;
  }, [isCreate, roleId, name, description, scopes, baseline]);

  // Hook up navigation guard.
  useBeforeNavigate(dirty);

  // Validation. validateClauses returns a single error (or null) — the
  // most informative one — not a list. Render the formatted message
  // below the ScopeEditor when present.
  const roleIdInvalid =
    isCreate && roleId !== '' && !ROLE_ID_PATTERN.test(roleId);
  const scopeError = useMemo(() => validateClauses(scopes), [scopes]);
  const canSubmit =
    name.trim() !== '' &&
    (isCreate ? roleId !== '' && !roleIdInvalid : true) &&
    scopeError === null &&
    dirty &&
    // An edit here propagates to every profile referencing this role, and
    // `referencingCount` is how the editor tells the operator that. A failed
    // drain makes that count read zero, so saving would proceed with the blast
    // radius silently understated. Fail closed on the count, not just on the
    // list: `isError` is the only state where the count is a lie.
    (isCreate || !profilesQuery.isError);

  const saveMutation = useMutation({
    onMutate: () => {
      setSaveError(null);
    },
    mutationFn: () => {
      const client = vectrosApiClient(tenant, ctxId);
      // Convert the ScopeEditor's readonly arrays into the SDK's mutable
      // shape. Same pattern ScopedKeyCreateDialog uses; cast
      // covers the SDK's nested data_scope typing which our v1 editor
      // doesn't surface (fixed to `{}`).
      const body = {
        roleId: isCreate ? roleId : tplId,
        name: name.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        scopes: toWireScopeClauses(scopes),
      };
      if (isCreate) {
        return client.auth.createRole({ contextId: ctxId, body });
      }
      return client.auth.updateRole({
        contextId: ctxId,
        roleId: tplId,
        body,
      });
    },
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: accessQueryKeys.roles(ctxId) });
      if (isCreate && data?.roleId) {
        // Reset baseline BEFORE navigating so the dirty-guard doesn't fire
        // on the create→edit transition.
        setBaseline(data);
        navigate(`/access/contexts/${ctxId}/roles/${data.roleId}`);
      } else {
        // Edit: refresh the baseline from the response so the form is
        // "clean" again — successive small edits don't re-prompt.
        if (data) setBaseline(data);
        void queryClient.invalidateQueries({
          queryKey: accessQueryKeys.role(ctxId, tplId),
        });
      }
    },
    onError: (err: unknown) => {
      setSaveError(err);
    },
  });

  // A 409 on create is a duplicate-roleId domain conflict the user can fix
  // inline (the roleId is the path key), so surface a specific message rather
  // than the generic save error. On update the roleId is immutable, so a 409
  // can't be a duplicate-id conflict — fall through to the generic alert.
  const isDuplicateIdConflict =
    isCreate && saveError != null && statusCodeOf(saveError) === 409;

  // The server's message on a save failure is actionable (e.g. a 403 naming the
  // namespace/placement a credential may not write) — surface it beneath the
  // generic title rather than dropping it. Left off the duplicate-id branch
  // above, which already renders its own specific message.
  const saveErrorDetail = extractErrorMessage(saveError);

  // Inline-validation message rendered under the ScopeEditor. `scopeError`
  // is a single discriminated error (or null) — format it via the shared
  // helper that maps each code to an i18n key.
  const scopeErrorMessage = useMemo(
    () =>
      scopeError !== null
        ? formatScopeClauseValidationError(scopeError, intl)
        : null,
    [scopeError, intl],
  );

  // ---- render ---------------------------------------------------------

  return (
    <Stack spacing={3} sx={{ pb: 10 /* room for the sticky save bar */ }}>
      <Breadcrumbs aria-label={intl.formatMessage({ id: 'access.breadcrumbRoot' })}>
        <Link component={RouterLink} to="/access/contexts" color="inherit" underline="hover">
          <FormattedMessage id="access.breadcrumbRoot" />
        </Link>
        <Link
          component={RouterLink}
          to={`/access/contexts/${ctxId}?tab=roles`}
          color="inherit"
          underline="hover"
          sx={{ fontFamily: 'monospace', fontSize: 14 }}
        >
          {ctxId}
        </Link>
        <Typography color="text.primary" sx={{ fontFamily: 'monospace', fontSize: 14 }}>
          {isCreate ? <FormattedMessage id="access.roles.editor.titleCreate" /> : tplId}
        </Typography>
      </Breadcrumbs>

      <Stack direction="row" alignItems="flex-start" justifyContent="space-between" spacing={2}>
        <Box>
          <Typography variant="h4" component="h1" sx={{ fontWeight: 700 }}>
            {isCreate ? (
              <FormattedMessage id="access.roles.editor.titleCreate" />
            ) : (
              <FormattedMessage
                id="access.roles.editor.titleEdit"
                values={{ roleId: tplId }}
              />
            )}
          </Typography>
        </Box>
        {!isCreate && (
          <Stack direction="row" spacing={1}>
            {/* Gated on `baseline` so Clone/Delete can't fire before the role
                loads — Clone with a null source rejects with "No source". */}
            <Button
              variant="outlined"
              startIcon={<ContentCopyIcon />}
              onClick={() => setCloneOpen(true)}
              disabled={baseline == null}
            >
              <FormattedMessage id="access.shared.clone" />
            </Button>
            <Button
              variant="outlined"
              color="error"
              startIcon={<DeleteOutlineIcon />}
              onClick={() => setDeleteOpen(true)}
              disabled={baseline == null}
            >
              <FormattedMessage id="access.shared.delete" />
            </Button>
          </Stack>
        )}
      </Stack>

      {!isCreate && roleQuery.isError && (
        <ApiErrorAlert error={roleQuery.error}>
          <FormattedMessage id="access.roles.editor.loadErrorBody" />
        </ApiErrorAlert>
      )}

      {/* The profile drain backs the propagation warning below, and that warning
          is gated on a COUNT. A failed drain counts zero, which is
          indistinguishable from "no profile uses this role" — so without this
          the editor would quietly present an unreferenced-looking role and let
          it be saved, propagating the edit to every profile that does use it.
          Saving is blocked while the count is untrustworthy. */}
      {!isCreate && profilesQuery.isError && (
        <ApiErrorAlert error={profilesQuery.error}>
          <FormattedMessage id="access.roles.editor.profilesErrorBody" />
        </ApiErrorAlert>
      )}

      {!isCreate && roleQuery.isLoading && (
        <LoadingBlock label={intl.formatMessage({ id: 'access.roles.loading' })} />
      )}

      {!isCreate && baseline && referencingCount > 0 && (
        <Alert
          severity="info"
          role="status"
          action={
            <Button
              size="small"
              color="inherit"
              onClick={() =>
                navigate(`/access/contexts/${ctxId}?tab=profiles&roleId=${tplId}`)
              }
            >
              <FormattedMessage id="access.roles.editor.viewReferencingLink" />
            </Button>
          }
        >
          <FormattedMessage
            id="access.roles.editor.propagationBanner"
            values={{
              count: referencingCount,
              propagationNotice: intl.formatMessage({
                id: 'access.shared.propagationNotice',
              }),
            }}
          />
        </Alert>
      )}

      {/* Form body — visible once load completes (edit) or immediately (create). */}
      {(isCreate || baseline) && (
        <Stack spacing={3}>
          <TextField
            label={intl.formatMessage({ id: 'access.roles.editor.idLabel' })}
            value={isCreate ? roleId : tplId}
            onChange={(e) => isCreate && setRoleId(e.target.value)}
            disabled={!isCreate}
            error={roleIdInvalid}
            helperText={
              roleIdInvalid ? (
                <FormattedMessage id="access.roles.editor.idInvalid" />
              ) : (
                <FormattedMessage id="access.roles.editor.idHelper" />
              )
            }
            inputProps={{ maxLength: 31, spellCheck: false }}
            sx={{ '& input': { fontFamily: 'monospace' }, maxWidth: 480 }}
          />
          <TextField
            label={intl.formatMessage({ id: 'access.roles.editor.nameLabel' })}
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            sx={{ maxWidth: 480 }}
          />
          <TextField
            label={intl.formatMessage({ id: 'access.roles.editor.descriptionLabel' })}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            multiline
            minRows={2}
            maxRows={6}
            sx={{ maxWidth: 720 }}
          />
          <Box>
            <Typography variant="overline" color="text.secondary" component="div" sx={{ mb: 1 }}>
              <FormattedMessage id="access.roles.editor.scopesLabel" />
            </Typography>
            <ScopeEditor value={scopes} onChange={setScopes} />
            {scopeErrorMessage && (
              <Typography variant="body2" color="error.main" role="alert" sx={{ mt: 1 }}>
                {scopeErrorMessage}
              </Typography>
            )}
          </Box>
          {saveError != null &&
            (isDuplicateIdConflict ? (
              <ApiErrorAlert error={saveError}>
                <FormattedMessage id="access.roles.editor.duplicateId" />
              </ApiErrorAlert>
            ) : (
              <ApiErrorAlert error={saveError}>
                <FormattedMessage id="access.roles.editor.saveErrorBody" />
                {saveErrorDetail && (
                  <Typography variant="caption" component="p" sx={{ mt: 0.5, opacity: 0.85 }}>
                    {saveErrorDetail}
                  </Typography>
                )}
              </ApiErrorAlert>
            ))}
        </Stack>
      )}

      {/* Sticky save bar. */}
      <AppBar
        component="footer"
        position="fixed"
        color="default"
        elevation={3}
        sx={{ top: 'auto', bottom: 0 }}
      >
        <Toolbar sx={{ justifyContent: 'flex-end', gap: 1.5 }}>
          {!isCreate && referencingCount > 0 && (
            <Chip
              size="small"
              label={
                <FormattedMessage
                  id="access.roles.columnReferencingCount"
                  values={{ count: referencingCount }}
                />
              }
              variant="outlined"
            />
          )}
          <Button
            onClick={() =>
              navigate(`/access/contexts/${ctxId}?tab=roles`)
            }
            disabled={saveMutation.isPending}
          >
            <FormattedMessage id="access.shared.cancel" />
          </Button>
          <SubmitButton
            variant="contained"
            onClick={() => saveMutation.mutate()}
            disabled={!canSubmit}
            pending={saveMutation.isPending}
          >
            <FormattedMessage id="access.shared.save" />
          </SubmitButton>
        </Toolbar>
      </AppBar>

      <CloneRoleDialog
        open={cloneOpen}
        onClose={() => setCloneOpen(false)}
        source={baseline}
        ctxId={ctxId}
      />
      <DeleteRoleDialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        ctxId={ctxId}
        roleId={tplId}
        referencingCount={referencingCount}
        profilesLoaded={profilesQuery.isSuccess}
      />
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// CloneRoleDialog
// ---------------------------------------------------------------------------

function CloneRoleDialog({
  open,
  onClose,
  source,
  ctxId,
}: {
  open: boolean;
  onClose: () => void;
  source: RoleResponse | null;
  ctxId: string;
}): React.JSX.Element {
  const intl = useIntl();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const tenant = useActiveTenantId();

  const titleId = useId();
  const [newId, setNewId] = useState('');
  const [newName, setNewName] = useState('');
  const [cloneError, setCloneError] = useState<unknown>(null);

  useEffect(() => {
    if (!open || !source) return;
    setNewId(source.roleId ? `${source.roleId}-copy` : '');
    setNewName(source.name ? `${source.name} (copy)` : '');
    setCloneError(null);
  }, [open, source]);

  const idInvalid = newId !== '' && !ROLE_ID_PATTERN.test(newId);
  const canSubmit = newId !== '' && !idInvalid && newName.trim() !== '';

  const mutation = useMutation({
    onMutate: () => {
      setCloneError(null);
    },
    mutationFn: () => {
      if (!source) return Promise.reject(new Error('No source'));
      return vectrosApiClient(tenant, ctxId).auth.createRole({
        contextId: ctxId,
        body: {
          roleId: newId,
          name: newName.trim(),
          ...(source.description ? { description: source.description } : {}),
          // Every clause field carried through verbatim — dropping data_scope
          // would widen a row-scoped clause to ALL tenant rows, dropping
          // assignable_roles would widen a restricted clause back to composing
          // any role, and dropping granted_capabilities would clone the role
          // WITHOUT a capability grant it actually has (a silent narrowing, the
          // opposite failure mode, equally worth avoiding).
          scopes: toWireScopeClauses(source.scopes),
          // `assumable` is NOT a clause field, which is exactly why the sweep
          // above kept missing it: it sits one level up, on the role itself,
          // and the loop that carries clause fields cannot see it. It is the
          // role's /assume entitlement grant — the only thing that can move a
          // credential's identity — so a clone that drops it is a clone that
          // silently does less than the role it copied.
          //
          // Carrying it makes the clone REFUSE when the cloner cannot back the
          // grant, because create runs the same subset-of-caller check every
          // other authority-bearing write does. That is the right trade and the
          // same one the capabilities line above already makes: a loud refusal
          // beats a quiet, wrong clone.
          ...(source.assumable ? { assumable: source.assumable } : {}),
        },
      });
    },
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: accessQueryKeys.roles(ctxId) });
      onClose();
      if (data?.roleId) {
        navigate(`/access/contexts/${ctxId}/roles/${data.roleId}`);
      }
    },
    onError: (err: unknown) => {
      setCloneError(err);
    },
  });

  const isDuplicateIdConflict =
    cloneError != null && statusCodeOf(cloneError) === 409;

  return (
    <Dialog
      open={open}
      onClose={() => !mutation.isPending && onClose()}
      maxWidth="sm"
      fullWidth
      aria-labelledby={titleId}
    >
      <DialogTitle id={titleId}>
        <FormattedMessage id="access.roles.cloneDialog.title" />
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2.5} sx={{ pt: 1 }}>
          <TextField
            label={intl.formatMessage({ id: 'access.roles.cloneDialog.newIdLabel' })}
            value={newId}
            onChange={(e) => setNewId(e.target.value)}
            error={idInvalid}
            helperText={
              idInvalid ? <FormattedMessage id="access.roles.editor.idInvalid" /> : null
            }
            inputProps={{ maxLength: 31, spellCheck: false }}
            sx={{ '& input': { fontFamily: 'monospace' } }}
          />
          <TextField
            label={intl.formatMessage({ id: 'access.roles.cloneDialog.newNameLabel' })}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            required
          />
          {cloneError != null &&
            (isDuplicateIdConflict ? (
              <ApiErrorAlert error={cloneError}>
                <FormattedMessage id="access.roles.cloneDialog.duplicateId" />
              </ApiErrorAlert>
            ) : (
              <ApiErrorAlert error={cloneError}>
                <FormattedMessage id="access.roles.cloneDialog.cloneErrorBody" />
              </ApiErrorAlert>
            ))}
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
          <FormattedMessage id="access.roles.cloneDialog.cta" />
        </SubmitButton>
      </DialogActions>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// DeleteRoleDialog — strict refusal when referencingCount > 0. Profiles must
// load first to know the count; while loading the Delete button stays disabled
// (matches ContextsPage's pattern).
// ---------------------------------------------------------------------------

function DeleteRoleDialog({
  open,
  onClose,
  ctxId,
  roleId,
  referencingCount,
  profilesLoaded,
}: {
  open: boolean;
  onClose: () => void;
  ctxId: string;
  roleId: string;
  referencingCount: number;
  profilesLoaded: boolean;
}): React.JSX.Element {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const tenant = useActiveTenantId();
  const titleId = useId();

  const mutation = useMutation({
    mutationFn: () =>
      vectrosApiClient(tenant, ctxId).auth.deleteRole({
        contextId: ctxId,
        roleId,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: accessQueryKeys.roles(ctxId) });
      onClose();
      navigate(`/access/contexts/${ctxId}?tab=roles`);
    },
  });

  const hasRefs = referencingCount > 0;
  const canDelete = profilesLoaded && !hasRefs && !mutation.isPending;

  // Reset the mutation on close so a prior failure doesn't re-appear when the
  // dialog is reopened.
  const handleClose = (): void => {
    if (mutation.isPending) return;
    mutation.reset();
    onClose();
  };

  // NOTE: not ConfirmDialog here — the strict refs-refusal needs a *disabled*
  // confirm button (refs > 0), which ConfirmDialog doesn't currently expose.
  // The rest of the hardening (SubmitButton spinner, in-dialog ApiErrorAlert,
  // useId-linked title, pending-guarded dismissal) is adopted inline. A
  // `confirmDisabled` ConfirmDialog prop would let this fold in — deferred.
  return (
    <Dialog open={open} onClose={handleClose} aria-labelledby={titleId}>
      <DialogTitle id={titleId}>
        <FormattedMessage
          id="access.roles.deleteConfirm.title"
          values={{ roleId }}
        />
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2}>
          {mutation.isError && (
            <ApiErrorAlert error={mutation.error}>
              <FormattedMessage id="access.roles.deleteConfirm.errorBody" />
            </ApiErrorAlert>
          )}
          <Typography component="div" color="text.secondary">
            {hasRefs ? (
              <FormattedMessage
                id="access.roles.deleteConfirm.bodyRefs"
                values={{ count: referencingCount }}
              />
            ) : (
              <FormattedMessage id="access.roles.deleteConfirm.bodyEmpty" />
            )}
          </Typography>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose} disabled={mutation.isPending}>
          <FormattedMessage id="access.shared.cancel" />
        </Button>
        <SubmitButton
          color="error"
          variant="contained"
          onClick={() => mutation.mutate()}
          disabled={!canDelete}
          pending={mutation.isPending}
        >
          <FormattedMessage id="access.roles.deleteConfirm.cta" />
        </SubmitButton>
      </DialogActions>
    </Dialog>
  );
}
