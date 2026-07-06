// ---------------------------------------------------------------------------
// LoginPage — sign in with email + password, with MFA support.
//
// State machine:
//
//   credentials  ──signIn()→ COMPLETE              ──→ navigate(from || '/')
//                ─signIn()→ MFA_REQUIRED           ──→ mfa stage
//                ─signIn()→ CONFIRMATION_REQUIRED  ──→ navigate /confirm
//                ─signIn()→ NEW_PASSWORD_REQUIRED  ──→ inline error
//                ─signIn()→ AuthError              ──→ inline error
//
//   mfa          ──confirmSignIn()→ COMPLETE       ──→ navigate(from || '/')
//                ─confirmSignIn()→ AuthError       ──→ inline error
//                ─"back to sign in"                ──→ credentials stage
//
// The page is auth-provider-agnostic — it consumes only useAuth() + the
// normalized SignInResult union from src/auth/types.ts + the AuthError code
// from src/auth/errors.ts. Swap CognitoAuthProvider for Auth0AuthProvider
// without touching this file.
// ---------------------------------------------------------------------------

import { useState } from 'react';
import type { FormEvent } from 'react';
import { useLocation, useNavigate, Link as RouterLink } from 'react-router';
import { Alert, Link, Stack, TextField } from '@mui/material';
import { FormattedMessage, useIntl } from 'react-intl';
import type { IntlShape } from 'react-intl';

import { useAuth, authErrorToMessage } from '../../auth';
import type { MfaMethod, SignInResult, TotpSetupDetails } from '../../auth';
import { AuthCard } from '@vectros-ai/react';
import { PasswordField } from '@vectros-ai/react';
import { SubmitButton } from '@vectros-ai/react';
import { TotpEnrollmentWizard } from '@vectros-ai/react';
import { BRAND } from '../../brand';
import type { LocationFromState } from '../../lib/routerTypes';

type Stage =
  | { readonly kind: 'credentials' }
  | { readonly kind: 'mfa'; readonly methods: ReadonlyArray<MfaMethod> }
  // Forced TOTP enrollment at login. Rendered INLINE — never a redirect
  // to /account, which would loop (no session yet). Does not occur under the
  // current OPTIONAL pool config; handled for correctness if it ever goes REQUIRED.
  | { readonly kind: 'totpSetup'; readonly setup: TotpSetupDetails };

function mfaSubtitle(intl: IntlShape, methods: ReadonlyArray<MfaMethod>): string {
  if (methods.includes('TOTP')) return intl.formatMessage({ id: 'login.mfaSubtitleTotp' });
  if (methods.includes('SMS')) return intl.formatMessage({ id: 'login.mfaSubtitleSms' });
  if (methods.includes('EMAIL')) return intl.formatMessage({ id: 'login.mfaSubtitleEmail' });
  return intl.formatMessage({ id: 'login.mfaSubtitleGeneric' });
}

