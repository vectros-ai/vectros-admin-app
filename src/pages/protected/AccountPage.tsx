// ---------------------------------------------------------------------------
// AccountPage (/account) — the signed-in user's account + security settings.
//
// This page provides the Two-factor authentication management
// card. The account recap (email / name / id) is co-located so the route isn't
// a single-card page; profile editing, sessions, etc. are out of scope here.
//
// MFA card behavior:
//   - Reads the current preference via useAuth().getMfaStatus() (TanStack Query,
//     keyed ['mfaStatus']).
//   - Not enrolled → "Set up authenticator app" → opens a dialog hosting the
//     presentational TotpEnrollmentWizard: setUpTotp() provisions the secret,
//     verifyTotpSetup(code) confirms + makes TOTP preferred, then we invalidate
//     ['mfaStatus'] so the card flips to "Enabled".
//   - Enrolled → "Turn off" → confirm dialog → disableTotp().
//
// All Cognito specifics live behind the adapter; this page is provider-agnostic.
// ---------------------------------------------------------------------------

import { useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogContent,
  DialogTitle,
  Paper,
  Stack,
  Typography,
} from '@mui/material';
import { FormattedMessage, useIntl } from 'react-intl';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { useAuth, authErrorToMessage } from '../../auth';
import type { TotpSetupDetails } from '../../auth';
import {
  ConfirmDialog,
  LoadingBlock,
  MetaList,
  MetaRow,
  TotpEnrollmentWizard,
} from '@vectros-ai/react';
import { ApiErrorAlert } from '../../components/ApiErrorAlert';

const MFA_STATUS_KEY = ['mfaStatus'] as const;

