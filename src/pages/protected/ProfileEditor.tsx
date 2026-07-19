// ---------------------------------------------------------------------------
// ProfileEditor — admin-app's
//   `/access/contexts/:ctxId/profiles/:principalId` and
//   `/profiles/new` editor.
//
// Functional scope:
//   - Create mode (route ends in `/new`): blank form; on save POSTs and
//     navigates to the new profile's edit page.
//   - Edit mode: fetches the profile; on save PATCHes via PUT (the SDK's
//     idempotent update path) and stays on the page.
//   - **XOR source radio**: 'role' vs 'inline'. The backend rejects
//     bodies with neither or both set; the UI enforces by only showing
//     ONE of (role Autocomplete | ScopeEditor) at a time.
//   - **Source switching guard**: if the user toggles the radio while
//     the abandoned side has draft content, confirm via window.confirm
//     before discarding.
//   - **Role Autocomplete**: lists roles in this context (same
//     cached query as ContextDetailPage + RoleEditor's
//     referencing-count). "View this role" link routes to the
//     role's edit page (triggers dirty-state guard if any).
//   - **ScopeEditor reuse** (inline source branch): same component as
//     RoleEditor, with the same readonly-array boundary conversion.
//   - **Identity overrides** — expandable section. Ownership dimensions are
//     namespaced (`scope:org`, `scope:client`, and custom `scope:<ns>`); the
//     built-in org/client get dedicated fields and any custom namespace is an
//     "additional scopes" row. Values round-trip through the canonical
//     `scope:<ns>` form. An owned identity may carry at
//     most two scope namespaces. Expanded by default when the loaded profile has
//     any overrides set; collapsed otherwise (the "Show advanced" pattern).
//   - **Sticky save bar** matching RoleEditor.
//   - **Clone Dialog** with "Materialize role into inline scopes"
//     toggle (default OFF — preserves role ref). Toggle ON copies
//     the source role's scopes into the clone's inline scopes,
//     decoupling from future role changes.
//   - **Delete Dialog** — unconditional (the server applies no cascade refusal
//     for profiles). Copy mentions the ~5-min authorizer policy-cache window
//     for scoped-key impact.
// ---------------------------------------------------------------------------

import { useEffect, useId, useMemo, useState } from 'react';
import {
  Link as RouterLink,
  useNavigate,
  useParams,
} from 'react-router';
import {
  AppBar,
  Autocomplete,
  Box,
  Breadcrumbs,
  Button,
  Chip,
  Collapse,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  FormLabel,
  IconButton,
  Link,
  Radio,
  RadioGroup,
  Stack,
  Switch,
  TextField,
  Toolbar,
  Tooltip,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import { FormattedMessage, useIntl } from 'react-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ConfirmDialog,
  LoadingBlock,
  SubmitButton,
} from '@vectros-ai/react';

import {
  ScopeEditor,
  emptyClause,
  normalizeScopes,
  validateClauses,
  formatScopeClauseValidationError,
} from '../../components/ScopeEditor';
import type { ScopeClause } from '../../components/ScopeEditor';
import { ApiErrorAlert } from '../../components/ApiErrorAlert';
import { RequestIdCaption } from '../../components/RequestIdCaption';
import { useActiveTenantId } from '../../auth';
import { vectrosApiClient } from '../../api/vectrosApi';
import type {
  AccessProfileResponse,
  RoleResponse,
} from '../../api/vectrosApi';
import type { UserResponse } from '../../api/vectrosApi';
import { accessQueryKeys } from '../../lib/accessQueryKeys';
import {
  emptyIdentityOverrides,
  parseIdentityOverrides,
  serializeIdentityOverrides,
  canonicalOverridesKey,
  canonicalOverridesKeyOfModel,
  countOverrideNamespaces,
  validateIdentityOverrides,
} from '../../lib/identityOverrides';
import type {
  IdentityOverridesModel,
  IdentityOverridesValidationError,
} from '../../lib/identityOverrides';
import { MAX_SCOPE_NAMESPACES } from '../../lib/scopeNamespace';
import { drainPages, AUTH_PAGE_SIZE } from '../../lib/drainPages';
import { statusCodeOf } from '../../lib/apiError';
import { useBeforeNavigate } from '../../lib/useBeforeNavigate';
import { usePrincipalDirectory, userPrincipalId, userLabel } from '../../lib/usePrincipalDirectory';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Principal-ID format: `usr_<suffix>` or `key_<suffix>`. Suffix is letters,
 * digits, underscores, dashes. Mirrors the server's principal-id format rule.
 */
const PRINCIPAL_ID_PATTERN = /^(usr|key)_[A-Za-z0-9_-]+$/;

type SourceType = 'role' | 'inline';

/**
 * Default formatter for an {@link IdentityOverridesValidationError} — one
 * user-facing string via the message catalog.
 */
