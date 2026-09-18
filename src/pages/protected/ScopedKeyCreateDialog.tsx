// ---------------------------------------------------------------------------
// ScopedKeyCreateDialog — 5-step wizard for minting an ssk_* key.
//
// Steps:
//   1. basics       — keyName + env (drives ssk_live_* vs ssk_test_* prefix)
//   2. bind         — pick a PartnerUser (Humans | Services tabs);
//                     SERVICE tab supports inline creation.
//   3. context      — pick an AppContext + verify the AccessProfile exists
//                     for (context, user). Inline "+ Create profile" embeds
//                     <ScopeEditor>.
//   4. review       — read-only summary.
//   5. confirmation — call `auth.createScopedKey`; show rawKey ONCE on
//                     201, or a "key already exists" notice on 200
//                     (idempotent match — see the contract note below, which
//                     0.43.0 made conditional). 5-min Rust-authorizer-cache
//                     warning surfaced here.
//
// This step lands:
//   - The wizard container + 5-step Stepper.
//   - State plumbing for all wizard fields (keyName, env, boundUser,
//     contextId, profileExists, result, submitError).
//   - BasicsStep fully implemented with validation against the backend
//     rule (enforced by the backend — required, no
//     leading/trailing whitespace, ≤100 chars).
//   - Cancel / Back / Next buttons + their gates.
//
// Backend contract: createScopedKey accepts
// { keyName, tenantId, contextId, userId } and is idempotent on the
// 4-tuple — but NOT unconditionally, as of 0.43.0. Two refusals now run
// BEFORE the idempotency lookup: the bound access profile being suspended,
// and the bound user being suspended. Either returns 409 rather than the
// existing key's metadata, so a repeat POST of a tuple whose key already
// exists is refused too. Read the 200 branch as "idempotent match, given
// both are active."
// The authorizer's policy cache means a freshly minted key can
// take up to a few minutes to start authorizing — surface that in the
// confirmation step where it matters.
// ---------------------------------------------------------------------------