export function LoginPage(): React.JSX.Element {
  const { signIn, confirmSignIn } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const intl = useIntl();

  const fromState = location.state as LocationFromState | null;
  const fromPath = fromState?.from?.pathname ?? '/';

  const [stage, setStage] = useState<Stage>({ kind: 'credentials' });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mfaCode, setMfaCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const dispatchResult = (result: SignInResult): void => {
    switch (result.kind) {
      case 'COMPLETE':
        navigate(fromPath, { replace: true });
        return;
      case 'MFA_REQUIRED':
        setStage({ kind: 'mfa', methods: result.methods });
        setMfaCode('');
        setError(null);
        return;
      case 'TOTP_SETUP_REQUIRED':
        setStage({ kind: 'totpSetup', setup: result.setup });
        setError(null);
        return;
      case 'CONFIRMATION_REQUIRED':
        navigate(`/confirm?email=${encodeURIComponent(email.trim())}`);
        return;
      case 'NEW_PASSWORD_REQUIRED':
        setError(intl.formatMessage({ id: 'login.newPasswordRequired' }));
        return;
    }
  };

  const handleCredentialsSubmit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const result = await signIn({ email: email.trim(), password });
      dispatchResult(result);
    } catch (err) {
      setError(authErrorToMessage(intl, err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleMfaSubmit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const result = await confirmSignIn({ challengeResponse: mfaCode.trim() });
      dispatchResult(result);
    } catch (err) {
      setError(authErrorToMessage(intl, err));
    } finally {
      setSubmitting(false);
    }
  };

  // Forced-setup-at-login: the wizard supplies the code; we complete the
  // in-flight sign-in via confirmSignIn (NOT a separate verifyTotpSetup — that's
  // the authenticated /account path). Loop-free because we never leave /login.
  const handleTotpSetupVerify = async (code: string): Promise<void> => {
    setError(null);
    setSubmitting(true);
    try {
      const result = await confirmSignIn({ challengeResponse: code });
      dispatchResult(result);
    } catch (err) {
      setError(authErrorToMessage(intl, err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleBackToSignIn = (): void => {
    setStage({ kind: 'credentials' });
    setMfaCode('');
    setError(null);
  };

  if (stage.kind === 'totpSetup') {
    return (
      <AuthCard
        brandName={BRAND.productName}
        title={intl.formatMessage({ id: 'login.mfaSetupTitle' })}
        subtitle={intl.formatMessage({ id: 'login.mfaSetupSubtitle' })}
        footer={
          <Link component="button" type="button" variant="body2" onClick={handleBackToSignIn}>
            <FormattedMessage id="login.backToSignIn" />
          </Link>
        }
      >
        <TotpEnrollmentWizard
          secret={stage.setup.secret}
          otpauthUri={stage.setup.otpauthUri}
          onVerify={(code) => void handleTotpSetupVerify(code)}
          pending={submitting}
          error={error}
        />
      </AuthCard>
    );
  }

  if (stage.kind === 'credentials') {
    return (
      <AuthCard
        brandName={BRAND.productName}
        title={intl.formatMessage({ id: 'login.title' })}
        subtitle={intl.formatMessage({ id: 'login.subtitle' }, { productName: BRAND.productName })}
        footer={
          <Link component={RouterLink} to="/forgot-password" variant="body2">
            <FormattedMessage id="login.forgotPassword" />
          </Link>
        }
      >
        <form onSubmit={handleCredentialsSubmit} noValidate>
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
              // Auto-focus is the established UX expectation for sign-in
              // forms (every major identity provider does this). The a11y
              // trade-off is well-understood and accepted for this surface.
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
              required
              fullWidth
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={submitting}
            />
            <PasswordField
              label={intl.formatMessage({ id: 'login.passwordLabel' })}
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={submitting}
            />
            <SubmitButton
              type="submit"
              variant="contained"
              size="large"
              fullWidth
              pending={submitting}
              disabled={!email.trim() || !password}
            >
              <FormattedMessage id={submitting ? 'login.submitting' : 'login.submit'} />
            </SubmitButton>
          </Stack>
        </form>
      </AuthCard>
    );
  }

  // MFA stage
  const mfaCodeLabel = intl.formatMessage({ id: 'login.mfaCodeLabel' });
  return (
    <AuthCard
      brandName={BRAND.productName}
      title={intl.formatMessage({ id: 'login.mfaTitle' })}
      subtitle={mfaSubtitle(intl, stage.methods)}
      footer={
        <Link component="button" type="button" variant="body2" onClick={handleBackToSignIn}>
          <FormattedMessage id="login.backToSignIn" />
        </Link>
      }
    >
      <form onSubmit={handleMfaSubmit} noValidate>
        <Stack spacing={2}>
          {error && (
            <Alert severity="error" role="alert">
              {error}
            </Alert>
          )}
          <TextField
            label={mfaCodeLabel}
            // MUI v7 — pass native-input HTML attributes through the
            // `slotProps.htmlInput` slot. The v5 `inputProps` shim still
            // accepts these, but slotProps is the v7-idiomatic shape.
            slotProps={{
              htmlInput: {
                inputMode: 'numeric',
                pattern: '[0-9]*',
                autoComplete: 'one-time-code',
                'aria-label': mfaCodeLabel,
              },
            }}
            // The user just submitted credentials and is expecting to type a
            // code immediately — focusing the code field is the right UX.
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
            required
            fullWidth
            value={mfaCode}
            onChange={(e) => setMfaCode(e.target.value)}
            disabled={submitting}
          />
          <SubmitButton
            type="submit"
            variant="contained"
            size="large"
            fullWidth
            pending={submitting}
            disabled={!mfaCode.trim()}
          >
            <FormattedMessage id={submitting ? 'login.mfaSubmitting' : 'login.mfaSubmit'} />
          </SubmitButton>
        </Stack>
      </form>
    </AuthCard>
  );
}
