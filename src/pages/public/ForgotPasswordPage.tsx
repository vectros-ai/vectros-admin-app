// ---------------------------------------------------------------------------
// ForgotPasswordPage — password reset, two stages + success terminal.
//
// State machine:
//
//   request  ──forgotPassword(email)→         ──→ reset stage
//            ──AuthError→                     ──→ inline error
//
//   reset    ──passwords mismatch→            ──→ inline error (client-side)
//            ──confirmForgotPassword(...)→    ──→ success stage
//            ──AuthError→                     ──→ inline error
//
//   success  ──"Continue to sign in"          ──→ navigate /login
//
// Like LoginPage, this is auth-provider-agnostic — consumes only the
// normalized adapter operations + AuthError codes from src/auth.
// ---------------------------------------------------------------------------

import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link as RouterLink, useNavigate } from 'react-router';
import { Alert, Button, Link, Stack, TextField } from '@mui/material';

import { FormattedMessage, useIntl } from 'react-intl';

import { useAuth, authErrorToMessage } from '../../auth';
import { AuthCard } from '@vectros-ai/react';
import { BRAND } from '../../brand';
import { PasswordField } from '@vectros-ai/react';
import { SubmitButton } from '@vectros-ai/react';

type Stage = 'request' | 'reset' | 'success';

export function ForgotPasswordPage(): React.JSX.Element {
  const { forgotPassword, confirmForgotPassword } = useAuth();
  const navigate = useNavigate();
  const intl = useIntl();

  const [stage, setStage] = useState<Stage>('request');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleRequest = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await forgotPassword({ email: email.trim() });
      setStage('reset');
    } catch (err) {
      setError(authErrorToMessage(intl, err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleReset = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    if (newPassword !== confirmPassword) {
      setError(intl.formatMessage({ id: 'forgotPassword.passwordMismatch' }));
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await confirmForgotPassword({
        email: email.trim(),
        code: code.trim(),
        newPassword,
      });
      // Defense-in-depth: drop the secrets from component state once the reset
      // has succeeded (secrets shouldn't linger in React
      // state past the moment they're needed).
      setNewPassword('');
      setConfirmPassword('');
      setCode('');
      setStage('success');
    } catch (err) {
      setError(authErrorToMessage(intl, err));
    } finally {
      setSubmitting(false);
    }
  };

  const backToSignInLink = (
    <Link component={RouterLink} to="/login" variant="body2">
      <FormattedMessage id="forgotPassword.backToSignIn" />
    </Link>
  );

  if (stage === 'request') {
    return (
      <AuthCard
        brandName={BRAND.productName}
        title={intl.formatMessage({ id: 'forgotPassword.requestTitle' })}
        subtitle={intl.formatMessage({ id: 'forgotPassword.requestSubtitle' })}
        footer={backToSignInLink}
      >
        <form onSubmit={handleRequest} noValidate>
          <Stack spacing={2}>
            {error && (
              <Alert severity="error" role="alert">
                {error}
              </Alert>
            )}
            <TextField
              label={intl.formatMessage({ id: 'login.emailLabel' })}
              type="email"
              autoComplete="email"
              // Mirrors LoginPage rationale — accepted trade-off for auth forms.
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
              required
              fullWidth
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={submitting}
            />
            <SubmitButton
              type="submit"
              variant="contained"
              size="large"
              fullWidth
              pending={submitting}
              disabled={!email.trim()}
            >
              <FormattedMessage
                id={
                  submitting ? 'forgotPassword.requestSubmitting' : 'forgotPassword.requestSubmit'
                }
              />
            </SubmitButton>
          </Stack>
        </form>
      </AuthCard>
    );
  }

  if (stage === 'reset') {
    return (
      <AuthCard
        brandName={BRAND.productName}
        title={intl.formatMessage({ id: 'forgotPassword.resetTitle' })}
        subtitle={intl.formatMessage({ id: 'forgotPassword.resetSubtitle' })}
        footer={backToSignInLink}
      >
        <form onSubmit={handleReset} noValidate>
          <Stack spacing={2}>
            {error && (
              <Alert severity="error" role="alert">
                {error}
              </Alert>
            )}
            <TextField
              label={intl.formatMessage({ id: 'forgotPassword.codeLabel' })}
              // MUI v7 — `slotProps.htmlInput` is the v7-idiomatic way to
              // pass native-input HTML attributes (vs v5's `inputProps`).
              slotProps={{
                htmlInput: {
                  inputMode: 'numeric',
                  pattern: '[0-9]*',
                  autoComplete: 'one-time-code',
                },
              }}
              // User just clicked "Send code" — expecting to enter it next.
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
              required
              fullWidth
              value={code}
              onChange={(e) => setCode(e.target.value)}
              disabled={submitting}
            />
            {/* New password — strength meter ON. Same lazy-loaded
                dictionary as AcceptPage; chunk is shared across the two
                pages so visiting both in one session pays the cost once. */}
            <PasswordField
              label={intl.formatMessage({ id: 'forgotPassword.newPasswordLabel' })}
              autoComplete="new-password"
              required
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              disabled={submitting}
              showStrengthMeter
            />
            {/* Confirmation field — meter OFF (same rationale as
                AcceptPage's confirm field). */}
            <PasswordField
              label={intl.formatMessage({ id: 'forgotPassword.confirmPasswordLabel' })}
              autoComplete="new-password"
              required
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              disabled={submitting}
            />
            <SubmitButton
              type="submit"
              variant="contained"
              size="large"
              fullWidth
              pending={submitting}
              disabled={!code.trim() || !newPassword || !confirmPassword}
            >
              <FormattedMessage
                id={submitting ? 'forgotPassword.resetSubmitting' : 'forgotPassword.resetSubmit'}
              />
            </SubmitButton>
          </Stack>
        </form>
      </AuthCard>
    );
  }

  // success
  return (
    <AuthCard
      brandName={BRAND.productName}
      title={intl.formatMessage({ id: 'forgotPassword.successTitle' })}
      subtitle={intl.formatMessage({ id: 'forgotPassword.successBody' })}
    >
      <Button
        variant="contained"
        size="large"
        fullWidth
        onClick={() => navigate('/login', { replace: true })}
      >
        <FormattedMessage id="forgotPassword.successCta" />
      </Button>
    </AuthCard>
  );
}
