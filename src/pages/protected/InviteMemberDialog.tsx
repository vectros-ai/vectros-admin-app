// ---------------------------------------------------------------------------
// InviteMemberDialog — drives the partner-API `createInvite` flow.
//
// **UX decisions:**
//   - Email + Role dropdown upfront. Roles are loaded from
//     `client.auth.listRoles({ contextId: 'vectros-admin' })`.
//     Custom inline scopes are handled by the access-profile UI.
//   - "Advanced options" collapses the 4 partner-customizable knobs:
//     firstName / lastName / ttlDays / sendEmail / fromName / acceptUrl.
//     acceptUrl auto-fills from `window.location.origin + '/accept'`.
//   - On 409 with body `{ error: 'email_already_associated' }` (the
//     shared-Cognito-pool placeholder precheck), show an inline,
//     domain-specific error explaining the planned-feature limitation.
//     Other errors render a generic message.
//
// The dialog is auth-provider-agnostic + tenant-aware via
// `useCurrentTenant()` — switching the TenantSwitcher in AppLayout while
// this is open isn't a supported flow, but the SDK client used here is
// re-resolved per render so a change just routes the next request to the
// new tenant's VectrosClient.
// ---------------------------------------------------------------------------

import { useEffect, useId, useState } from 'react';
import type { FormEvent } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Collapse,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  FormControlLabel,
  FormHelperText,
  IconButton,
  InputLabel,
  Link,
  MenuItem,
  Select,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import { FormattedMessage, useIntl } from 'react-intl';
import { useMutation, useQuery } from '@tanstack/react-query';
import { SubmitButton } from '@vectros-ai/react';

import { useActiveTenantId } from '../../auth';
import { BRAND } from '../../brand';
import { VectrosError, vectrosApiClient } from '../../api/vectrosApi';
import type {
  CreateInviteRequest,
  CreateInviteResponse,
  RoleResponse,
} from '../../api/vectrosApi';
import { ApiErrorAlert } from '../../components/ApiErrorAlert';
import { drainPages, AUTH_PAGE_SIZE } from '../../lib/drainPages';

/** AppContext admin-app's members are bound to. Auto-seeded. */
const ADMIN_CONTEXT_ID = 'vectros-admin';

/** Backend default per the SDK comment. */
const DEFAULT_TTL_DAYS = 7;
const MIN_TTL_DAYS = 1;
const MAX_TTL_DAYS = 30;

interface InviteMemberDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** Called after a successful invite so the parent can refresh its list. */
  readonly onSuccess: (response: CreateInviteResponse) => void;
}