export function AccountPage(): React.JSX.Element {
  const intl = useIntl();
  const { user, getMfaStatus, setUpTotp, verifyTotpSetup, disableTotp } = useAuth();
  const queryClient = useQueryClient();

  const mfaQuery = useQuery({ queryKey: MFA_STATUS_KEY, queryFn: () => getMfaStatus() });
  const totpEnabled = mfaQuery.data?.enabled.includes('TOTP') ?? false;

  // ---- Enrollment dialog state ----
  const [enrollOpen, setEnrollOpen] = useState(false);
  const [setup, setSetup] = useState<TotpSetupDetails | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);

  const openEnroll = async (): Promise<void> => {
    setEnrollOpen(true);
    setSetup(null);
    setSetupError(null);
    setVerifyError(null);
    try {
      setSetup(await setUpTotp());
    } catch (err) {
      setSetupError(authErrorToMessage(intl, err));
    }
  };

  const closeEnroll = (): void => {
    setEnrollOpen(false);
  };

  const handleVerify = async (code: string): Promise<void> => {
    setVerifying(true);
    setVerifyError(null);
    try {
      await verifyTotpSetup(code);
      await queryClient.invalidateQueries({ queryKey: MFA_STATUS_KEY });
      setEnrollOpen(false);
    } catch (err) {
      setVerifyError(authErrorToMessage(intl, err));
    } finally {
      setVerifying(false);
    }
  };

  // ---- Disable-confirm dialog state ----
  const [disableOpen, setDisableOpen] = useState(false);
  const [disabling, setDisabling] = useState(false);
  const [disableError, setDisableError] = useState<string | null>(null);

  const handleDisable = async (): Promise<void> => {
    setDisabling(true);
    setDisableError(null);
    try {
      await disableTotp();
      await queryClient.invalidateQueries({ queryKey: MFA_STATUS_KEY });
      setDisableOpen(false);
    } catch (err) {
      setDisableError(authErrorToMessage(intl, err));
    } finally {
      setDisabling(false);
    }
  };

  // Close the disable-confirm dialog and reset any prior failure, so a stale
  // error doesn't reappear when the dialog is reopened. Dismissal is ignored
  // while the disable call is in flight (ConfirmDialog enforces this too).
  const closeDisable = (): void => {
    if (disabling) return;
    setDisableOpen(false);
    setDisableError(null);
  };

  return (
    <Stack spacing={3}>
      <Typography variant="h4" component="h1" sx={{ fontWeight: 700 }}>
        <FormattedMessage id="account.title" />
      </Typography>

      {/* Account recap */}
      <Paper component="section" aria-labelledby="account-info-heading" sx={{ p: 3 }}>
        <Typography id="account-info-heading" variant="h6" component="h2" sx={{ mb: 2 }}>
          <FormattedMessage id="account.infoHeading" />
        </Typography>
        <MetaList>
          <MetaRow label={<FormattedMessage id="account.emailLabel" />}>
            {user?.email ?? '—'}
          </MetaRow>
          <MetaRow label={<FormattedMessage id="account.nameLabel" />}>
            {[user?.firstName, user?.lastName].filter(Boolean).join(' ') || '—'}
          </MetaRow>
          <MetaRow label={<FormattedMessage id="account.idLabel" />}>
            <Box component="span" sx={{ fontFamily: 'monospace', fontSize: 14 }}>
              {user?.sub ?? '—'}
            </Box>
          </MetaRow>
        </MetaList>
      </Paper>

      {/* Two-factor authentication */}
      <Paper component="section" aria-labelledby="account-mfa-heading" sx={{ p: 3 }}>
        <Stack direction="row" alignItems="center" spacing={1.5} sx={{ mb: 2 }}>
          <Typography id="account-mfa-heading" variant="h6" component="h2">
            <FormattedMessage id="mfa.cardTitle" />
          </Typography>
          {!mfaQuery.isLoading && !mfaQuery.isError && (
            <Chip
              size="small"
              color={totpEnabled ? 'success' : 'default'}
              label={
                <FormattedMessage id={totpEnabled ? 'mfa.statusEnabled' : 'mfa.statusDisabled'} />
              }
            />
          )}
        </Stack>

        {mfaQuery.isLoading && (
          <LoadingBlock label={intl.formatMessage({ id: 'mfa.loading' })} py={2} size={28} />
        )}

        {mfaQuery.isError && (
          <ApiErrorAlert error={mfaQuery.error}>
            <FormattedMessage id="mfa.loadError" />
          </ApiErrorAlert>
        )}

        {!mfaQuery.isLoading && !mfaQuery.isError && (
          <Stack spacing={2} alignItems="flex-start">
            <Typography variant="body1" color="text.secondary">
              <FormattedMessage id={totpEnabled ? 'mfa.enabledBody' : 'mfa.disabledBody'} />
            </Typography>
            {totpEnabled ? (
              <Button variant="outlined" color="error" onClick={() => setDisableOpen(true)}>
                <FormattedMessage id="mfa.turnOffCta" />
              </Button>
            ) : (
              <Button variant="contained" onClick={() => void openEnroll()}>
                <FormattedMessage id="mfa.setUpCta" />
              </Button>
            )}
          </Stack>
        )}
      </Paper>

      {/* Enrollment dialog — hosts the presentational wizard. */}
      <Dialog open={enrollOpen} onClose={closeEnroll} maxWidth="xs" fullWidth>
        <DialogTitle>
          <FormattedMessage id="mfa.enrollDialogTitle" />
        </DialogTitle>
        <DialogContent>
          {setupError ? (
            <Alert severity="error" role="alert" sx={{ mt: 1 }}>
              {setupError}
            </Alert>
          ) : setup === null ? (
            <LoadingBlock label={intl.formatMessage({ id: 'mfa.preparing' })} py={4} />
          ) : (
            <Box sx={{ pt: 1 }}>
              <TotpEnrollmentWizard
                secret={setup.secret}
                otpauthUri={setup.otpauthUri}
                onVerify={(code) => void handleVerify(code)}
                pending={verifying}
                error={verifyError}
                onCancel={closeEnroll}
              />
            </Box>
          )}
        </DialogContent>
      </Dialog>

      {/* Disable-confirm dialog — ConfirmDialog bakes in aria-labelledby, a
          pending-guarded dismissal, and the in-dialog role="alert" error slot.
          The disable error (an authErrorToMessage string, not an API error so
          there's no requestId) renders inside the dialog, never behind it. */}
      <ConfirmDialog
        open={disableOpen}
        title={<FormattedMessage id="mfa.disableConfirmTitle" />}
        body={<FormattedMessage id="mfa.disableConfirmBody" />}
        confirmLabel={<FormattedMessage id="mfa.turnOffCta" />}
        cancelLabel={<FormattedMessage id="mfa.disableCancel" />}
        onConfirm={() => void handleDisable()}
        onClose={closeDisable}
        pending={disabling}
        error={disableError}
      />
    </Stack>
  );
}
