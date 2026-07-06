// ---------------------------------------------------------------------------
// ConfirmPage — post-signup email verification.
//
// The user lands here after AcceptPage (or any other signup flow) redirected
// them with `?email=<email>`. They type the verification code Cognito sent
// to that email, we call confirmSignUp(), and on success navigate to /login.
//
// For invite-acceptance flows specifically: the `?t=<token>` query param is
// preserved from AcceptPage's redirect for breadcrumb purposes — Cognito's
// PostConfirmation Lambda is the one that consumes the invite token
// server-side (it reads the `custom:invite_token` Cognito user attribute
// that was set during signUp, not from URL state). The URL token is just
// here so a refresh of /confirm doesn't lose the chain.
//
// State machine:
//
//   form  ──confirmSignUp()→ success    ──→ navigate /login
//         ──confirmSignUp()→ AuthError  ──→ inline error
//         ──resendSignUpCode() success  ──→ transient "code sent" banner
//         ──resendSignUpCode() error    ──→ inline error
//
// Like every other page in this app, ConfirmPage is auth-provider-agnostic.
// ---------------------------------------------------------------------------

import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link as RouterLink, useNavigate, useSearchParams } from 'react-router';
import { Alert, Box, Link, Stack, TextField, Typography } from '@mui/material';

import { FormattedMessage, useIntl } from 'react-intl';

import { useAuth, authErrorToMessage } from '../../auth';
import { AuthCard } from '@vectros-ai/react';
import { SubmitButton } from '@vectros-ai/react';
import { BRAND } from '../../brand';

/**
 * Loose email-shape check. Not RFC-complete — just enough to reject a bogus
 * `?email=notanemail` so we render the error state instead of echoing the
 * literal junk into the subtitle. React already escapes
 * XSS; this is a UX guard.
 */
function isLikelyEmail(value: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value);
}

/** Error variant — shown when ?email is missing or malformed in the URL. */
function ErrorState(): React.JSX.Element {
  const intl = useIntl();
  return (
    <AuthCard
      brandName={BRAND.productName}
      title={intl.formatMessage({ id: 'confirm.noEmailTitle' })}
      footer={
        <Link component={RouterLink} to="/login" variant="body2">
          <FormattedMessage id="confirm.backToSignIn" />
        </Link>
      }
    >
      <Typography variant="body1">
        <FormattedMessage id="confirm.noEmailBody" />
      </Typography>
    </AuthCard>
  );
}

export function ConfirmPage(): React.JSX.Element {
  const [searchParams] = useSearchParams();
  const email = searchParams.get('email');
  const navigate = useNavigate();
  const { confirmSignUp, resendSignUpCode } = useAuth();
  const intl = useIntl();

  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [resendSuccess, setResendSuccess] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [resending, setResending] = useState(false);

  // Page cannot proceed without a well-formed email — render bail-out.
  if (!email || !isLikelyEmail(email)) {
    return <ErrorState />;
  }

  const handleSubmit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    setError(null);
    setResendSuccess(null);
    setSubmitting(true);
    try {
      await confirmSignUp({ email, code: code.trim() });
      // Confirmation succeeded. Cognito's PostConfirmation Lambda has now
      // fired server-side (where the invite-activation logic runs).
      // The user is NOT auto-signed-in by Cognito after confirmSignUp —
      // they must sign in next.
      navigate('/login');
    } catch (err) {
      setError(authErrorToMessage(intl, err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleResend = async (): Promise<void> => {
    // Guard the click directly. MUI's <Link component="button"> forwards
    // `disabled` to the native <button>, but a disabled button still won't
    // get pointer events in jsdom-style synthetic dispatch — so we also bail
    // here defensively to guarantee a double-click while a resend (or a
    // submit) is in flight can't fire a second request.
    if (resending || submitting) return;
    setError(null);
    setResendSuccess(null);
    setResending(true);
    try {
      await resendSignUpCode({ email });
      setResendSuccess(intl.formatMessage({ id: 'confirm.resentSuccess' }, { email }));
    } catch (err) {
      setError(authErrorToMessage(intl, err));
    } finally {
      setResending(false);
    }
  };

  const codeLabel = intl.formatMessage({ id: 'confirm.codeLabel' });
  return (
    <AuthCard
      brandName={BRAND.productName}
      title={intl.formatMessage({ id: 'confirm.title' })}
      subtitle={intl.formatMessage({ id: 'confirm.subtitle' }, { email })}
      footer={
        <Link component={RouterLink} to="/login" variant="body2">
          <FormattedMessage id="confirm.backToSignIn" />
        </Link>
      }
    >
      <form onSubmit={handleSubmit} noValidate>
        <Stack spacing={2}>
          {error && (
            <Alert severity="error" role="alert">
              {error}
            </Alert>
          )}
          {resendSuccess && (
            <Alert severity="success" role="status">
              {resendSuccess}
            </Alert>
          )}
          <TextField
            label={codeLabel}
            // MUI v7 — `slotProps.htmlInput` is the v7-idiomatic way to
            // pass native-input HTML attributes (vs v5's `inputProps`).
            slotProps={{
              htmlInput: {
                inputMode: 'numeric',
                pattern: '[0-9]*',
                autoComplete: 'one-time-code',
                'aria-label': codeLabel,
              },
            }}
            // The user just clicked the link in their email and is expecting
            // to enter a code immediately — focusing the field is the right UX.
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
            required
            fullWidth
            value={code}
            onChange={(e) => setCode(e.target.value)}
            disabled={submitting}
          />
          <SubmitButton
            type="submit"
            variant="contained"
            size="large"
            fullWidth
            pending={submitting}
            disabled={!code.trim()}
          >
            <FormattedMessage id={submitting ? 'confirm.submitting' : 'confirm.submit'} />
          </SubmitButton>
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 1,
              flexWrap: 'wrap',
            }}
          >
            <Typography variant="body2" color="text.secondary">
              <FormattedMessage id="confirm.resendPrompt" />
            </Typography>
            <Link
              component="button"
              type="button"
              variant="body2"
              onClick={() => void handleResend()}
              disabled={resending || submitting}
              aria-disabled={resending || submitting || undefined}
              aria-busy={resending || undefined}
              sx={{ cursor: 'pointer' }}
            >
              <FormattedMessage id={resending ? 'confirm.resending' : 'confirm.resendButton'} />
            </Link>
          </Box>
        </Stack>
      </form>
    </AuthCard>
  );
}