/** Minimal email format check — same shape Cognito accepts, intentionally lax. */
function isEmailLike(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

export function InviteMemberDialog({
  open,
  onClose,
  onSuccess,
}: InviteMemberDialogProps): React.JSX.Element {
  const intl = useIntl();
  const tenant = useActiveTenantId();
  const formId = useId();

  // Form state (UI-local — stays as useState).
  const [email, setEmail] = useState('');
  const [roleId, setRoleId] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [ttlDays, setTtlDays] = useState<number>(DEFAULT_TTL_DAYS);
  const [sendEmail, setSendEmail] = useState(true);
  const [fromName, setFromName] = useState('');
  const [acceptUrl, setAcceptUrl] = useState('');
  const [advancedOpen, setAdvancedOpen] = useState(false);

  // Domain-409 submit error: the shared-Cognito-pool "email already
  // associated" precheck maps to a specific inline message (needs the
  // attempted email). Kept as a string in useState; cleared on close +
  // before each submit. EVERY OTHER failure is read straight off
  // `inviteMutation.error` below and rendered via <ApiErrorAlert> so its
  // requestId surfaces — we don't pre-stringify those.
  const [domainError, setDomainError] = useState<string | null>(null);

  // Whether the raw token/link was copied — drives the transient "Copied!"
  // affordance on the manual-send success state's copy buttons.
  const [copied, setCopied] = useState<'link' | 'token' | null>(null);

  // Roles load via useQuery — `enabled: open` defers the fetch until
  // the dialog is actually opened, mirroring the prior useEffect's open-gate.
  // Switching tenants mid-flight changes the queryKey → automatic refetch.
  const rolesQuery = useQuery({
    queryKey: ['roles', tenant, ADMIN_CONTEXT_ID],
    queryFn: () =>
      drainPages<RoleResponse>((startFrom) =>
        vectrosApiClient(tenant).auth.listRoles(
          startFrom === undefined
            ? { contextId: ADMIN_CONTEXT_ID, limit: AUTH_PAGE_SIZE }
            : { contextId: ADMIN_CONTEXT_ID, startFrom, limit: AUTH_PAGE_SIZE },
        ),
      ),
    enabled: open,
  });
  const roles = rolesQuery.data ?? null;

  // Default-select the first role once the query resolves with at least
  // one and the user hasn't already picked one. (Was inside the old fetch
  // effect; now a derived side-effect on the query data.)
  useEffect(() => {
    if (roleId === '' && roles && roles.length > 0 && roles[0]?.roleId) {
      setRoleId(roles[0].roleId);
    }
  }, [roles, roleId]);

  // Auto-fill acceptUrl from current origin on mount. Stays controllable
  // so a partner customizing the dialog can pre-fill differently.
  useEffect(() => {
    if (open && acceptUrl === '' && typeof window !== 'undefined') {
      setAcceptUrl(`${window.location.origin}/accept`);
    }
  }, [open, acceptUrl]);

  // Submit mutation — the mutation's data is the canonical success
  // response (read via inviteMutation.isSuccess + .data). onError formats
  // the user-facing string with the attempted email from variables.
  const inviteMutation = useMutation({
    mutationFn: (body: CreateInviteRequest) =>
      vectrosApiClient(tenant).auth.createInvite(body),
    onSuccess: (response: CreateInviteResponse) => {
      onSuccess(response);
    },
    onError: (err: unknown, variables: CreateInviteRequest) => {
      // Only the domain-409 gets pre-formatted into an inline message; any
      // other failure is left for <ApiErrorAlert> to render off the
      // mutation error (so its requestId is preserved).
      setDomainError(domainInviteError(intl, err, variables.email));
    },
  });
  const submitting = inviteMutation.isPending;
  const successResponse = inviteMutation.isSuccess ? inviteMutation.data : null;
  // Render the generic <ApiErrorAlert> only when there's no domain message.
  const showGenericError = inviteMutation.isError && domainError === null;

  // Reset transient state when the dialog closes. Keeps form values for
  // the typical "oops, reopen" case — a deliberate UX choice.
  const handleClose = (): void => {
    setDomainError(null);
    setCopied(null);
    inviteMutation.reset();
    onClose();
  };

  const handleCopy = (which: 'link' | 'token', value: string): void => {
    void navigator.clipboard?.writeText(value);
    setCopied(which);
  };

  const emailValid = email === '' || isEmailLike(email);
  const canSubmit =
    !submitting &&
    email.trim() !== '' &&
    emailValid &&
    roleId !== '' &&
    ttlDays >= MIN_TTL_DAYS &&
    ttlDays <= MAX_TTL_DAYS;

  const handleSubmit = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    if (!canSubmit) return;
    setDomainError(null);
    inviteMutation.reset();

    const body: CreateInviteRequest = {
      email: email.trim().toLowerCase(),
      contextId: ADMIN_CONTEXT_ID,
      accessProfile: { roleId },
      ttlSeconds: ttlDays * 86400,
      sendEmail,
    };
    if (firstName.trim()) body.firstName = firstName.trim();
    if (lastName.trim()) body.lastName = lastName.trim();
    if (fromName.trim()) body.fromName = fromName.trim();
    if (acceptUrl.trim()) body.acceptUrl = acceptUrl.trim();

    inviteMutation.mutate(body);
  };

  const advancedToggleLabel = intl.formatMessage({ id: 'invite.advancedToggle' });

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      fullWidth
      maxWidth="sm"
      aria-labelledby={`${formId}-title`}
    >
      <DialogTitle id={`${formId}-title`}>
        <FormattedMessage id="invite.title" />
      </DialogTitle>
      <Box component="form" id={formId} onSubmit={handleSubmit} noValidate>
        <DialogContent>
          <Stack spacing={2}>
            <Typography variant="body2" color="text.secondary">
              <FormattedMessage id="invite.subtitle" />
            </Typography>

            {/* Success rendering — sendEmail path shows a simple message;
                manual-send path surfaces the token + accept link (each with
                a copy button) so the inviter can compose their own email. */}
            {successResponse && (
              <Alert severity="success" role="status">
                {sendEmail ? (
                  <FormattedMessage
                    id="invite.successWithEmail"
                    values={{ email: email.trim() }}
                  />
                ) : (
                  <Stack spacing={1}>
                    <FormattedMessage id="invite.successNoEmail" />
                    {successResponse.acceptLink && (
                      <Stack direction="row" spacing={1} alignItems="center">
                        <Link
                          href={successResponse.acceptLink}
                          target="_blank"
                          rel="noopener"
                          sx={{ wordBreak: 'break-all', flex: 1 }}
                        >
                          {successResponse.acceptLink}
                        </Link>
                        <Tooltip
                          title={intl.formatMessage({
                            id: copied === 'link' ? 'invite.copyLinkCopied' : 'invite.copyLinkLabel',
                          })}
                        >
                          <IconButton
                            size="small"
                            aria-label={intl.formatMessage({ id: 'invite.copyLinkLabel' })}
                            onClick={() => handleCopy('link', successResponse.acceptLink!)}
                          >
                            <ContentCopyIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                      </Stack>
                    )}
                    {successResponse.inviteToken && (
                      <Stack direction="row" spacing={1} alignItems="center">
                        <Typography
                          variant="caption"
                          component="code"
                          aria-label={intl.formatMessage({ id: 'invite.tokenLabel' })}
                          sx={{ wordBreak: 'break-all', opacity: 0.8, flex: 1 }}
                        >
                          {successResponse.inviteToken}
                        </Typography>
                        <Tooltip
                          title={intl.formatMessage({
                            id: copied === 'token' ? 'invite.copyLinkCopied' : 'invite.copyTokenLabel',
                          })}
                        >
                          <IconButton
                            size="small"
                            aria-label={intl.formatMessage({ id: 'invite.copyTokenLabel' })}
                            onClick={() => handleCopy('token', successResponse.inviteToken!)}
                          >
                            <ContentCopyIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                      </Stack>
                    )}
                  </Stack>
                )}
              </Alert>
            )}

            {/* Domain-409 ("email already associated") → specific inline copy. */}
            {domainError && (
              <Alert severity="error" role="alert">
                {domainError}
              </Alert>
            )}

            {/* Every other failure → ApiErrorAlert so its requestId surfaces. */}
            {showGenericError && (
              <ApiErrorAlert error={inviteMutation.error}>
                <FormattedMessage
                  id="invite.errorGeneric"
                  values={{ message: genericErrorMessage(inviteMutation.error) }}
                />
              </ApiErrorAlert>
            )}

            <TextField
              label={intl.formatMessage({ id: 'invite.emailLabel' })}
              placeholder={intl.formatMessage({ id: 'invite.emailPlaceholder' })}
              type="email"
              autoComplete="email"
              required
              fullWidth
              value={email}
              onChange={(ev) => setEmail(ev.target.value)}
              error={email !== '' && !emailValid}
              helperText={
                email !== '' && !emailValid
                  ? intl.formatMessage({ id: 'invite.errorEmailInvalid' })
                  : undefined
              }
              disabled={submitting || successResponse !== null}
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
            />

            <FormControl fullWidth required disabled={submitting || successResponse !== null}>
              <InputLabel id={`${formId}-role-label`}>
                <FormattedMessage id="invite.roleLabel" />
              </InputLabel>
              <Select
                labelId={`${formId}-role-label`}
                label={intl.formatMessage({ id: 'invite.roleLabel' })}
                value={roleId}
                onChange={(ev) => setRoleId(String(ev.target.value))}
              >
                {roles === null && (
                  <MenuItem value="" disabled>
                    <FormattedMessage id="invite.roleLoading" />
                  </MenuItem>
                )}
                {roles !== null && roles.length === 0 && (
                  <MenuItem value="" disabled>
                    <FormattedMessage id="invite.roleNone" />
                  </MenuItem>
                )}
                {roles?.map((t) =>
                  t.roleId ? (
                    <MenuItem key={t.roleId} value={t.roleId}>
                      {t.name ?? t.roleId}
                    </MenuItem>
                  ) : null,
                )}
              </Select>
              <FormHelperText>
                <FormattedMessage id="invite.roleHelper" />
              </FormHelperText>
            </FormControl>

            {/* A roles-load failure is announced (role="alert" via
                ApiErrorAlert) instead of sitting as a quiet helper string. */}
            {rolesQuery.isError && (
              <ApiErrorAlert error={rolesQuery.error}>
                <FormattedMessage id="invite.rolesErrorBody" />
              </ApiErrorAlert>
            )}

            <Box>
              <Button
                type="button"
                onClick={() => setAdvancedOpen((v) => !v)}
                size="small"
                aria-expanded={advancedOpen}
                aria-controls={`${formId}-advanced`}
                sx={{ textTransform: 'none', px: 0 }}
              >
                {advancedOpen ? `− ${advancedToggleLabel}` : `+ ${advancedToggleLabel}`}
              </Button>
              <Collapse in={advancedOpen} id={`${formId}-advanced`}>
                <Stack spacing={2} sx={{ pt: 1.5 }}>
                  <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                    <TextField
                      label={intl.formatMessage({ id: 'invite.firstNameLabel' })}
                      autoComplete="given-name"
                      fullWidth
                      value={firstName}
                      onChange={(ev) => setFirstName(ev.target.value)}
                      disabled={submitting || successResponse !== null}
                    />
                    <TextField
                      label={intl.formatMessage({ id: 'invite.lastNameLabel' })}
                      autoComplete="family-name"
                      fullWidth
                      value={lastName}
                      onChange={(ev) => setLastName(ev.target.value)}
                      disabled={submitting || successResponse !== null}
                    />
                  </Stack>
                  <TextField
                    label={intl.formatMessage({ id: 'invite.ttlLabel' })}
                    helperText={<FormattedMessage id="invite.ttlHelper" />}
                    type="number"
                    fullWidth
                    value={ttlDays}
                    onChange={(ev) =>
                      setTtlDays(Math.max(MIN_TTL_DAYS, Math.min(MAX_TTL_DAYS, Number(ev.target.value) || 0)))
                    }
                    slotProps={{
                      htmlInput: { min: MIN_TTL_DAYS, max: MAX_TTL_DAYS, step: 1 },
                    }}
                    disabled={submitting || successResponse !== null}
                  />
                  <TextField
                    label={intl.formatMessage({ id: 'invite.fromNameLabel' })}
                    helperText={intl.formatMessage(
                      { id: 'invite.fromNameHelper' },
                      { productName: BRAND.productName },
                    )}
                    fullWidth
                    value={fromName}
                    onChange={(ev) => setFromName(ev.target.value)}
                    disabled={submitting || successResponse !== null}
                  />
                  <TextField
                    label={intl.formatMessage({ id: 'invite.acceptUrlLabel' })}
                    helperText={<FormattedMessage id="invite.acceptUrlHelper" />}
                    type="url"
                    fullWidth
                    value={acceptUrl}
                    onChange={(ev) => setAcceptUrl(ev.target.value)}
                    disabled={submitting || successResponse !== null}
                  />
                  <FormControlLabel
                    control={
                      <Checkbox
                        checked={sendEmail}
                        onChange={(ev) => setSendEmail(ev.target.checked)}
                        disabled={submitting || successResponse !== null}
                      />
                    }
                    label={
                      <Stack>
                        <Typography variant="body2">
                          <FormattedMessage id="invite.sendEmailLabel" />
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          <FormattedMessage id="invite.sendEmailHelper" />
                        </Typography>
                      </Stack>
                    }
                  />
                </Stack>
              </Collapse>
            </Box>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={handleClose} disabled={submitting}>
            {successResponse ? (
              <FormattedMessage id="confirm.backToSignIn" />
            ) : (
              <FormattedMessage id="invite.cancel" />
            )}
          </Button>
          {!successResponse && (
            <SubmitButton type="submit" variant="contained" disabled={!canSubmit} pending={submitting}>
              <FormattedMessage id="invite.submit" />
            </SubmitButton>
          )}
        </DialogActions>
      </Box>
    </Dialog>
  );
}

/**
 * Map the shared-Cognito-pool placeholder's 409 ("email already
 * associated") to its domain-specific inline message. Returns `null` for
 * every other error so the caller falls back to the generic
 * {@link ApiErrorAlert} (which preserves the error's requestId).
 */
function domainInviteError(
  intl: ReturnType<typeof useIntl>,
  err: unknown,
  attemptedEmail: string,
): string | null {
  if (err instanceof VectrosError && err.statusCode === 409) {
    const body = err.body as { error?: string; message?: string } | undefined;
    if (body?.error === 'email_already_associated') {
      return intl.formatMessage(
        { id: 'invite.errorEmailExists' },
        { email: attemptedEmail },
      );
    }
  }
  return null;
}

/**
 * Best-effort human-readable message for the generic-error branch. The
 * requestId is surfaced separately by {@link ApiErrorAlert}; this is only the
 * prose the `invite.errorGeneric` template interpolates.
 */
function genericErrorMessage(err: unknown): string {
  if (err instanceof VectrosError && err.message) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}
