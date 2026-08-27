// ---------------------------------------------------------------------------
// IssuersPage — admin-app's `/access/issuers` list + edit view.
//
// Functional scope:
//   - Lists every trusted third-party identity provider registered in the
//     tenant, through the owner-gated developer API (see ../../api/developerApi).
//     Registering a NEW issuer requires a root key or a non-grantable
//     provisioning capability that never reaches the browser, so this surface
//     is intentionally view + edit only — no create, no delete. Use the CLI or
//     SDK with a provisioning-scoped credential to register or deregister one.
//   - Edit dialog operates on a deliberately narrow "safe field" set: the
//     subject/email claim names, the active/suspended status, and the
//     self-service signup policies. **Not this UI's full safe-field set:**
//     the platform's `userinfoUri` (an OIDC userinfo-endpoint email-resolution
//     fallback) is also a safe field, but this surface neither shows nor
//     edits it yet — use the CLI/SDK for it. The issuer's cryptographic
//     trust anchor (issuer URL, JWKS endpoint, required audience) and the
//     app context it targets are immutable once registered — shown read-only
//     in the dialog for reference, but never sent back on save. Rotating one
//     of those means deleting and re-registering the issuer, which this UI
//     doesn't offer.
//   - Setting status to "suspended" stops the issuer's tokens from being
//     accepted at exchange time — existing signed-in users are unaffected until
//     they next need a fresh sign-in. It does not revoke anyone's access
//     directly.
//   - Self-service signup policies let a first-time caller from this issuer be
//     created automatically, without an invite, bound to a chosen role. Each
//     entry pairs a caller-facing signup type with the role it grants; a policy
//     can never target a role that already carries elevated (wildcard or
//     provisioning) permissions — the server refuses that outright.
// ---------------------------------------------------------------------------