import { useEffect, useId, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  FormControlLabel,
  FormHelperText,
  FormLabel,
  IconButton,
  InputLabel,
  MenuItem,
  Paper,
  Radio,
  RadioGroup,
  Select,
  Stack,
  Step,
  StepLabel,
  Stepper,
  Tab,
  Tabs,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { ApiErrorAlert, LoadingBlock, SubmitButton, extractErrorMessage } from '@vectros-ai/react';
import PersonIcon from '@mui/icons-material/Person';
import SmartToyIcon from '@mui/icons-material/SmartToy';
import AddIcon from '@mui/icons-material/Add';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import { FormattedMessage, useIntl } from 'react-intl';
import type { IntlShape } from 'react-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useActiveTenantId, useCurrentTenant } from '../../auth';

/** The env a new key is scoped to (drives the ssk_live_ vs ssk_test_ prefix). */
type KeyEnv = 'live' | 'test';
import { VectrosError, vectrosApiClient } from '../../api/vectrosApi';
import type {
  AccessProfileResponse,
  ScopedKeyResponse,
  UserResponse,
} from '../../api/vectrosApi';
import { useDeveloperApi } from '../../api/developerApi';
import type { AppContextSummary } from '../../api/developerApi';
import { drainPages, AUTH_PAGE_SIZE } from '../../lib/drainPages';
import { useNamespaceRegistry } from '../../lib/namespaceRegistry';
import { RESERVED_VECTROS_ADMIN_CONTEXT_ID } from '../../lib/reservedContexts';
import {
  ScopeEditor,
  emptyClause,
  formatScopeClauseValidationError,
  toWireScopeClauses,
  validateClauses,
} from '../../components/ScopeEditor';
import type { ScopeClause } from '../../components/ScopeEditor';

// ---------------------------------------------------------------------------
// Step model
// ---------------------------------------------------------------------------

const STEPS = ['basics', 'bind', 'context', 'review', 'confirmation'] as const;
type WizardStep = (typeof STEPS)[number];

const STEP_LABEL_KEY: Record<WizardStep, string> = {
  basics: 'keysWizard.step.basics',
  bind: 'keysWizard.step.bind',
  context: 'keysWizard.step.context',
  review: 'keysWizard.step.review',
  confirmation: 'keysWizard.step.confirmation',
};

// ---------------------------------------------------------------------------
// Validation — key name (mirrors the backend's key-name rule)
// ---------------------------------------------------------------------------

/**
 * Validate a candidate scoped-key name. Returns a `code` discriminant on
 * failure, null on success. Pair with `formatKeyNameError(code, intl)` to
 * surface the user-facing copy from the message catalog.
 *
 * Exported so the same contract is reusable across wizard variants /
 * partner forks customizing the BasicsStep UX.
 */
export type KeyNameErrorCode = 'required' | 'whitespace' | 'tooLong';

export function validateKeyName(name: string): KeyNameErrorCode | null {
  if (!name || name.trim() === '') return 'required';
  if (name !== name.trim()) return 'whitespace';
  if (name.length > 100) return 'tooLong';
  return null;
}

export function formatKeyNameError(code: KeyNameErrorCode, intl: IntlShape): string {
  switch (code) {
    case 'required':
      return intl.formatMessage({ id: 'keysWizard.basics.errorRequired' });
    case 'whitespace':
      return intl.formatMessage({ id: 'keysWizard.basics.errorWhitespace' });
    case 'tooLong':
      return intl.formatMessage({ id: 'keysWizard.basics.errorTooLong' });
  }
}

// ---------------------------------------------------------------------------
// The wizard used to gate "Next" on mere EXISTENCE of a bound user or access
// profile, so a suspended one looked identical to an active one all the way
// to the final step, where the create call's own refusal showed up as a
// generic error. These two predicates let each earlier step react
// immediately instead. This is a UX signal only — the server's own refusal
// remains authoritative if either check here is ever wrong or stale.
// ---------------------------------------------------------------------------

/** Case-insensitive to match how the create endpoint itself reads this
 *  field: undefined/null (a legacy row, or a shape the wire type doesn't
 *  guarantee), ACTIVE, and PENDING (an outstanding invitation) are all fine
 *  to bind; only SUSPENDED blocks. */
export function isUserStatusMintable(status: string | null | undefined): boolean {
  return status == null || status.toUpperCase() === 'ACTIVE' || status.toUpperCase() === 'PENDING';
}

/** The access-profile allow-list is narrower and case-sensitive: only the
 *  literal lowercase `active` resolves — null or any other value, including
 *  a differently-cased spelling, is treated as not usable. */
export function isProfileStatusMintable(status: string | null | undefined): boolean {
  return status === 'active';
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface ScopedKeyCreateDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** Called once the create call returns. Receives the SDK response so the
   *  parent can surface keyId / refresh the list / etc. */
  readonly onSuccess?: (response: ScopedKeyResponse) => void;
  /** Preselects the env radio. Callers typically pass useCurrentTenant().tenant. */
  readonly initialEnv?: KeyEnv;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ScopedKeyCreateDialog({
  open,
  onClose,
  onSuccess,
  initialEnv = 'live',
}: ScopedKeyCreateDialogProps): React.JSX.Element {
  const intl = useIntl();
  const activeTenant = useActiveTenantId();
  const { memberships } = useCurrentTenant();
  const titleId = useId();

  // Wizard state.
  const [step, setStep] = useState<WizardStep>('basics');
  const [keyName, setKeyName] = useState('');
  const [env, setEnv] = useState<KeyEnv>(initialEnv);
  const [boundUser, setBoundUser] = useState<UserResponse | null>(null);
  const [contextId, setContextId] = useState('');
  // ContextStep bubbles up profile-existence via onProfileResolved so the
  // wizard's canAdvance gate can read it without re-querying. Resets to
  // false on context change so a stale "true" from a previous selection
  // can't allow advance prematurely.
  const [profileExists, setProfileExists] = useState(false);
  // SEPARATE from profileExists: a profile can exist and still not be usable
  // (suspended). Existence alone used to be the whole gate, which was the
  // bug — a suspended profile rendered a green "exists" check
  // and Next stayed enabled. See ContextStep's onProfileResolved call site.
  const [profileMintable, setProfileMintable] = useState(false);
  // Result of the createScopedKey call. ConfirmationStep distinguishes
  // by `result.rawKey != null` — fresh creates carry the raw secret
  // (shown ONCE), idempotent matches don't.
  const [result, setResult] = useState<ScopedKeyResponse | null>(null);

  // The tenant the whole wizard operates in — resolved from the selected env
  // radio (not the active TenantSwitcher), so the context list, the profile
  // check/create, and the key mint all target the SAME tenant. Falls back to the
  // active tenant if the env's membership isn't found (shouldn't happen).
  const targetTenantId = useMemo(
    () => memberships.find((m) => m.tenantKind === env)?.tenantId ?? activeTenant,
    [memberships, env, activeTenant],
  );

  const queryClient = useQueryClient();

  // The actual create-key mutation. Triggered from handleNext on the
  // 'review' step. On success: stashes the response + transitions to
  // 'confirmation' + invalidates the parent's scoped-keys list query
  // (so KeysPage refetches if the wizard's parent is the keys page —
  // wired in a later step).
  const submitMutation = useMutation({
    mutationFn: () => {
      // Per-context bearer in the env-selected tenant (see targetTenantId): the
      // key binds to the chosen (tenant, context).
      return vectrosApiClient(targetTenantId, contextId).auth.createScopedKey({
        keyName: keyName.trim(),
        tenantId: targetTenantId,
        contextId,
        userId: boundUser?.id ?? '',
      });
    },
    onSuccess: (response: ScopedKeyResponse) => {
      setResult(response);
      setStep('confirmation');
      void queryClient.invalidateQueries({ queryKey: ['scopedKeys'] });
      onSuccess?.(response);
    },
    // onError intentionally omitted — the create failure stays on
    // submitMutation.error and renders via <ApiErrorAlert> on the review
    // step (the deferred onSuccess transition keeps us there).
  });

  // Reset wizard state when the dialog (re-)opens — typical UX is "open,
  // start fresh." Reusing an open dialog is rare and intentional.
  useEffect(() => {
    if (open) {
      setStep('basics');
      setKeyName('');
      setEnv(initialEnv);
      setBoundUser(null);
      setContextId('');
      setProfileExists(false);
      setProfileMintable(false);
      setResult(null);
      submitMutation.reset();
    }
    // submitMutation.reset is stable; intentionally omitted from deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialEnv]);

  const nameErrorCode = validateKeyName(keyName);
  // Only render the inline error after the user has typed something —
  // empty-on-open shouldn't render as red.
  const showNameError = nameErrorCode !== null && keyName !== '';
  const nameErrorMessage = showNameError && nameErrorCode
    ? formatKeyNameError(nameErrorCode, intl)
    : null;

  const stepIndex = STEPS.indexOf(step);
  const isReview = step === 'review';
  const isConfirmation = step === 'confirmation';

  const canAdvance = ((): boolean => {
    switch (step) {
      case 'basics':
        return nameErrorCode === null && env != null;
      case 'bind':
        return boundUser !== null && isUserStatusMintable(boundUser.status);
      case 'context':
        return contextId !== '' && profileExists && profileMintable;
      case 'review':
        return !submitMutation.isPending;
      case 'confirmation':
        return false;
    }
  })();

  const handleNext = (): void => {
    if (isReview) {
      // mutate() clears any prior error before re-firing; the step transition
      // is deferred to the mutation's onSuccess so a failure stays on the
      // review step with the inline error visible.
      submitMutation.mutate();
      return;
    }
    const next = STEPS[stepIndex + 1];
    if (next) setStep(next);
  };

  const handleBack = (): void => {
    const prev = STEPS[stepIndex - 1];
    if (prev) setStep(prev);
  };

  const handleClose = (): void => {
    if (submitMutation.isPending) return;
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      maxWidth="md"
      fullWidth
      aria-labelledby={titleId}
    >
      <DialogTitle id={titleId} sx={{ fontWeight: 700 }}>
        <FormattedMessage id="keysWizard.title" />
      </DialogTitle>
      <DialogContent>
        <Stepper activeStep={stepIndex} sx={{ mb: 4, mt: 1 }}>
          {STEPS.map((s) => (
            <Step key={s}>
              <StepLabel>
                <FormattedMessage id={STEP_LABEL_KEY[s]} />
              </StepLabel>
            </Step>
          ))}
        </Stepper>

        {step === 'basics' && (
          <BasicsStep
            keyName={keyName}
            setKeyName={setKeyName}
            env={env}
            setEnv={setEnv}
            nameErrorMessage={nameErrorMessage}
          />
        )}
        {step === 'bind' && (
          <BindStep boundUser={boundUser} onPickUser={setBoundUser} />
        )}
        {step === 'context' && boundUser?.id && (
          <ContextStep
            contextId={contextId}
            setContextId={setContextId}
            principalId={`usr_${boundUser.id}`}
            env={env}
            tenantId={targetTenantId}
            onProfileResolved={setProfileExists}
            onProfileMintableResolved={setProfileMintable}
          />
        )}
        {step === 'review' && (
          <ReviewStep
            keyName={keyName}
            env={env}
            user={boundUser}
            contextId={contextId}
          />
        )}
        {step === 'confirmation' && <ConfirmationStep result={result} />}

        {submitMutation.isError && step !== 'confirmation' && (
          <Box sx={{ mt: 2 }}>
            <ApiErrorAlert error={submitMutation.error}>
              <FormattedMessage id="keysWizard.review.submitError" />
              {/* The server's message is the actionable part here, and the set
                  of things it can say keeps growing: 0.40.0's 403 when minting
                  bound to a different principal without the delegate-mint
                  capability; the uniform 404 that no longer distinguishes "user
                  doesn't exist" from "no profile in this context"; and, since
                  0.43.0, two 409s — the bound access profile is suspended, or
                  the bound user is. Each names the offending profile or user,
                  and the remedy differs per case (reactivate vs. pick someone
                  else), which is exactly why this surfaces the server's own
                  text rather than mapping status codes to fixed copy. Note the
                  409s are deliberately NOT 403s: a 403 here means YOUR
                  credential is insufficient, so the "re-issue a broader
                  credential" remedy would be wrong for them. */}
              {extractErrorMessage(submitMutation.error) && (
                <Typography variant="caption" component="p" sx={{ mt: 0.5, opacity: 0.85 }}>
                  {extractErrorMessage(submitMutation.error)}
                </Typography>
              )}
            </ApiErrorAlert>
          </Box>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        {isConfirmation ? (
          <Button onClick={handleClose} variant="contained">
            <FormattedMessage id="keysWizard.done" />
          </Button>
        ) : (
          <>
            <Button onClick={handleClose} disabled={submitMutation.isPending}>
              <FormattedMessage id="keysWizard.cancel" />
            </Button>
            <Button onClick={handleBack} disabled={stepIndex === 0 || submitMutation.isPending}>
              <FormattedMessage id="keysWizard.back" />
            </Button>
            <SubmitButton
              onClick={handleNext}
              variant="contained"
              disabled={!canAdvance}
              pending={isReview && submitMutation.isPending}
            >
              <FormattedMessage id={isReview ? 'keysWizard.create' : 'keysWizard.next'} />
            </SubmitButton>
          </>
        )}
      </DialogActions>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Step 1: Basics — keyName + env
// ---------------------------------------------------------------------------

interface BasicsStepProps {
  readonly keyName: string;
  readonly setKeyName: (v: string) => void;
  readonly env: KeyEnv;
  readonly setEnv: (v: KeyEnv) => void;
  readonly nameErrorMessage: string | null;
}

function BasicsStep({
  keyName,
  setKeyName,
  env,
  setEnv,
  nameErrorMessage,
}: BasicsStepProps): React.JSX.Element {
  const intl = useIntl();
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <TextField
        label={intl.formatMessage({ id: 'keysWizard.basics.keyNameLabel' })}
        placeholder={intl.formatMessage({ id: 'keysWizard.basics.keyNamePlaceholder' })}
        value={keyName}
        onChange={(ev) => setKeyName(ev.target.value)}
        fullWidth
        // eslint-disable-next-line jsx-a11y/no-autofocus
        autoFocus
        error={nameErrorMessage !== null}
        helperText={
          nameErrorMessage ??
          intl.formatMessage(
            { id: 'keysWizard.basics.keyNameHelperCount' },
            { count: keyName.length },
          )
        }
      />
      <FormControl>
        <FormLabel id="keysWizard-env-label">
          <FormattedMessage id="keysWizard.basics.envLabel" />
        </FormLabel>
        <RadioGroup
          row
          aria-labelledby="keysWizard-env-label"
          value={env}
          onChange={(ev) => setEnv(ev.target.value as KeyEnv)}
        >
          <FormControlLabel
            value="live"
            control={<Radio />}
            label={intl.formatMessage({ id: 'keysWizard.basics.envLive' })}
          />
          <FormControlLabel
            value="test"
            control={<Radio />}
            label={intl.formatMessage({ id: 'keysWizard.basics.envTest' })}
          />
        </RadioGroup>
        <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5 }}>
          <FormattedMessage id="keysWizard.basics.envCaption" values={{ env }} />
        </Typography>
      </FormControl>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Step 2: Bind — Humans / Services tabbed user picker.
//
// Lists PartnerUsers for the current tenant via TanStack Query, splits by
// type (HUMAN default for legacy rows w/o the field), and lets the user
// click a row to bind. The Services tab gains a "Create service principal"
// button that opens an inline ServicePrincipalCreateDialog — uses
// `identity.createUser({ externalId, type: 'SERVICE' })` (the dev-portal's
// createServicePrincipal helper inlined; the SDK shape is the same call).
// ---------------------------------------------------------------------------

type UserTypeFilter = 'HUMAN' | 'SERVICE';

interface BindStepProps {
  readonly boundUser: UserResponse | null;
  readonly onPickUser: (user: UserResponse) => void;
}

function BindStep({ boundUser, onPickUser }: BindStepProps): React.JSX.Element {
  const intl = useIntl();
  const tenant = useActiveTenantId();
  const [activeTab, setActiveTab] = useState<UserTypeFilter>(
    boundUser?.type === 'SERVICE' ? 'SERVICE' : 'HUMAN',
  );
  const [createOpen, setCreateOpen] = useState(false);

  // Principals created THIS wizard session via "Create service principal"
  // below. Held in local state, deliberately NEVER written into the
  // ['users', tenant] query cache — see onCreated's own comment for why an
  // earlier version of this fix (writing straight into the cache) was
  // itself a real regression, not just a race.
  const [optimisticPrincipals, setOptimisticPrincipals] = useState<UserResponse[]>([]);

  const usersQuery = useQuery({
    queryKey: ['users', tenant],
    // identity.listUsers is cursor-paginated (SDK 0.23, default 20/page); drain
    // so the user picker lists every member, not just the first page.
    queryFn: () =>
      drainPages<UserResponse>((startFrom) =>
        vectrosApiClient(tenant).identity.listUsers(
          startFrom === undefined
            ? { limit: AUTH_PAGE_SIZE }
            : { startFrom, limit: AUTH_PAGE_SIZE },
        ),
      ),
  });

  // The rendered list is the server's answer UNIONED with this session's own
  // optimistic creates — never a cache write, so it can't be reverted or
  // overwritten by anything react-query does to the query underneath it
  // (a cancel, a refetch, a window-refocus refetch, a stale resolution — see
  // onCreated). A created principal is deduped out once the server itself
  // starts returning it (were that ever to happen — today it structurally
  // never will, since the confined list this query backs never returns a
  // profile-less principal; see the module comment on `listConfinedUsers`
  // on the backend for why), rather than assuming it never will.
  const users = useMemo(() => {
    const serverUsers = usersQuery.data ?? [];
    const serverIds = new Set(serverUsers.map((u) => u.id).filter(Boolean));
    const extra = optimisticPrincipals.filter((p) => !p.id || !serverIds.has(p.id));
    return [...serverUsers, ...extra];
  }, [usersQuery.data, optimisticPrincipals]);

  // The backend user record's type defaults to HUMAN for legacy rows (default-on-read
  // in the model). Filter client-side; the API doesn't accept a `type`
  // query param today.
  const filtered = useMemo(
    () => users.filter((u) => (u.type ?? 'HUMAN') === activeTab),
    [users, activeTab],
  );
  // The server fetch may still be pending, but once we have at least one
  // optimistic principal there's something real to show — don't block the
  // whole picker behind a fetch this step no longer depends on for that row.
  const isPending = usersQuery.isPending && optimisticPrincipals.length === 0;

  return (
    <Box>
      {/* 0.40.0: minting a key bound to someone OTHER than yourself now requires
          the delegate-mint capability. Said up front, not just at the final
          403 — five steps in is the wrong place to first learn a pick you
          made on step 2 can't complete. */}
      <Alert severity="info" sx={{ mb: 2 }}>
        <FormattedMessage id="keysWizard.bind.delegateMintNotice" />
      </Alert>
      {/* The picker used to render nothing at all for a suspended user
          (id/email/externalId only), so picking one and hitting Next five steps
          later was the first the caller learned about it. Named here, at the
          point of selection, with the reactivation remedy. */}
      {boundUser !== null && !isUserStatusMintable(boundUser.status) && (
        <Alert severity="warning" sx={{ mb: 2 }} role="status">
          <Typography variant="body2" sx={{ fontWeight: 600, mb: 0.5 }}>
            <FormattedMessage id="keysWizard.bind.userSuspended" />
          </Typography>
          <Typography variant="caption" color="text.secondary">
            <FormattedMessage
              id="keysWizard.bind.userSuspendedDetail"
              values={{ userId: boundUser.id ?? '' }}
            />
          </Typography>
        </Alert>
      )}
      <Tabs
        value={activeTab}
        onChange={(_evt, v: UserTypeFilter) => setActiveTab(v)}
        sx={{ mb: 2, '& .MuiTab-root': { textTransform: 'none' } }}
        aria-label={intl.formatMessage({ id: 'keysWizard.step.bind' })}
      >
        <Tab
          icon={<PersonIcon />}
          iconPosition="start"
          label={intl.formatMessage({ id: 'keysWizard.bind.tabHumans' })}
          value="HUMAN"
        />
        <Tab
          icon={<SmartToyIcon />}
          iconPosition="start"
          label={intl.formatMessage({ id: 'keysWizard.bind.tabServices' })}
          value="SERVICE"
        />
      </Tabs>

      {activeTab === 'SERVICE' && (
        <Box sx={{ mb: 2 }}>
          <Button
            size="small"
            startIcon={<AddIcon />}
            onClick={() => setCreateOpen(true)}
            sx={{ textTransform: 'none' }}
          >
            <FormattedMessage id="keysWizard.bind.createService" />
          </Button>
        </Box>
      )}

      {usersQuery.isError && (
        <Box sx={{ mb: 2 }}>
          <ApiErrorAlert error={usersQuery.error}>
            <FormattedMessage
              id="keysWizard.bind.loadError"
              values={{
                message:
                  usersQuery.error instanceof Error
                    ? usersQuery.error.message
                    : String(usersQuery.error),
              }}
            />
          </ApiErrorAlert>
        </Box>
      )}

      {isPending && (
        <LoadingBlock
          size={24}
          py={3}
          label={intl.formatMessage({ id: 'keysWizard.bind.loading' })}
        />
      )}

      {!isPending && !usersQuery.isError && filtered.length === 0 && (
        <Typography
          variant="body2"
          color="text.secondary"
          sx={{ p: 3, textAlign: 'center' }}
        >
          <FormattedMessage
            id={
              activeTab === 'HUMAN'
                ? 'keysWizard.bind.emptyHumans'
                : 'keysWizard.bind.emptyServices'
            }
          />
        </Typography>
      )}

      {!isPending && filtered.length > 0 && (
        <Box
          sx={{
            maxHeight: 300,
            overflow: 'auto',
            border: '1px solid',
            borderColor: 'divider',
            borderRadius: 1,
          }}
          role="listbox"
          aria-label={intl.formatMessage({ id: 'keysWizard.step.bind' })}
        >
          {filtered.map((u) => {
            const selected = boundUser?.id === u.id;
            return (
              <Box
                key={u.id ?? u.externalId ?? u.email}
                role="option"
                aria-selected={selected}
                onClick={() => onPickUser(u)}
                onKeyDown={(ev) => {
                  if (ev.key === 'Enter' || ev.key === ' ') {
                    ev.preventDefault();
                    onPickUser(u);
                  }
                }}
                tabIndex={0}
                sx={{
                  p: 2,
                  borderBottom: '1px solid',
                  borderColor: 'divider',
                  cursor: 'pointer',
                  bgcolor: selected ? 'action.selected' : 'transparent',
                  '&:last-of-type': { borderBottom: 'none' },
                  '&:hover': { bgcolor: 'action.hover' },
                  '&:focus-visible': {
                    outline: '2px solid',
                    outlineColor: 'primary.main',
                    outlineOffset: -2,
                  },
                }}
              >
                <Stack direction="row" spacing={1} alignItems="center">
                  <Typography
                    variant="body2"
                    sx={{ fontFamily: 'monospace', fontSize: 12, color: 'text.secondary' }}
                  >
                    {u.id}
                  </Typography>
                  {/* Surfaced at the picker, not just after selection. */}
                  {!isUserStatusMintable(u.status) && (
                    <Chip
                      size="small"
                      color="warning"
                      label={<FormattedMessage id="keysWizard.bind.rowSuspendedChip" />}
                      sx={{ fontSize: 10, height: 18, fontWeight: 600 }}
                    />
                  )}
                </Stack>
                <Stack direction="row" spacing={2} sx={{ mt: 0.5 }}>
                  {u.email && (
                    <Typography variant="caption" color="text.secondary">
                      {u.email}
                    </Typography>
                  )}
                  {u.externalId && (
                    <Typography variant="caption" color="text.secondary">
                      <FormattedMessage id="keysWizard.bind.rowExternalIdLabel" />{' '}
                      <code>{u.externalId}</code>
                    </Typography>
                  )}
                </Stack>
              </Box>
            );
          })}
        </Box>
      )}

      <ServicePrincipalCreateDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(newUser) => {
          // A freshly-created principal holds no access profile in this
          // context yet, so the confined-caller list query this list is
          // backed by will never return it — not on this fetch, not on the
          // NEXT one, not ever, until it's granted a profile. That ruled out
          // both an invalidate+refetch (asks a membership-scoped query a
          // does-this-exist question it structurally can't answer) AND an
          // earlier version of this fix that wrote the row straight into the
          // query cache: that stopped the immediate symptom but broke a
          // DIFFERENT way — cancelling the tenant's only (still-loading)
          // fetch to protect the write also discarded every REAL existing
          // user that fetch would have returned, so the picker showed only
          // the just-created principal until something else refetched.
          // Track it in local state instead, unioned into the rendered list
          // (see `users` above) — the real query is free to load, refetch,
          // get cancelled, whatever react-query wants; this row is immune to
          // all of it because it never lived in that cache to begin with.
          setOptimisticPrincipals((prev) => [...prev, newUser]);
          setCreateOpen(false);
          setActiveTab('SERVICE');
          onPickUser(newUser);
        }}
      />
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Inline service-principal create — opens from BindStep's Services tab.
// Submits identity.createUser({externalId, type: 'SERVICE'}) and hands the
// new row to the parent's onCreated on success (see that handler's own
// comment for why it's tracked in local state, not the query cache) so the
// new row appears AND becomes the selected boundUser without a
// wizard step back.
// ---------------------------------------------------------------------------

interface ServicePrincipalCreateDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onCreated: (newUser: UserResponse) => void;
}

function ServicePrincipalCreateDialog({
  open,
  onClose,
  onCreated,
}: ServicePrincipalCreateDialogProps): React.JSX.Element {
  const intl = useIntl();
  const tenant = useActiveTenantId();
  const [externalId, setExternalId] = useState('');

  const createMutation = useMutation({
    mutationFn: (vars: { externalId: string }) =>
      vectrosApiClient(tenant).identity.createUser({
        body: {
          externalId: vars.externalId,
          type: 'SERVICE',
        },
      }),
    onSuccess: (newUser) => {
      onCreated(newUser);
    },
    // onError omitted — the error stays on createMutation.error so the
    // render path can branch on the 409 externalId-collision DOMAIN case
    // and surface the requestId via <ApiErrorAlert> otherwise.
  });

  // mutate() clears the prior error before re-firing, so resetting on open
  // only needs to clear the input + drop any stale mutation state.
  useEffect(() => {
    if (open) {
      setExternalId('');
      createMutation.reset();
    }
    // createMutation.reset is stable; intentionally omitted from deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const trimmed = externalId.trim();
  const canSubmit = trimmed !== '' && !createMutation.isPending;

  const handleClose = (): void => {
    if (createMutation.isPending) return;
    onClose();
  };

  const handleSubmit = (): void => {
    if (!canSubmit) return;
    createMutation.mutate({ externalId: trimmed });
  };

  // A 409 on createUser means the externalId is already taken in this tenant —
  // a DOMAIN conflict, not a generic failure (mirrors InviteMemberDialog's
  // email-already-associated handling). Surface a specific, actionable message.
  const isExternalIdConflict =
    createMutation.error instanceof VectrosError &&
    createMutation.error.statusCode === 409;

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="xs" fullWidth>
      <DialogTitle sx={{ fontWeight: 700 }}>
        <FormattedMessage id="keysWizard.servicePrincipal.title" />
      </DialogTitle>
      <DialogContent>
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ display: 'block', mb: 2 }}
        >
          <FormattedMessage id="keysWizard.servicePrincipal.subtitle" />
        </Typography>
        <TextField
          label={intl.formatMessage({ id: 'keysWizard.servicePrincipal.externalIdLabel' })}
          placeholder={intl.formatMessage({ id: 'keysWizard.servicePrincipal.externalIdPlaceholder' })}
          helperText={intl.formatMessage({ id: 'keysWizard.servicePrincipal.externalIdHelper' })}
          fullWidth
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          value={externalId}
          onChange={(ev) => setExternalId(ev.target.value)}
          disabled={createMutation.isPending}
        />
        {createMutation.isError && (
          <Box sx={{ mt: 2 }}>
            <ApiErrorAlert error={createMutation.error}>
              {isExternalIdConflict ? (
                <FormattedMessage
                  id="keysWizard.servicePrincipal.errorExternalIdExists"
                  values={{ externalId: trimmed }}
                />
              ) : (
                <FormattedMessage
                  id="keysWizard.servicePrincipal.createError"
                  values={{
                    message:
                      createMutation.error instanceof Error
                        ? createMutation.error.message
                        : String(createMutation.error),
                  }}
                />
              )}
            </ApiErrorAlert>
          </Box>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={handleClose} disabled={createMutation.isPending}>
          <FormattedMessage id="keysWizard.servicePrincipal.cancel" />
        </Button>
        <SubmitButton
          onClick={handleSubmit}
          variant="contained"
          disabled={!canSubmit}
          pending={createMutation.isPending}
        >
          <FormattedMessage
            id={
              createMutation.isPending
                ? 'keysWizard.servicePrincipal.creating'
                : 'keysWizard.servicePrincipal.create'
            }
          />
        </SubmitButton>
      </DialogActions>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Step 3: Context — AppContext picker + AccessProfile existence check.
//
// Backend contract: createScopedKey requires a pre-existing AccessProfile
// for (tenantId, contextId, usr_<userId>). The handoff doc calls this out
// as "two round-trips per create" — we surface the inline-create UX in
// this step so a partner picking a context that has no profile yet doesn't
// have to leave the wizard.
//
// Profile existence is checked by attempting `getAccessProfile`. A 404
// resolves the query to `null` (the profile doesn't exist for this pair);
// any other error bubbles through React Query's `isError` so the partner
// gets a real error instead of a silent failed-precondition state.
// ---------------------------------------------------------------------------

interface ContextStepProps {
  readonly contextId: string;
  readonly setContextId: (id: string) => void;
  readonly principalId: string;
  /** The env the wizard is minting in — drives the tenant for every call here. */
  readonly env: KeyEnv;
  /** The resolved tenant id for {@link env}; the context + profile calls use it. */
  readonly tenantId: string;
  /** Bubbles profile-existence up to the parent wizard's canAdvance gate. */
  readonly onProfileResolved: (exists: boolean) => void;
  /** Bubbles profile USABILITY (exists AND active) separately from mere
   *  existence — see this file's isProfileStatusMintable. */
  readonly onProfileMintableResolved: (mintable: boolean) => void;
}

function ContextStep({
  contextId,
  setContextId,
  principalId,
  env,
  tenantId,
  onProfileResolved,
  onProfileMintableResolved,
}: ContextStepProps): React.JSX.Element {
  const intl = useIntl();
  // The whole step operates in the env-selected tenant, so the enumerated
  // contexts, the profile probe, and the key mint can't target different tenants.
  const devApi = useDeveloperApi(env);
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);

  // The account's data contexts — from the owner-gated Developer API, the only
  // surface that can enumerate every context (a context-pinned bearer sees just
  // its own). Keys are bound to a data context, so this is the picker's source.
  const contextsQuery = useQuery({
    queryKey: ['appContexts', tenantId],
    queryFn: () =>
      drainPages<AppContextSummary>((startFrom) =>
        devApi.listAppContexts(startFrom, AUTH_PAGE_SIZE),
      ),
    // A scoped key needs a data context to bind to; the reserved control-plane
    // context is non-data-bearing and the partner API now rejects an explicit
    // mint (and any access-profile read/write) pinned to it outright — never a
    // meaningful pick here, so it's dropped before the picker ever sees it.
    select: (contexts) => contexts.filter((c) => c.contextId !== RESERVED_VECTROS_ADMIN_CONTEXT_ID),
  });

  // Profile-existence probe. Fires only when both contextId AND principalId
  // are set. 404 → resolved-to-null (profile doesn't exist); anything else
  // bubbles to isError so the partner sees the failure rather than a
  // silent "Create profile" stuck state.
  const profileQuery = useQuery({
    queryKey: ['accessProfile', tenantId, contextId, principalId],
    queryFn: async (): Promise<AccessProfileResponse | null> => {
      try {
        // Per-context bearer in the env tenant: the profile lives inside the
        // picked context, so the read is issued with a credential minted for it.
        return await vectrosApiClient(tenantId, contextId).auth.getAccessProfile({
          contextId,
          principalId,
        });
      } catch (err) {
        if (err instanceof VectrosError && err.statusCode === 404) {
          return null;
        }
        throw err;
      }
    },
    enabled: contextId !== '' && principalId !== '',
  });

  // Bubble profile state up. `data != null` means the profile resolved
  // to a real row (not the 404 → null path); pending + error states
  // keep the parent at profileExists=false so Next stays disabled.
  //
  // Mintable is a SEPARATE signal from existence: a suspended profile
  // exists (so the "Create profile" prompt correctly stays hidden) but must
  // not let Next advance. Splitting these is what closes the bug — before
  // this fix "exists" was the whole gate.
  useEffect(() => {
    const exists = profileQuery.isSuccess && profileQuery.data != null;
    onProfileResolved(exists);
    onProfileMintableResolved(exists && isProfileStatusMintable(profileQuery.data?.status));
  }, [profileQuery.isSuccess, profileQuery.data, onProfileResolved, onProfileMintableResolved]);

  return (
    <Stack spacing={3}>
      <FormControl fullWidth>
        <InputLabel id="keysWizard-context-label">
          <FormattedMessage id="keysWizard.context.contextLabel" />
        </InputLabel>
        <Select
          labelId="keysWizard-context-label"
          label={intl.formatMessage({ id: 'keysWizard.context.contextLabel' })}
          value={contextId}
          onChange={(ev) => setContextId(String(ev.target.value))}
          disabled={contextsQuery.isPending || contextsQuery.isError}
        >
          {contextsQuery.isPending && (
            <MenuItem value="" disabled>
              <FormattedMessage id="keysWizard.context.loading" />
            </MenuItem>
          )}
          {contextsQuery.isSuccess && (contextsQuery.data ?? []).length === 0 && (
            <MenuItem value="" disabled>
              <FormattedMessage id="keysWizard.context.empty" />
            </MenuItem>
          )}
          {(contextsQuery.data ?? []).map((c: AppContextSummary) =>
            c.contextId ? (
              <MenuItem key={c.contextId} value={c.contextId}>
                {c.name ? `${c.contextId} — ${c.name}` : c.contextId}
              </MenuItem>
            ) : null,
          )}
        </Select>
        <FormHelperText>
          {contextsQuery.isError ? (
            <FormattedMessage
              id="keysWizard.context.loadError"
              values={{
                message:
                  contextsQuery.error instanceof VectrosError
                    ? contextsQuery.error.message
                    : String(contextsQuery.error),
              }}
            />
          ) : (
            <FormattedMessage id="keysWizard.context.contextHelper" />
          )}
        </FormHelperText>
      </FormControl>

      {contextId !== '' && (
        <Box>
          {profileQuery.isPending && (
            <Stack direction="row" spacing={1} alignItems="center">
              <CircularProgress
                size={16}
                aria-label={intl.formatMessage({ id: 'keysWizard.context.profileChecking' })}
              />
              <Typography variant="body2">
                <FormattedMessage id="keysWizard.context.profileChecking" />
              </Typography>
            </Stack>
          )}

          {profileQuery.isError && (
            <ApiErrorAlert error={profileQuery.error}>
              <FormattedMessage
                id="keysWizard.context.profileLoadError"
                values={{
                  message:
                    profileQuery.error instanceof Error
                      ? profileQuery.error.message
                      : String(profileQuery.error),
                }}
              />
            </ApiErrorAlert>
          )}

          {profileQuery.isSuccess && profileQuery.data != null && (
            // A profile that EXISTS but is not ACTIVE must not render as
            // the same green "all good" card: before this fix a suspended profile
            // rendered success + a real CheckCircleIcon, with "status: suspended"
            // sitting right beside it, and Next stayed enabled regardless.
            <Alert
              severity={isProfileStatusMintable(profileQuery.data.status) ? 'success' : 'warning'}
              role="status"
            >
              <Typography
                variant="body2"
                sx={{ fontWeight: 600, mb: 0.5, display: 'flex', alignItems: 'center', gap: 0.5 }}
              >
                {isProfileStatusMintable(profileQuery.data.status) ? (
                  <>
                    <CheckCircleIcon fontSize="small" color="success" aria-hidden />
                    <FormattedMessage id="keysWizard.context.profileExists" />
                  </>
                ) : (
                  <FormattedMessage id="keysWizard.context.profileSuspended" />
                )}
              </Typography>
              {!isProfileStatusMintable(profileQuery.data.status) && (
                <Typography variant="caption" color="text.secondary" component="p" sx={{ mb: 1 }}>
                  <FormattedMessage
                    id="keysWizard.context.profileSuspendedDetail"
                    values={{ contextId, principalId }}
                  />
                </Typography>
              )}
              <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap' }}>
                {profileQuery.data.status && (
                  <Typography variant="caption" color="text.secondary">
                    <FormattedMessage
                      id="keysWizard.context.profileExistsDetailStatus"
                      values={{ status: profileQuery.data.status }}
                    />
                  </Typography>
                )}
                {profileQuery.data.roleId && (
                  <Typography variant="caption" color="text.secondary">
                    <FormattedMessage
                      id="keysWizard.context.profileExistsDetailRole"
                      values={{ roleId: profileQuery.data.roleId }}
                    />
                  </Typography>
                )}
                {/* roleId is absent for a 2+-role composition (roleIds-only,
                    0.41.0) — without this the existing-profile summary
                    silently omitted role info entirely for that shape
                    (scopes is also absent, so neither detail chip rendered). */}
                {!profileQuery.data.roleId &&
                  profileQuery.data.roleIds &&
                  profileQuery.data.roleIds.length > 0 && (
                    <Typography variant="caption" color="text.secondary">
                      <FormattedMessage
                        id="keysWizard.context.profileExistsDetailMultiRole"
                        values={{
                          count: profileQuery.data.roleIds.length,
                          roleIds: profileQuery.data.roleIds.join(', '),
                        }}
                      />
                    </Typography>
                  )}
                {profileQuery.data.scopes && profileQuery.data.scopes.length > 0 && (
                  <Typography variant="caption" color="text.secondary">
                    <FormattedMessage
                      id="keysWizard.context.profileExistsDetailScopes"
                      values={{ count: profileQuery.data.scopes.length }}
                    />
                  </Typography>
                )}
              </Stack>
            </Alert>
          )}

          {profileQuery.isSuccess && profileQuery.data === null && (
            <Alert
              severity="warning"
              role="status"
              action={
                <Button
                  size="small"
                  onClick={() => setCreateOpen(true)}
                  sx={{ textTransform: 'none' }}
                >
                  <FormattedMessage id="keysWizard.context.createProfile" />
                </Button>
              }
            >
              <Typography variant="body2" sx={{ fontWeight: 600, mb: 0.5 }}>
                <FormattedMessage id="keysWizard.context.profileMissing" />
              </Typography>
              <Typography variant="caption" color="text.secondary">
                <FormattedMessage id="keysWizard.context.profileMissingDetail" />
              </Typography>
            </Alert>
          )}
        </Box>
      )}

      <InlineProfileCreateDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        tenantId={tenantId}
        contextId={contextId}
        principalId={principalId}
        onCreated={() => {
          // Refetch the existence check — its data flips from null to the
          // newly-created row, which triggers the useEffect above to set
          // profileExists=true in the parent → wizard's Next enables.
          void queryClient.invalidateQueries({
            queryKey: ['accessProfile', tenantId, contextId, principalId],
          });
          setCreateOpen(false);
        }}
      />
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// InlineProfileCreateDialog — embeds the <ScopeEditor> for clause-by-clause
// permission building, then POSTs `auth.createAccessProfile`.
//
// principalId is always `usr_<userId>` from ContextStep — scoped keys bind
// to a PartnerUser as the principal, never to a key-as-principal in this
// wizard (key-as-principal is reserved for the deprecated Pattern B that
// was dropped).
// ---------------------------------------------------------------------------

interface InlineProfileCreateDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly tenantId: string;
  readonly contextId: string;
  readonly principalId: string;
  readonly onCreated: () => void;
}

function InlineProfileCreateDialog({
  open,
  onClose,
  tenantId,
  contextId,
  principalId,
  onCreated,
}: InlineProfileCreateDialogProps): React.JSX.Element {
  const intl = useIntl();
  const [clauses, setClauses] = useState<ScopeClause[]>(() => [emptyClause()]);

  // Registered namespaces this context can see — suggests namespace names
  // in the ScopeEditor's data-scope field, same registry client the other
  // ScopeEditor consumers (RoleEditor, ProfileEditor) use. `tenantId` here is
  // the ENV-SELECTED tenant this dialog operates in (a prop, not necessarily
  // the app's globally active one) — pass it explicitly, or the registry
  // would fetch namespaces for the wrong tenant whenever they diverge.
  const {
    namespaces: registeredNamespaces,
    isLoading: namespacesLoading,
    isError: namespacesFailedToLoad,
  } = useNamespaceRegistry(contextId, tenantId);
  const namespaceSuggestions = useMemo(
    () => registeredNamespaces.map((ns) => ns.namespace),
    [registeredNamespaces],
  );
  // Only safe to flag a typed namespace "not registered" once the registry
  // has actually resolved — see RoleEditor.tsx/ProfileEditor.tsx's own copy
  // of this same gate.
  const canFlagUnregisteredNamespace = !namespacesLoading && !namespacesFailedToLoad;

  const validationError = validateClauses(clauses);
  const validationMessage = validationError
    ? formatScopeClauseValidationError(validationError, intl)
    : null;

  const createMutation = useMutation({
    mutationFn: () =>
      // Per-context bearer in the env tenant: the profile is created inside the
      // picked context.
      vectrosApiClient(tenantId, contextId).auth.createAccessProfile({
        contextId,
        body: {
          principalId,
          // Convert ScopeEditor's `readonly` shape to the SDK's mutable
          // shape at the boundary. ScopeEditor enforces immutability for
          // its consumers; the SDK type happens to be mutable. Empty
          // data_scope ({}) is shape-compatible with the SDK's nested
          // Record-of-Record type — v1 of ScopeEditor pins data_scope to
          // {} (no UI yet); the cast inside the helper aligns with that.
          scopes: toWireScopeClauses(clauses),
          status: 'active',
        },
      }),
    onSuccess: () => {
      onCreated();
    },
    // onError omitted — failure stays on createMutation.error and renders
    // via <ApiErrorAlert> in-dialog (surfacing the requestId).
  });

  // Reset on open — fresh clauses, no error; every reopening starts clean.
  useEffect(() => {
    if (open) {
      setClauses([emptyClause()]);
      createMutation.reset();
    }
    // createMutation.reset is stable; intentionally omitted from deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const handleClose = (): void => {
    if (createMutation.isPending) return;
    onClose();
  };

  const handleSubmit = (): void => {
    if (validationError) return;
    createMutation.mutate();
  };

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="md" fullWidth>
      <DialogTitle sx={{ fontWeight: 700 }}>
        <FormattedMessage id="keysWizard.inlineProfile.title" />
      </DialogTitle>
      <DialogContent>
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ display: 'block', mb: 2 }}
        >
          <FormattedMessage
            id="keysWizard.inlineProfile.subtitle"
            values={{
              principalId: <code>{principalId}</code>,
              contextId: <code>{contextId}</code>,
            }}
          />
        </Typography>
        <ScopeEditor
          value={clauses}
          onChange={setClauses}
          disabled={createMutation.isPending}
          namespaceOptions={namespaceSuggestions}
          canFlagUnregisteredNamespace={canFlagUnregisteredNamespace}
        />
        {createMutation.isError && (
          <Box sx={{ mt: 2 }}>
            <ApiErrorAlert error={createMutation.error}>
              <FormattedMessage
                id="keysWizard.inlineProfile.createError"
                values={{
                  message:
                    createMutation.error instanceof Error
                      ? createMutation.error.message
                      : String(createMutation.error),
                }}
              />
            </ApiErrorAlert>
          </Box>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={handleClose} disabled={createMutation.isPending}>
          <FormattedMessage id="keysWizard.inlineProfile.cancel" />
        </Button>
        <Tooltip title={validationMessage ?? ''}>
          <span>
            <SubmitButton
              onClick={handleSubmit}
              variant="contained"
              disabled={validationError !== null || createMutation.isPending}
              pending={createMutation.isPending}
            >
              <FormattedMessage
                id={
                  createMutation.isPending
                    ? 'keysWizard.inlineProfile.creating'
                    : 'keysWizard.inlineProfile.create'
                }
              />
            </SubmitButton>
          </span>
        </Tooltip>
      </DialogActions>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Step 4: Review — read-only summary before the actual create call.
//
// 4 rows matching the dev-portal layout: Key name, Environment (env +
// tenant ID), User (id + type chip), App context. The intro paragraph
// surfaces the "raw key is shown ONCE" expectation so partners aren't
// surprised on the confirmation step.
// ---------------------------------------------------------------------------

interface ReviewStepProps {
  readonly keyName: string;
  readonly env: KeyEnv;
  readonly user: UserResponse | null;
  readonly contextId: string;
}

function ReviewStep({ keyName, env, user, contextId }: ReviewStepProps): React.JSX.Element {
  const userType = user?.type === 'SERVICE' ? 'SERVICE' : 'HUMAN';
  return (
    <Stack spacing={2}>
      <Typography variant="body2" color="text.secondary">
        <FormattedMessage id="keysWizard.review.intro" />
      </Typography>
      <Paper variant="outlined" sx={{ p: 2 }}>
        <ReviewRow labelId="keysWizard.review.rowKeyName" value={keyName} />
        <ReviewRow
          labelId="keysWizard.review.rowEnv"
          value={
            <FormattedMessage
              id={env === 'test' ? 'keysWizard.review.envTest' : 'keysWizard.review.envLive'}
            />
          }
        />
        <ReviewRow
          labelId="keysWizard.review.rowUser"
          value={
            <Stack direction="row" spacing={1} alignItems="center">
              <Box component="span" sx={{ fontFamily: 'monospace', fontSize: 12 }}>
                {user?.id ?? ''}
              </Box>
              <Chip
                size="small"
                label={
                  <FormattedMessage
                    id={
                      userType === 'SERVICE'
                        ? 'keysWizard.review.userTypeService'
                        : 'keysWizard.review.userTypeHuman'
                    }
                  />
                }
                sx={{ fontSize: 10, height: 18, fontWeight: 600 }}
              />
            </Stack>
          }
        />
        <ReviewRow labelId="keysWizard.review.rowContext" value={contextId} />
      </Paper>
    </Stack>
  );
}

interface ReviewRowProps {
  readonly labelId: string;
  readonly value: React.ReactNode;
}

function ReviewRow({ labelId, value }: ReviewRowProps): React.JSX.Element {
  return (
    <Stack
      direction="row"
      justifyContent="space-between"
      alignItems="center"
      spacing={2}
      sx={{
        py: 1,
        '&:not(:last-of-type)': { borderBottom: '1px solid', borderColor: 'divider' },
      }}
    >
      <Typography variant="body2" color="text.secondary">
        <FormattedMessage id={labelId} />
      </Typography>
      <Box sx={{ textAlign: 'right', fontWeight: 500, fontSize: 14 }}>{value}</Box>
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// Step 5: Confirmation — show the rawKey ONCE (with copy button) on fresh
// creates, or an idempotent-match info card if the (partner, tenant,
// context, userId, keyName) tuple already mapped to an active key. The
// 5-min Rust authorizer cache window is surfaced here because it's the
// only place the partner sees the new key — anything sooner would be
// premature; anything later would be too late to act on.
// ---------------------------------------------------------------------------

interface ConfirmationStepProps {
  readonly result: ScopedKeyResponse | null;
}

function ConfirmationStep({ result }: ConfirmationStepProps): React.JSX.Element | null {
  const intl = useIntl();
  const [copied, setCopied] = useState(false);

  if (!result) return null;

  // Idempotent-match path — backend returns the existing key's metadata
  // without a rawKey. Tell the partner clearly that the raw value is not
  // re-disclosable; their only recovery option is revoke + recreate.
  if (!result.rawKey) {
    return (
      <Stack spacing={2}>
        <Alert severity="info" role="status">
          <Typography variant="body2" sx={{ fontWeight: 600, mb: 0.5 }}>
            <FormattedMessage id="keysWizard.confirmation.idempotentTitle" />
          </Typography>
          <Typography variant="caption">
            <FormattedMessage id="keysWizard.confirmation.idempotentDetail" />
          </Typography>
        </Alert>
        <Paper variant="outlined" sx={{ p: 2 }}>
          <ReviewRow
            labelId="keysWizard.confirmation.idempotentExistingKeyId"
            value={
              <Box component="span" sx={{ fontFamily: 'monospace', fontSize: 12 }}>
                {result.keyId ?? '—'}
              </Box>
            }
          />
          <ReviewRow
            labelId="keysWizard.confirmation.idempotentCreatedAt"
            value={result.createdAt ?? '—'}
          />
        </Paper>
      </Stack>
    );
  }

  // Fresh-create path — rawKey present, exactly-once display.
  const rawKey = result.rawKey;
  const handleCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(rawKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API may fail (insecure context, denied permission).
      // Leave `copied` false — the partner still sees the raw key inline.
    }
  };

  return (
    <Stack spacing={2}>
      <Alert severity="warning" role="status">
        <Typography variant="body2" sx={{ fontWeight: 600 }}>
          <FormattedMessage id="keysWizard.confirmation.copyOnce" />
        </Typography>
      </Alert>
      <Paper
        variant="outlined"
        sx={{
          p: 1.5,
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          bgcolor: 'background.default',
        }}
      >
        <Typography
          variant="body2"
          sx={{
            fontFamily: 'monospace',
            wordBreak: 'break-all',
            flexGrow: 1,
            fontSize: 13,
          }}
        >
          {rawKey}
        </Typography>
        <Tooltip
          title={
            copied
              ? intl.formatMessage({ id: 'keysWizard.confirmation.copied' })
              : intl.formatMessage({ id: 'keysWizard.confirmation.copy' })
          }
        >
          <IconButton
            onClick={() => void handleCopy()}
            aria-label={intl.formatMessage({ id: 'keysWizard.confirmation.copy' })}
          >
            <ContentCopyIcon />
          </IconButton>
        </Tooltip>
      </Paper>
      <Typography variant="caption" color="text.secondary">
        <FormattedMessage id="keysWizard.confirmation.cacheWarning" />
      </Typography>
    </Stack>
  );
}
