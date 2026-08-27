// ---------------------------------------------------------------------------
// TransferOwnershipDialog — drives POST /developer/account-owner via the
// owner-gated Developer API (../../api/developerApi), opened from a member
// row's "Transfer ownership" action on MembersPage.
//
// This is the single most consequential control MembersPage exposes: on
// success the CALLER — the account's current owner — immediately loses their
// own OWNER-gated /developer/* access, and only the new owner can transfer it
// back. The three facts the backend's own API description makes deliberately
// explicit are disclosed here verbatim, not paraphrased into something softer:
//   1. Irreversible for the caller.
//   2. Re-points BOTH the live and test tenants' owner slot, not just
//      whichever tenant the TenantSwitcher currently has active.
//   3. Already-minted credentials (st_*, ssk_*, sk_*) are NOT revoked.
//
// Given the severity, confirming requires typing the target's own email
// verbatim — the same typed-echo pattern ContextsPage's teardown dialog uses
// for context deletion (a lesser, though still irreversible, action).
// ---------------------------------------------------------------------------

import { useEffect, useId, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { FormattedMessage, useIntl } from 'react-intl';
import { useMutation } from '@tanstack/react-query';
import { SubmitButton } from '@vectros-ai/react';

import { useDeveloperApi } from '../../api/developerApi';
import type { AccountOwnerTransferResult } from '../../api/developerApi';
import type { UserResponse } from '../../api/vectrosApi';
import { extractErrorMessage } from '../../lib/apiError';
import { ApiErrorAlert } from '../../components/ApiErrorAlert';

interface TransferOwnershipDialogProps {
  /** The member row being offered ownership, or null when the dialog is closed. */
  readonly member: UserResponse | null;
  readonly onClose: () => void;
  /** Called after a successful transfer with the new owner's email (for the page's success banner). */
  readonly onSuccess: (result: AccountOwnerTransferResult, email: string) => void;
}

export function TransferOwnershipDialog({
  member,
  onClose,
  onSuccess,
}: TransferOwnershipDialogProps): React.JSX.Element {
  const intl = useIntl();
  const devApi = useDeveloperApi();
  const titleId = useId();
  const confirmHelperId = useId();

  const [typedEmail, setTypedEmail] = useState('');

  // The typed-echo target. Every row this dialog is opened for has an email:
  // MembersPage restricts the action to HUMAN + ACTIVE rows, and a HUMAN row
  // reaches ACTIVE only via an invite, which requires one. No id fallback —
  // every string in this dialog (title, helper text, MembersPage's success
  // banner) is hard-coded around "email", so falling back to the raw member
  // id would tell the operator to type an email and then report success
  // using an opaque id as though it were one.
  const confirmTarget = member?.email ?? '';

  const mutation = useMutation({
    mutationFn: (): Promise<AccountOwnerTransferResult> => {
      if (!member?.id) return Promise.reject(new Error('No transfer target'));
      return devApi.transferOwnership(member.id);
    },
    onSuccess: (result) => {
      onSuccess(result, confirmTarget);
    },
  });

  // Reset the typed echo + any prior failure whenever the dialog closes so
  // reopening (possibly for a different member) starts clean.
  useEffect(() => {
    if (member === null) {
      setTypedEmail('');
      mutation.reset();
    }
    // `mutation` is stable; only the member gate matters here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [member]);

  const canTransfer = confirmTarget !== '' && typedEmail === confirmTarget;
  const errorDetail = extractErrorMessage(mutation.error);

  const handleClose = (): void => {
    if (!mutation.isPending) onClose();
  };

  return (
    <Dialog
      open={member !== null}
      onClose={handleClose}
      maxWidth="sm"
      fullWidth
      aria-labelledby={titleId}
    >
      <DialogTitle id={titleId}>
        <FormattedMessage id="members.transferDialogTitle" values={{ email: confirmTarget }} />
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2}>
          {mutation.isError && (
            <ApiErrorAlert error={mutation.error}>
              <FormattedMessage id="members.transferErrorBody" />
              {errorDetail && (
                <Typography variant="caption" component="p" sx={{ mt: 0.5, opacity: 0.85 }}>
                  {errorDetail}
                </Typography>
              )}
            </ApiErrorAlert>
          )}

          {/* Static content from the moment the dialog opens, not a live
              announcement — role="note" rather than MUI's role="alert"
              default, so it doesn't collide with (or dilute) the genuinely
              time-sensitive error alert above when both are on screen at
              once. */}
          <Alert severity="warning" role="note">
            <Typography variant="body2" component="div">
              <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
                <li>
                  <FormattedMessage id="members.transferDisclosureIrreversible" />
                </li>
                <li>
                  <FormattedMessage id="members.transferDisclosureBothTenants" />
                </li>
                <li>
                  <FormattedMessage id="members.transferDisclosureCredentialsLive" />
                </li>
              </Box>
            </Typography>
          </Alert>

          <DialogContentText>
            <FormattedMessage id="members.transferDialogBody" values={{ email: confirmTarget }} />
          </DialogContentText>

          <TextField
            label={intl.formatMessage({ id: 'members.transferConfirmLabel' })}
            value={typedEmail}
            onChange={(e) => setTypedEmail(e.target.value)}
            disabled={mutation.isPending}
            helperText={
              <FormattedMessage
                id="members.transferConfirmHelper"
                values={{ email: <code>{confirmTarget}</code> }}
              />
            }
            FormHelperTextProps={{ id: confirmHelperId }}
            inputProps={{
              spellCheck: false,
              'aria-describedby': confirmHelperId,
            }}
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose} disabled={mutation.isPending}>
          <FormattedMessage id="members.transferCancel" />
        </Button>
        <SubmitButton
          color="error"
          variant="contained"
          onClick={() => mutation.mutate()}
          disabled={!canTransfer}
          pending={mutation.isPending}
        >
          <FormattedMessage id="members.transferCta" />
        </SubmitButton>
      </DialogActions>
    </Dialog>
  );
}