import { useEffect, useId, useMemo, useState } from 'react';
import {
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  FormControl,
  IconButton,
  InputLabel,
  MenuItem,
  Paper,
  Select,
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
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import EditIcon from '@mui/icons-material/Edit';
import RefreshIcon from '@mui/icons-material/Refresh';
import { FormattedMessage, useIntl } from 'react-intl';
import { LoadingBlock, SubmitButton } from '@vectros-ai/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useDeveloperApi } from '../../api/developerApi';
import type { IssuerSummary } from '../../api/developerApi';
import { ApiErrorAlert } from '../../components/ApiErrorAlert';
import { accessQueryKeys } from '../../lib/accessQueryKeys';
import { drainPages, AUTH_PAGE_SIZE } from '../../lib/drainPages';

// ---------------------------------------------------------------------------
// IssuersPage
// ---------------------------------------------------------------------------

export function IssuersPage(): React.JSX.Element {
  const intl = useIntl();
  const queryClient = useQueryClient();
  const devApi = useDeveloperApi();

  const issuersQuery = useQuery({
    queryKey: accessQueryKeys.issuers(),
    queryFn: () =>
      drainPages<IssuerSummary>((startFrom) => devApi.listIssuers(startFrom, AUTH_PAGE_SIZE)),
  });
  const issuers = useMemo<IssuerSummary[]>(() => issuersQuery.data ?? [], [issuersQuery.data]);

  const [editTarget, setEditTarget] = useState<IssuerSummary | null>(null);

  const handleRefresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: accessQueryKeys.issuers() });
  };

  return (
    <Stack spacing={3}>
      <Box>
        <Typography variant="h4" component="h1" sx={{ fontWeight: 700 }}>
          <FormattedMessage id="access.issuers.title" />
        </Typography>
        <Typography variant="body1" color="text.secondary" sx={{ mt: 1 }}>
          <FormattedMessage id="access.issuers.subtitle" />
        </Typography>
      </Box>

      {issuersQuery.isError && (
        <ApiErrorAlert error={issuersQuery.error}>
          <FormattedMessage id="access.issuers.loadError.friendly" />
        </ApiErrorAlert>
      )}

      {issuersQuery.isLoading && !issuersQuery.isError && (
        <LoadingBlock label={intl.formatMessage({ id: 'access.issuers.loading' })} />
      )}

      {issuersQuery.isSuccess && issuers.length === 0 && (
        <Paper sx={{ p: 4, textAlign: 'center' }}>
          <Typography variant="body1" color="text.secondary">
            <FormattedMessage id="access.issuers.empty" />
          </Typography>
        </Paper>
      )}

      {issuersQuery.isSuccess && issuers.length > 0 && (
        <>
          <Stack direction="row" alignItems="center" spacing={2}>
            <Box sx={{ flexGrow: 1 }} />
            <Tooltip title={intl.formatMessage({ id: 'access.shared.refresh' })}>
              <span>
                <IconButton
                  onClick={handleRefresh}
                  disabled={issuersQuery.isFetching}
                  aria-label={intl.formatMessage({ id: 'access.shared.refresh' })}
                >
                  <RefreshIcon />
                </IconButton>
              </span>
            </Tooltip>
          </Stack>

          <TableContainer component={Paper}>
            <Table aria-label={intl.formatMessage({ id: 'access.issuers.title' })}>
              <TableHead>
                <TableRow>
                  <TableCell sx={{ fontWeight: 600 }}>
                    <FormattedMessage id="access.issuers.columnId" />
                  </TableCell>
                  <TableCell sx={{ fontWeight: 600 }}>
                    <FormattedMessage id="access.issuers.columnIssuer" />
                  </TableCell>
                  <TableCell sx={{ fontWeight: 600 }}>
                    <FormattedMessage id="access.issuers.columnContext" />
                  </TableCell>
                  <TableCell sx={{ fontWeight: 600 }}>
                    <FormattedMessage id="access.issuers.columnStatus" />
                  </TableCell>
                  <TableCell sx={{ fontWeight: 600 }} align="right">
                    <FormattedMessage id="access.issuers.columnSelfSignup" />
                  </TableCell>
                  <TableCell sx={{ fontWeight: 600 }}>
                    <FormattedMessage id="access.issuers.columnCreated" />
                  </TableCell>
                  <TableCell sx={{ fontWeight: 600 }} align="right">
                    <FormattedMessage id="access.issuers.columnActions" />
                  </TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {issuers.map((issuer, index) => (
                  <IssuerRow
                    key={issuer.issuerId ?? `issuer-${index}`}
                    issuer={issuer}
                    onEdit={() => setEditTarget(issuer)}
                  />
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </>
      )}

      <IssuerEditorDialog target={editTarget} onClose={() => setEditTarget(null)} />
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// IssuerRow
// ---------------------------------------------------------------------------

function IssuerRow({
  issuer,
  onEdit,
}: {
  issuer: IssuerSummary;
  onEdit: () => void;
}): React.JSX.Element {
  const intl = useIntl();
  const suspended = issuer.status === 'suspended';
  const selfSignupCount = issuer.selfSignupPolicies?.length ?? 0;

  return (
    <TableRow hover>
      <TableCell sx={{ fontFamily: 'monospace', fontSize: 13 }}>{issuer.issuerId ?? '—'}</TableCell>
      <TableCell sx={{ color: 'text.secondary', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {issuer.issuer ?? '—'}
      </TableCell>
      <TableCell sx={{ fontFamily: 'monospace', fontSize: 13 }}>{issuer.contextId ?? '—'}</TableCell>
      <TableCell>
        <Chip
          size="small"
          label={intl.formatMessage({
            id: suspended ? 'access.issuers.statusSuspended' : 'access.issuers.statusActive',
          })}
          color={suspended ? 'default' : 'success'}
          variant={suspended ? 'outlined' : 'filled'}
        />
      </TableCell>
      <TableCell align="right">
        {selfSignupCount > 0
          ? intl.formatMessage({ id: 'access.issuers.selfSignupCount' }, { count: selfSignupCount })
          : '—'}
      </TableCell>
      <TableCell sx={{ color: 'text.secondary', fontSize: 13 }}>
        {issuer.createdAt ? new Date(issuer.createdAt).toLocaleDateString() : '—'}
      </TableCell>
      <TableCell align="right">
        <Tooltip title={intl.formatMessage({ id: 'access.issuers.editTooltip' })}>
          <IconButton
            size="small"
            onClick={onEdit}
            aria-label={intl.formatMessage({ id: 'access.issuers.editTooltip' })}
          >
            <EditIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </TableCell>
    </TableRow>
  );
}

// ---------------------------------------------------------------------------
// IssuerEditorDialog — edits only the safe field set. The trust-anchor fields
// are shown read-only for reference and never sent back on save.
// ---------------------------------------------------------------------------

/** One in-progress self-signup policy row in the editor — mirrors {@link SelfSignupPolicy} but keyed
 *  by a local id so React can track rows across add/remove/reorder. */
interface DraftPolicy {
  readonly key: string;
  signupType: string;
  roleId: string;
}

let draftKeySeq = 0;
function nextDraftKey(): string {
  draftKeySeq += 1;
  return `draft-${draftKeySeq}`;
}

function IssuerEditorDialog({
  target,
  onClose,
}: {
  target: IssuerSummary | null;
  onClose: () => void;
}): React.JSX.Element {
  const intl = useIntl();
  const queryClient = useQueryClient();
  const devApi = useDeveloperApi();
  const titleElementId = useId();

  const [subClaim, setSubClaim] = useState('');
  const [emailClaim, setEmailClaim] = useState('');
  const [status, setStatus] = useState<'active' | 'suspended'>('active');
  const [policies, setPolicies] = useState<DraftPolicy[]>([]);

  const mutation = useMutation({
    mutationFn: async (): Promise<void> => {
      if (!target?.issuerId) return;
      // Always send subClaim/emailClaim (never omitted) — the fields are always prefilled from the
      // server's current value (which itself defaults to "sub"/"email"), so an omitted field here
      // would only ever mean the user deliberately cleared it, intending to reset to the default.
      // Sending it through (even blank) lets the server's own default-on-blank rule do the reset;
      // omitting it would silently leave the old value in place instead.
      await devApi.updateIssuer(target.issuerId, {
        subClaim: subClaim.trim(),
        emailClaim: emailClaim.trim(),
        status,
        selfSignupPolicies: policies
          .filter((p) => p.signupType.trim() !== '' && p.roleId.trim() !== '')
          .map((p) => ({ signup_type: p.signupType.trim(), role_id: p.roleId.trim() })),
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: accessQueryKeys.issuers() });
      onClose();
    },
  });

  // Seed the form whenever the dialog opens on a (possibly new) target.
  useEffect(() => {
    if (!target) return;
    setSubClaim(target.subClaim ?? '');
    setEmailClaim(target.emailClaim ?? '');
    setStatus(target.status === 'suspended' ? 'suspended' : 'active');
    setPolicies(
      (target.selfSignupPolicies ?? []).map((p) => ({
        key: nextDraftKey(),
        signupType: p.signup_type,
        roleId: p.role_id,
      })),
    );
    mutation.reset();
    // `mutation` is stable across renders; depend only on the target.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  const addPolicy = (): void => {
    setPolicies((prev) => [...prev, { key: nextDraftKey(), signupType: '', roleId: '' }]);
  };
  const removePolicy = (key: string): void => {
    setPolicies((prev) => prev.filter((p) => p.key !== key));
  };
  const updatePolicy = (key: string, field: 'signupType' | 'roleId', value: string): void => {
    setPolicies((prev) => prev.map((p) => (p.key === key ? { ...p, [field]: value } : p)));
  };

  return (
    <Dialog
      open={target !== null}
      onClose={() => !mutation.isPending && onClose()}
      maxWidth="sm"
      fullWidth
      aria-labelledby={titleElementId}
    >
      <DialogTitle id={titleElementId}>
        <FormattedMessage id="access.issuers.editDialog.title" values={{ issuerId: target?.issuerId ?? '' }} />
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2.5} sx={{ pt: 1 }}>
          <DialogContentText component="div">
            <FormattedMessage id="access.issuers.editDialog.intro" />
          </DialogContentText>

          {/* Trust-anchor fields — read-only reference, never submitted. */}
          <Stack spacing={0.5} sx={{ p: 1.5, bgcolor: 'action.hover', borderRadius: 1 }}>
            <ReadOnlyField labelId="access.issuers.editDialog.issuerLabel" value={target?.issuer} />
            <ReadOnlyField labelId="access.issuers.editDialog.jwksUriLabel" value={target?.jwksUri} />
            <ReadOnlyField labelId="access.issuers.editDialog.audienceLabel" value={target?.audience} />
            <ReadOnlyField labelId="access.issuers.editDialog.contextLabel" value={target?.contextId} />
          </Stack>

          <FormControl fullWidth>
            <InputLabel id={`${titleElementId}-status`}>
              <FormattedMessage id="access.issuers.editDialog.statusLabel" />
            </InputLabel>
            <Select
              labelId={`${titleElementId}-status`}
              label={intl.formatMessage({ id: 'access.issuers.editDialog.statusLabel' })}
              value={status}
              onChange={(e) => setStatus(e.target.value as 'active' | 'suspended')}
            >
              <MenuItem value="active">
                {intl.formatMessage({ id: 'access.issuers.statusActive' })}
              </MenuItem>
              <MenuItem value="suspended">
                {intl.formatMessage({ id: 'access.issuers.statusSuspended' })}
              </MenuItem>
            </Select>
          </FormControl>

          <TextField
            label={intl.formatMessage({ id: 'access.issuers.editDialog.subClaimLabel' })}
            value={subClaim}
            onChange={(e) => setSubClaim(e.target.value)}
            helperText={intl.formatMessage({ id: 'access.issuers.editDialog.subClaimHelper' })}
          />
          <TextField
            label={intl.formatMessage({ id: 'access.issuers.editDialog.emailClaimLabel' })}
            value={emailClaim}
            onChange={(e) => setEmailClaim(e.target.value)}
            helperText={intl.formatMessage({ id: 'access.issuers.editDialog.emailClaimHelper' })}
          />

          <Box>
            <Stack direction="row" alignItems="center" justifyContent="space-between">
              <Typography variant="subtitle2">
                <FormattedMessage id="access.issuers.editDialog.selfSignupTitle" />
              </Typography>
              <Button size="small" startIcon={<AddIcon />} onClick={addPolicy}>
                <FormattedMessage id="access.issuers.editDialog.addPolicy" />
              </Button>
            </Stack>
            <Typography variant="caption" color="text.secondary">
              <FormattedMessage id="access.issuers.editDialog.selfSignupHelper" />
            </Typography>
            <Stack spacing={1.5} sx={{ mt: 1.5 }}>
              {policies.map((policy) => (
                <Stack key={policy.key} direction="row" spacing={1} alignItems="center">
                  <TextField
                    size="small"
                    label={intl.formatMessage({ id: 'access.issuers.editDialog.signupTypeLabel' })}
                    value={policy.signupType}
                    onChange={(e) => updatePolicy(policy.key, 'signupType', e.target.value)}
                    sx={{ flex: 1 }}
                  />
                  <TextField
                    size="small"
                    label={intl.formatMessage({ id: 'access.issuers.editDialog.roleIdLabel' })}
                    value={policy.roleId}
                    onChange={(e) => updatePolicy(policy.key, 'roleId', e.target.value)}
                    sx={{ flex: 1, fontFamily: 'monospace' }}
                  />
                  <IconButton
                    size="small"
                    onClick={() => removePolicy(policy.key)}
                    aria-label={intl.formatMessage({ id: 'access.shared.delete' })}
                  >
                    <DeleteOutlineIcon fontSize="small" />
                  </IconButton>
                </Stack>
              ))}
            </Stack>
          </Box>

          {mutation.isError && (
            <ApiErrorAlert error={mutation.error}>
              <FormattedMessage id="access.issuers.editDialog.saveError.friendly" />
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
          pending={mutation.isPending}
        >
          <FormattedMessage id="access.shared.save" />
        </SubmitButton>
      </DialogActions>
    </Dialog>
  );
}

function ReadOnlyField({ labelId, value }: { labelId: string; value: string | undefined }): React.JSX.Element {
  return (
    <Stack direction="row" spacing={1} sx={{ fontSize: 13 }}>
      <Typography component="span" variant="caption" color="text.secondary" sx={{ minWidth: 110 }}>
        <FormattedMessage id={labelId} />
      </Typography>
      <Typography component="span" variant="caption" sx={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>
        {value ?? '—'}
      </Typography>
    </Stack>
  );
}