function formatOverridesValidationError(
  error: IdentityOverridesValidationError,
  intl: ReturnType<typeof useIntl>,
): string {
  switch (error.code) {
    case 'tooManyNamespaces':
      return intl.formatMessage(
        { id: 'access.profiles.editor.identityOverridesTooMany' },
        { max: error.max },
      );
    case 'extraBuiltin':
      return intl.formatMessage(
        { id: 'access.profiles.editor.identityOverrideNamespaceBuiltin' },
        { namespace: error.namespace },
      );
    case 'extraDuplicate':
      return intl.formatMessage(
        { id: 'access.profiles.editor.identityOverrideNamespaceDuplicate' },
        { namespace: error.namespace },
      );
    case 'extraMissingValue':
      return intl.formatMessage({
        id: 'access.profiles.editor.identityOverrideValueRequired',
      });
    case 'extraNamespace':
      switch (error.error.code) {
        case 'reserved':
          return intl.formatMessage(
            { id: 'access.profiles.editor.identityOverrideNamespaceReserved' },
            { namespace: error.error.namespace },
          );
        case 'empty':
        case 'grammar':
          return intl.formatMessage({
            id: 'access.profiles.editor.identityOverrideNamespaceInvalid',
          });
      }
  }
}

// ---------------------------------------------------------------------------
// ProfileEditor
// ---------------------------------------------------------------------------

export function ProfileEditor(): React.JSX.Element {
  const intl = useIntl();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const tenant = useActiveTenantId();
  const { ctxId = '', principalId: principalIdParam = '' } = useParams<{
    ctxId: string;
    principalId: string;
  }>();
  const principalIdFromUrl = decodeURIComponent(principalIdParam);

  const isCreate = principalIdParam === 'new';

  // Tenant user directory — drives the assign-by-name picker (create) and the
  // human-readable label for the principal being edited.
  const directory = usePrincipalDirectory();

  // ── Form state ─────────────────────────────────────────────────────────
  const [principalId, setPrincipalId] = useState('');
  const [sourceType, setSourceType] = useState<SourceType>('role');
  const [roleRef, setRoleRef] = useState<string>('');
  const [scopes, setScopes] = useState<ScopeClause[]>(() => [emptyClause()]);
  // Namespaced identity overrides — dedicated org/client + custom-namespace
  // `extras`, with any unmodellable wire key preserved in `passthrough`.
  const [overrides, setOverrides] = useState<IdentityOverridesModel>(
    emptyIdentityOverrides,
  );
  const [overridesExpanded, setOverridesExpanded] = useState(false);
  // Raw save error (null when none) — kept as the thrown error so
  // <ApiErrorAlert> can surface the requestId. A 409 on create is a
  // duplicate-principalId domain conflict, rendered as a specific message.
  const [saveError, setSaveError] = useState<unknown>(null);

  // ── Dialog state ───────────────────────────────────────────────────────
  const [cloneOpen, setCloneOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  // Pending source-switch awaiting discard confirmation (null when none).
  // Replaces the old native window.confirm with an a11y-managed, i18n,
  // testable <ConfirmDialog>.
  const [pendingSourceSwitch, setPendingSourceSwitch] =
    useState<SourceType | null>(null);

  // ── Queries ────────────────────────────────────────────────────────────
  const profileQuery = useQuery({
    queryKey: accessQueryKeys.profile(ctxId, principalIdFromUrl),
    queryFn: () =>
      vectrosApiClient(tenant, ctxId).auth.getAccessProfile({
        contextId: ctxId,
        principalId: principalIdFromUrl,
      }),
    enabled: !isCreate && ctxId !== '' && principalIdFromUrl !== '',
  });

  // Roles for the Autocomplete. Already cached by ContextDetailPage
  // and RoleEditor — usually returns instantly here.
  const rolesQuery = useQuery({
    queryKey: accessQueryKeys.roles(ctxId),
    queryFn: () =>
      drainPages<RoleResponse>((startFrom) =>
        vectrosApiClient(tenant, ctxId).auth.listRoles(
          startFrom === undefined
            ? { contextId: ctxId, limit: AUTH_PAGE_SIZE }
            : { contextId: ctxId, startFrom, limit: AUTH_PAGE_SIZE },
        ),
      ),
    enabled: ctxId !== '',
  });
  const roles: RoleResponse[] = useMemo(
    () => rolesQuery.data ?? [],
    [rolesQuery.data],
  );

  // ── Baseline + prefill ─────────────────────────────────────────────────
  const [baseline, setBaseline] = useState<AccessProfileResponse | null>(null);
  useEffect(() => {
    if (isCreate || !profileQuery.data) return;
    const loaded = profileQuery.data;
    setPrincipalId(loaded.principalId ?? '');
    if (loaded.roleId) {
      setSourceType('role');
      setRoleRef(loaded.roleId);
      setScopes([emptyClause()]);
    } else {
      setSourceType('inline');
      setRoleRef('');
      setScopes(normalizeScopes(loaded.scopes));
    }
    // Read identityOverrides through the canonical model so a `scope:org`-keyed
    // override (0.34 read-back) is visible + preserved, not silently dropped.
    // Custom namespaces populate `extras`; org/client fill their fields.
    const parsed = parseIdentityOverrides(
      loaded.identityOverrides as Record<string, unknown> | undefined,
    );
    setOverrides(parsed);
    setOverridesExpanded(
      parsed.org.trim() !== '' ||
        parsed.client.trim() !== '' ||
        parsed.extras.length > 0 ||
        Object.keys(parsed.passthrough).length > 0,
    );
    setBaseline(loaded);
  }, [isCreate, profileQuery.data]);

  // ── Source-switch guard: confirm before discarding the other side's draft.
  // Apply the switch, clearing the abandoned side.
  const applySourceSwitch = (next: SourceType): void => {
    if (next === 'role') {
      setScopes([emptyClause()]);
    } else {
      setRoleRef('');
    }
    setSourceType(next);
  };

  // Entry point from the radio. If the side being abandoned holds a draft,
  // defer the switch behind a <ConfirmDialog> rather than discard silently.
  const requestSourceSwitch = (next: SourceType): void => {
    if (next === sourceType) return;
    const inlineHasDraft = scopes.some((c) => c.allowed_actions.length > 0);
    const roleHasDraft = roleRef !== '';
    const abandoning =
      (sourceType === 'inline' && inlineHasDraft) ||
      (sourceType === 'role' && roleHasDraft);
    if (abandoning) {
      setPendingSourceSwitch(next);
      return;
    }
    applySourceSwitch(next);
  };

  // ── Identity-override mutators ─────────────────────────────────────────
  const setOverrideOrg = (v: string): void =>
    setOverrides((o) => ({ ...o, org: v }));
  const setOverrideClient = (v: string): void =>
    setOverrides((o) => ({ ...o, client: v }));
  const addOverrideExtra = (): void =>
    setOverrides((o) => ({
      ...o,
      extras: [...o.extras, { namespace: '', value: '' }],
    }));
  const updateOverrideExtra = (
    index: number,
    patch: Partial<{ namespace: string; value: string }>,
  ): void =>
    setOverrides((o) => ({
      ...o,
      extras: o.extras.map((e, i) => (i === index ? { ...e, ...patch } : e)),
    }));
  const removeOverrideExtra = (index: number): void =>
    setOverrides((o) => ({
      ...o,
      extras: o.extras.filter((_, i) => i !== index),
    }));

  // ── Dirty-state ────────────────────────────────────────────────────────
  const dirty = useMemo<boolean>(() => {
    if (isCreate) {
      return (
        principalId !== '' ||
        roleRef !== '' ||
        scopes.some((c) => c.allowed_actions.length > 0) ||
        countOverrideNamespaces(overrides) > 0
      );
    }
    if (!baseline) return false;
    const baseSourceIsRole = !!baseline.roleId;
    if (baseSourceIsRole !== (sourceType === 'role')) return true;
    if (sourceType === 'role' && roleRef !== (baseline.roleId ?? '')) {
      return true;
    }
    // Compare against the baseline projected through the SAME normalizer used
    // to seed the form (incl. data_scope + empty→[emptyClause()]), so a freshly
    // loaded, unedited inline-scope profile is never spuriously dirty.
    if (
      sourceType === 'inline' &&
      JSON.stringify(scopes) !== JSON.stringify(normalizeScopes(baseline.scopes))
    ) {
      return true;
    }
    // Compare identity overrides through the canonical normal form so a
    // freshly-loaded profile (whose overrides read back as `scope:<ns>` keys in
    // arbitrary order) is never spuriously dirty, and a real edit to ANY
    // namespace — not just org/client — is detected.
    return (
      canonicalOverridesKeyOfModel(overrides) !==
      canonicalOverridesKey(
        baseline.identityOverrides as Record<string, unknown> | undefined,
      )
    );
  }, [
    isCreate,
    baseline,
    principalId,
    sourceType,
    roleRef,
    scopes,
    overrides,
  ]);

  useBeforeNavigate(dirty);

  // ── Validation ─────────────────────────────────────────────────────────
  const principalIdInvalid =
    isCreate && principalId !== '' && !PRINCIPAL_ID_PATTERN.test(principalId);
  const scopeError = useMemo(
    () => (sourceType === 'inline' ? validateClauses(scopes) : null),
    [sourceType, scopes],
  );
  const scopeErrorMessage = useMemo(
    () =>
      scopeError !== null
        ? formatScopeClauseValidationError(scopeError, intl)
        : null,
    [scopeError, intl],
  );
  const sourceValid =
    sourceType === 'role' ? roleRef !== '' : scopeError === null;
  // Identity-overrides validation is independent of the source XOR — it applies
  // to role- and inline-source profiles alike.
  const overridesError = useMemo(
    () => validateIdentityOverrides(overrides),
    [overrides],
  );
  const overridesErrorMessage = useMemo(
    () =>
      overridesError !== null
        ? formatOverridesValidationError(overridesError, intl)
        : null,
    [overridesError, intl],
  );
  const canSubmit =
    (isCreate ? principalId !== '' && !principalIdInvalid : true) &&
    sourceValid &&
    overridesError === null &&
    dirty;

  // Plain-language summary of what the profile currently grants — so the grant
  // is legible without decoding raw scope clauses (a bare `*` in particular).
  const grantSummary = useMemo<React.ReactNode>(() => {
    if (sourceType === 'role') {
      return roleRef ? (
        <FormattedMessage id="access.profiles.editor.grantRole" values={{ roleId: roleRef }} />
      ) : (
        <FormattedMessage id="access.profiles.editor.grantNone" />
      );
    }
    const actions = Array.from(
      new Set(scopes.flatMap((c) => c.allowed_actions)),
    ).filter((a) => a.trim() !== '');
    if (actions.length === 0) {
      return <FormattedMessage id="access.profiles.editor.grantNone" />;
    }
    if (actions.includes('*')) {
      return <FormattedMessage id="access.profiles.editor.grantFull" />;
    }
    return (
      <FormattedMessage
        id="access.profiles.editor.grantActions"
        values={{ actions: actions.join(', ') }}
      />
    );
  }, [sourceType, roleRef, scopes]);

  // ── Save ───────────────────────────────────────────────────────────────
  const buildBody = () => {
    // identityOverrides — canonical `scope:<ns>` wire form; blanks omitted;
    // unmodellable keys preserved. Cast to the SDK's nested-Record typing at the
    // boundary (runtime override values are flat strings).
    const overridesWire = serializeIdentityOverrides(overrides);
    const hasOverrides = Object.keys(overridesWire).length > 0;
    return {
      principalId: isCreate ? principalId : principalIdFromUrl,
      ...(sourceType === 'role'
        ? { roleId: roleRef }
        : {
            scopes: scopes.map((c) => ({
              allowed_actions: [...c.allowed_actions],
              data_scope: c.data_scope as Record<string, Record<string, unknown>>,
            })),
          }),
      ...(hasOverrides
        ? { identityOverrides: overridesWire as unknown as Record<string, Record<string, unknown>> }
        : {}),
    };
  };

  const saveMutation = useMutation({
    onMutate: () => {
      setSaveError(null);
    },
    mutationFn: () => {
      const client = vectrosApiClient(tenant, ctxId);
      const body = buildBody();
      if (isCreate) {
        return client.auth.createAccessProfile({ contextId: ctxId, body });
      }
      return client.auth.updateAccessProfile({
        contextId: ctxId,
        principalId: principalIdFromUrl,
        body,
      });
    },
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: accessQueryKeys.profiles(ctxId) });
      if (isCreate && data?.principalId) {
        setBaseline(data);
        navigate(
          `/access/contexts/${ctxId}/profiles/${encodeURIComponent(data.principalId)}`,
        );
      } else if (data) {
        setBaseline(data);
        void queryClient.invalidateQueries({
          queryKey: accessQueryKeys.profile(ctxId, principalIdFromUrl),
        });
      }
    },
    onError: (err: unknown) => {
      setSaveError(err);
    },
  });

  // A 409 on create is a duplicate-principalId domain conflict the user can fix
  // inline (the principalId is the path key); surface a specific message. On
  // update the principalId is immutable so a 409 can't be a duplicate-id
  // conflict — fall through to the generic alert.
  const isDuplicateIdConflict =
    isCreate && saveError != null && statusCodeOf(saveError) === 409;

  // ── Render ─────────────────────────────────────────────────────────────

  return (
    <Stack spacing={3} sx={{ pb: 10 }}>
      <Breadcrumbs aria-label={intl.formatMessage({ id: 'access.breadcrumbRoot' })}>
        <Link component={RouterLink} to="/access/contexts" color="inherit" underline="hover">
          <FormattedMessage id="access.breadcrumbRoot" />
        </Link>
        <Link
          component={RouterLink}
          to={`/access/contexts/${ctxId}?tab=profiles`}
          color="inherit"
          underline="hover"
          sx={{ fontFamily: 'monospace', fontSize: 14 }}
        >
          {ctxId}
        </Link>
        <Typography color="text.primary" sx={{ fontFamily: 'monospace', fontSize: 14 }}>
          {isCreate ? (
            <FormattedMessage id="access.profiles.editor.titleCreate" />
          ) : (
            principalIdFromUrl
          )}
        </Typography>
      </Breadcrumbs>

      <Stack direction="row" alignItems="flex-start" justifyContent="space-between" spacing={2}>
        <Box>
          <Typography variant="h4" component="h1" sx={{ fontWeight: 700 }}>
            {isCreate ? (
              <FormattedMessage id="access.profiles.editor.titleCreate" />
            ) : (
              <FormattedMessage
                id="access.profiles.editor.titleEdit"
                values={{ principalId: principalIdFromUrl }}
              />
            )}
          </Typography>
        </Box>
        {!isCreate && (
          <Stack direction="row" spacing={1}>
            {/* Gated on `baseline` so Clone/Delete can't fire before the
                profile loads — Clone with a null source rejects with "No
                source". */}
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

      {!isCreate && profileQuery.isError && (
        <ApiErrorAlert error={profileQuery.error}>
          <FormattedMessage id="access.profiles.editor.loadErrorBody" />
        </ApiErrorAlert>
      )}

      {!isCreate && profileQuery.isLoading && (
        <LoadingBlock label={intl.formatMessage({ id: 'access.profiles.loading' })} />
      )}

      {(isCreate || baseline) && (
        <Stack spacing={3}>
          {/* Principal — on create, assign by user (email) via a picker; an
              API key can still be bound by typing its id (freeSolo). On edit
              the principal is immutable, shown resolved to its email. */}
          {isCreate ? (
            <Autocomplete<UserResponse, false, false, true>
              freeSolo
              options={directory.users}
              loading={directory.isLoading}
              getOptionLabel={(opt) =>
                typeof opt === 'string' ? opt : (userLabel(opt) ?? userPrincipalId(opt.id ?? ''))
              }
              isOptionEqualToValue={(opt, val) =>
                typeof opt !== 'string' && typeof val !== 'string' && opt.id === val.id
              }
              value={
                directory.users.find((u) => u.id && userPrincipalId(u.id) === principalId) ??
                (principalId || null)
              }
              onChange={(_, next) => {
                if (next == null) setPrincipalId('');
                else if (typeof next === 'string') setPrincipalId(next.trim());
                else setPrincipalId(next.id ? userPrincipalId(next.id) : '');
              }}
              onInputChange={(_, text, reason) => {
                // Treat free typing (a key id) as the value; ignore the
                // label-sync that fires on selection / programmatic reset.
                if (reason === 'input') setPrincipalId(text.trim());
              }}
              renderOption={(props, opt) =>
                typeof opt === 'string' ? null : (
                  <Box component="li" {...props} key={opt.id}>
                    <Stack spacing={0}>
                      <Typography variant="body2">
                        {userLabel(opt) ?? userPrincipalId(opt.id ?? '')}
                      </Typography>
                      <Typography
                        variant="caption"
                        color="text.secondary"
                        sx={{ fontFamily: 'monospace' }}
                      >
                        {userPrincipalId(opt.id ?? '')}
                      </Typography>
                    </Stack>
                  </Box>
                )
              }
              sx={{ maxWidth: 480 }}
              renderInput={(params) => (
                <TextField
                  {...params}
                  label={intl.formatMessage({ id: 'access.profiles.editor.principalPickerLabel' })}
                  placeholder={intl.formatMessage({
                    id: 'access.profiles.editor.principalPickerPlaceholder',
                  })}
                  error={principalIdInvalid}
                  helperText={
                    principalIdInvalid ? (
                      <FormattedMessage id="access.profiles.editor.principalIdInvalid" />
                    ) : (
                      <FormattedMessage id="access.profiles.editor.principalPickerHelper" />
                    )
                  }
                />
              )}
            />
          ) : (
            <Box sx={{ maxWidth: 480 }}>
              <Typography variant="overline" color="text.secondary" component="div">
                <FormattedMessage id="access.profiles.editor.principalIdLabel" />
              </Typography>
              <Stack direction="row" spacing={1} alignItems="baseline" flexWrap="wrap">
                <Typography variant="body1" sx={{ fontWeight: 600 }}>
                  {directory.resolve(principalIdFromUrl).label}
                </Typography>
                {directory.resolve(principalIdFromUrl).hasName && (
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ fontFamily: 'monospace' }}
                  >
                    {principalIdFromUrl}
                  </Typography>
                )}
              </Stack>
            </Box>
          )}

          {/* Source — XOR radio */}
          <Box>
            <FormLabel id="profile-source-legend" component="legend" sx={{ mb: 1 }}>
              <FormattedMessage id="access.profiles.editor.sourceLegend" />
            </FormLabel>
            <RadioGroup
              aria-labelledby="profile-source-legend"
              value={sourceType}
              onChange={(_, v) => requestSourceSwitch(v as SourceType)}
            >
              <FormControlLabel
                value="role"
                control={<Radio />}
                label={<FormattedMessage id="access.profiles.editor.sourceRole" />}
              />
              <FormControlLabel
                value="inline"
                control={<Radio />}
                label={<FormattedMessage id="access.profiles.editor.sourceInline" />}
              />
            </RadioGroup>
          </Box>

          {/* Source body — exactly one visible at a time. */}
          {sourceType === 'role' && (
            <Stack spacing={1.5} sx={{ maxWidth: 720 }}>
              <Autocomplete
                options={roles}
                getOptionLabel={(t) =>
                  t.name ? `${t.name} (${t.roleId})` : (t.roleId ?? '')
                }
                value={roles.find((t) => t.roleId === roleRef) ?? null}
                onChange={(_, next) => setRoleRef(next?.roleId ?? '')}
                isOptionEqualToValue={(opt, val) => opt.roleId === val.roleId}
                renderInput={(params) => (
                  <TextField
                    {...params}
                    label={intl.formatMessage({
                      id: 'access.profiles.editor.roleRefLabel',
                    })}
                    placeholder={intl.formatMessage({
                      id: 'access.profiles.editor.roleRefPlaceholder',
                    })}
                    helperText={
                      <FormattedMessage id="access.profiles.editor.roleRefHelper" />
                    }
                  />
                )}
              />
              {roleRef && (
                <Box>
                  <Link
                    component={RouterLink}
                    to={`/access/contexts/${ctxId}/roles/${roleRef}`}
                    underline="hover"
                  >
                    <FormattedMessage id="access.profiles.editor.roleRefViewLink" />
                  </Link>
                </Box>
              )}
            </Stack>
          )}

          {sourceType === 'inline' && (
            <Box>
              <Typography variant="overline" color="text.secondary" component="div" sx={{ mb: 1 }}>
                <FormattedMessage id="access.profiles.editor.scopesLabel" />
              </Typography>
              <ScopeEditor value={scopes} onChange={setScopes} />
              {scopeErrorMessage && (
                <Typography variant="body2" color="error.main" role="alert" sx={{ mt: 1 }}>
                  {scopeErrorMessage}
                </Typography>
              )}
            </Box>
          )}

          {/* Effective-grant summary — plain language, so the grant is legible
              (a `*` reads as "full access" rather than a cryptic chip). */}
          <Box
            sx={{
              p: 1.5,
              border: 1,
              borderColor: 'divider',
              borderRadius: 1,
              bgcolor: 'action.hover',
              maxWidth: 720,
            }}
          >
            <Typography variant="overline" color="text.secondary" component="div">
              <FormattedMessage id="access.profiles.editor.grantLegend" />
            </Typography>
            <Typography variant="body2">{grantSummary}</Typography>
          </Box>

          {/* Identity overrides — collapsed by default. */}
          <Box>
            <Button
              size="small"
              variant="text"
              onClick={() => setOverridesExpanded((v) => !v)}
              endIcon={overridesExpanded ? <ExpandLessIcon /> : <ExpandMoreIcon />}
              sx={{ textTransform: 'none' }}
              aria-expanded={overridesExpanded}
            >
              <FormattedMessage
                id={
                  overridesExpanded
                    ? 'access.profiles.editor.identityOverridesHide'
                    : 'access.profiles.editor.identityOverridesShow'
                }
              />
            </Button>
            <Collapse in={overridesExpanded}>
              <Stack spacing={2.5} sx={{ mt: 1.5, maxWidth: 560 }}>
                <Typography variant="body2" color="text.secondary">
                  <FormattedMessage id="access.profiles.editor.identityOverridesHelp" />
                </Typography>
                <Stack spacing={2} sx={{ maxWidth: 480 }}>
                  <TextField
                    size="small"
                    label={intl.formatMessage({
                      id: 'access.profiles.editor.identityOverrideOrgId',
                    })}
                    value={overrides.org}
                    onChange={(e) => setOverrideOrg(e.target.value)}
                    inputProps={{ spellCheck: false }}
                  />
                  <TextField
                    size="small"
                    label={intl.formatMessage({
                      id: 'access.profiles.editor.identityOverrideClientId',
                    })}
                    value={overrides.client}
                    onChange={(e) => setOverrideClient(e.target.value)}
                    inputProps={{ spellCheck: false }}
                  />
                </Stack>

                {/* Additional (custom-namespace) scope overrides. */}
                <Box>
                  <Typography variant="overline" color="text.secondary" component="div">
                    <FormattedMessage id="access.profiles.editor.identityOverrideExtrasLegend" />
                  </Typography>
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    component="div"
                    sx={{ mb: overrides.extras.length ? 1.5 : 0.5 }}
                  >
                    <FormattedMessage id="access.profiles.editor.identityOverrideExtrasHelp" />
                  </Typography>
                  <Stack spacing={1}>
                    {overrides.extras.map((extra, i) => (
                      <Stack key={i} direction="row" spacing={1} alignItems="flex-start">
                        <TextField
                          size="small"
                          label={intl.formatMessage({
                            id: 'access.profiles.editor.identityOverrideNamespaceLabel',
                          })}
                          placeholder={intl.formatMessage({
                            id: 'access.profiles.editor.identityOverrideNamespacePlaceholder',
                          })}
                          value={extra.namespace}
                          onChange={(e) =>
                            updateOverrideExtra(i, { namespace: e.target.value })
                          }
                          inputProps={{ spellCheck: false }}
                          sx={{ width: 200, '& input': { fontFamily: 'monospace' } }}
                        />
                        <TextField
                          size="small"
                          label={intl.formatMessage({
                            id: 'access.profiles.editor.identityOverrideValueLabel',
                          })}
                          value={extra.value}
                          onChange={(e) =>
                            updateOverrideExtra(i, { value: e.target.value })
                          }
                          inputProps={{ spellCheck: false }}
                          sx={{ flex: 1 }}
                        />
                        <Tooltip
                          title={intl.formatMessage({
                            id: 'access.profiles.editor.identityOverrideRemoveScope',
                          })}
                        >
                          <IconButton
                            size="small"
                            onClick={() => removeOverrideExtra(i)}
                            aria-label={intl.formatMessage({
                              id: 'access.profiles.editor.identityOverrideRemoveScope',
                            })}
                            sx={{ mt: 0.5 }}
                          >
                            <DeleteOutlineIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                      </Stack>
                    ))}
                  </Stack>
                  <Button
                    size="small"
                    variant="text"
                    startIcon={<AddIcon />}
                    onClick={addOverrideExtra}
                    disabled={
                      countOverrideNamespaces(overrides) >= MAX_SCOPE_NAMESPACES
                    }
                    sx={{ textTransform: 'none', mt: overrides.extras.length ? 1 : 0.5 }}
                  >
                    <FormattedMessage id="access.profiles.editor.identityOverrideAddScope" />
                  </Button>
                </Box>

                {overridesErrorMessage && (
                  <Typography variant="body2" color="error.main" role="alert">
                    {overridesErrorMessage}
                  </Typography>
                )}
              </Stack>
            </Collapse>
          </Box>

          {saveError != null &&
            (isDuplicateIdConflict ? (
              <ApiErrorAlert error={saveError}>
                <FormattedMessage id="access.profiles.editor.duplicateId" />
              </ApiErrorAlert>
            ) : (
              <ApiErrorAlert error={saveError}>
                <FormattedMessage id="access.profiles.editor.saveErrorBody" />
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
          {!isCreate && baseline && (
            <Chip
              size="small"
              label={
                sourceType === 'role' ? (
                  <FormattedMessage
                    id="access.profiles.sourceRole"
                    values={{ roleId: roleRef || '—' }}
                  />
                ) : (
                  <FormattedMessage
                    id="access.profiles.sourceInline"
                    values={{ count: scopes.length }}
                  />
                )
              }
              variant="outlined"
            />
          )}
          <Button
            onClick={() => navigate(`/access/contexts/${ctxId}?tab=profiles`)}
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

      {/* Source-switch discard confirmation — replaces the old native
          window.confirm so the prompt is styled, localized, focus-managed and
          testable. Destructive-styled because it discards a draft. */}
      <ConfirmDialog
        open={pendingSourceSwitch !== null}
        title={<FormattedMessage id="access.profiles.editor.sourceSwitchTitle" />}
        body={<FormattedMessage id="access.profiles.editor.sourceSwitchBody" />}
        confirmLabel={
          <FormattedMessage id="access.profiles.editor.sourceSwitchConfirmCta" />
        }
        cancelLabel={
          <FormattedMessage id="access.profiles.editor.sourceSwitchCancel" />
        }
        onConfirm={() => {
          if (pendingSourceSwitch !== null) applySourceSwitch(pendingSourceSwitch);
          setPendingSourceSwitch(null);
        }}
        onClose={() => setPendingSourceSwitch(null)}
      />

      <CloneProfileDialog
        open={cloneOpen}
        onClose={() => setCloneOpen(false)}
        source={baseline}
        ctxId={ctxId}
        roles={roles}
      />
      <DeleteProfileDialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        ctxId={ctxId}
        principalId={principalIdFromUrl}
      />
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// CloneProfileDialog — collects new principalId + materialize toggle.
// ---------------------------------------------------------------------------

function CloneProfileDialog({
  open,
  onClose,
  source,
  ctxId,
  roles,
}: {
  open: boolean;
  onClose: () => void;
  source: AccessProfileResponse | null;
  ctxId: string;
  roles: RoleResponse[];
}): React.JSX.Element {
  const intl = useIntl();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const tenant = useActiveTenantId();

  const titleId = useId();
  const [newPrincipalId, setNewPrincipalId] = useState('');
  const [materialize, setMaterialize] = useState(false);
  const [cloneError, setCloneError] = useState<unknown>(null);

  useEffect(() => {
    if (!open) return;
    setNewPrincipalId('');
    setMaterialize(false);
    setCloneError(null);
  }, [open]);

  const idInvalid =
    newPrincipalId !== '' && !PRINCIPAL_ID_PATTERN.test(newPrincipalId);
  const canSubmit = newPrincipalId !== '' && !idInvalid;
  const sourceIsRole = !!source?.roleId;

  const mutation = useMutation({
    onMutate: () => {
      setCloneError(null);
    },
    mutationFn: () => {
      if (!source) return Promise.reject(new Error('No source'));
      const client = vectrosApiClient(tenant, ctxId);
      // Determine the body shape based on source + materialize toggle.
      let body: Record<string, unknown>;
      if (sourceIsRole && !materialize) {
        // Keep the role reference.
        body = {
          principalId: newPrincipalId,
          roleId: source.roleId,
        };
      } else if (sourceIsRole && materialize) {
        // Materialize: find the source role + copy its scopes inline.
        const tpl = roles.find((t) => t.roleId === source.roleId);
        body = {
          principalId: newPrincipalId,
          scopes: (tpl?.scopes ?? []).map((s) => ({
            allowed_actions: [...(s.allowed_actions ?? [])],
            data_scope: (s.data_scope ?? {}) as Record<string, Record<string, unknown>>,
          })),
        };
      } else {
        // Source is already inline — copy scopes verbatim. (Materialize
        // toggle is a no-op visually but we still surface it for symmetry.)
        body = {
          principalId: newPrincipalId,
          scopes: (source.scopes ?? []).map((s) => ({
            allowed_actions: [...(s.allowed_actions ?? [])],
            data_scope: (s.data_scope ?? {}) as Record<string, Record<string, unknown>>,
          })),
        };
      }
      // identityOverrides copy verbatim (if source has any).
      const overrides = (source.identityOverrides ?? {}) as Record<string, unknown>;
      if (Object.keys(overrides).length > 0) {
        body.identityOverrides = overrides;
      }
      return client.auth.createAccessProfile({
        contextId: ctxId,
        body: body as never,
      });
    },
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: accessQueryKeys.profiles(ctxId) });
      onClose();
      if (data?.principalId) {
        navigate(
          `/access/contexts/${ctxId}/profiles/${encodeURIComponent(data.principalId)}`,
        );
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
        <FormattedMessage id="access.profiles.cloneDialog.title" />
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2.5} sx={{ pt: 1 }}>
          <TextField
            label={intl.formatMessage({
              id: 'access.profiles.cloneDialog.newPrincipalIdLabel',
            })}
            value={newPrincipalId}
            onChange={(e) => setNewPrincipalId(e.target.value)}
            error={idInvalid}
            helperText={
              idInvalid ? (
                <FormattedMessage id="access.profiles.editor.principalIdInvalid" />
              ) : (
                <FormattedMessage id="access.profiles.editor.principalIdHelper" />
              )
            }
            inputProps={{ spellCheck: false }}
            sx={{ '& input': { fontFamily: 'monospace' } }}
          />
          {sourceIsRole && (
            <Box>
              <FormControlLabel
                control={
                  <Switch
                    checked={materialize}
                    onChange={(_, v) => setMaterialize(v)}
                  />
                }
                label={
                  <FormattedMessage id="access.profiles.cloneDialog.materializeToggle" />
                }
              />
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                <FormattedMessage id="access.profiles.cloneDialog.materializeHelp" />
              </Typography>
            </Box>
          )}
          {cloneError != null &&
            (isDuplicateIdConflict ? (
              <ApiErrorAlert error={cloneError}>
                <FormattedMessage id="access.profiles.cloneDialog.duplicateId" />
              </ApiErrorAlert>
            ) : (
              <ApiErrorAlert error={cloneError}>
                <FormattedMessage id="access.profiles.cloneDialog.cloneErrorBody" />
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
          <FormattedMessage id="access.profiles.cloneDialog.cta" />
        </SubmitButton>
      </DialogActions>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// DeleteProfileDialog — unconditional. Backend has no ref-refusal here.
// ---------------------------------------------------------------------------

function DeleteProfileDialog({
  open,
  onClose,
  ctxId,
  principalId,
}: {
  open: boolean;
  onClose: () => void;
  ctxId: string;
  principalId: string;
}): React.JSX.Element {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const tenant = useActiveTenantId();

  const mutation = useMutation({
    mutationFn: () =>
      vectrosApiClient(tenant, ctxId).auth.deleteAccessProfile({
        contextId: ctxId,
        principalId,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: accessQueryKeys.profiles(ctxId) });
      onClose();
      navigate(`/access/contexts/${ctxId}?tab=profiles`);
    },
  });

  // Reset the mutation on close so a prior failure doesn't re-appear when the
  // dialog is reopened.
  const handleClose = (): void => {
    if (mutation.isPending) return;
    mutation.reset();
    onClose();
  };

  return (
    <ConfirmDialog
      open={open}
      title={
        <FormattedMessage
          id="access.profiles.deleteConfirm.title"
          values={{ principalId }}
        />
      }
      body={
        <FormattedMessage
          id="access.profiles.deleteConfirm.body"
          values={{ principalId, contextId: ctxId }}
        />
      }
      confirmLabel={<FormattedMessage id="access.profiles.deleteConfirm.cta" />}
      cancelLabel={<FormattedMessage id="access.shared.cancel" />}
      onConfirm={() => mutation.mutate()}
      onClose={handleClose}
      pending={mutation.isPending}
      error={
        mutation.isError ? (
          <>
            <FormattedMessage id="access.profiles.deleteConfirm.errorBody" />
            <RequestIdCaption error={mutation.error} />
          </>
        ) : undefined
      }
    />
  );
}
