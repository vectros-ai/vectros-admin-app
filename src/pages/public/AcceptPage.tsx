// ---------------------------------------------------------------------------
// AcceptPage — sub-user invitation acceptance.
//
// The driver of the invitation-acceptance flow end-to-end:
//
//   1. Invitee clicks the link in their email.
//   2. This page decodes the invite token (CLIENT-SIDE, UX ONLY — see
//      src/invitations/token.ts header for the trust-boundary explanation).
//   3. Renders a signup form with the email PRE-FILLED + LOCKED to the token's
//      email claim (prevents a spectator who got the link from signing up
//      under a different identity).
//   4. Submit calls useAuth().signUp({ ..., metadata: { invite_token } }).
//      The CognitoAuthProvider translates metadata.invite_token →
//      a custom:invite_token Cognito user attribute.
//   5. A server-side PostConfirmation hook fires on email-confirmation,
//      cryptographically verifies the token, and activates the membership.
//
// The page consumes useAuth()'s embedded-credential methods (signUp, the
// normalized SignUpResult union) + useCurrentTenant()'s linkInvitation
// pass-through. This flow is Cognito/embedded-specific by construction — a
// hosted-redirect (Auth0 Universal Login) provider wouldn't use this page at
// all: invite acceptance there passes `invite_token` directly on the
// `/v1/auth/token/exchange` call instead (TOKEN-EXCHANGE-CONTRACT.md §6), no
// signup form needed. admin-app is always Cognito, so this page stays as-is.
// ---------------------------------------------------------------------------

import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link as RouterLink, useNavigate, useSearchParams } from 'react-router';
import { Alert, Button, Link, Stack, TextField, Typography } from '@mui/material';

import { FormattedMessage, useIntl } from 'react-intl';
import type { IntlShape } from 'react-intl';

import { useAuth, useCurrentTenant, authErrorToMessage } from '../../auth';
import type { SignUpResult } from '../../auth';
import { AuthCard } from '@vectros-ai/react';
import { LoadingBlock } from '@vectros-ai/react';
import { PasswordField } from '@vectros-ai/react';
import { SubmitButton } from '@vectros-ai/react';
import { BRAND } from '../../brand';
import { decodeInviteToken } from '../../invitations/token';
import type { InviteTokenClaims, InviteTokenDecodeResult } from '../../invitations/token';

function welcomeSubtitle(intl: IntlShape, claims: InviteTokenClaims): string {
  if (claims.inviterName && claims.orgName) {
    return intl.formatMessage(
      { id: 'accept.invitedByAndOrg' },
      { inviter: claims.inviterName, org: claims.orgName },
    );
  }
  if (claims.orgName) {
    return intl.formatMessage({ id: 'accept.invitedToOrg' }, { org: claims.orgName });
  }
  if (claims.inviterName) {
    return intl.formatMessage({ id: 'accept.invitedByInviter' }, { inviter: claims.inviterName });
  }
  return intl.formatMessage({ id: 'accept.subtitleGeneric' }, { productName: BRAND.productName });
}

/**
 * Display the error variant of the page (no token, malformed, expired).
 * Centralized so all four "this won't work" cases share visual structure.
 */
function ErrorState({ message }: { readonly message: string }): React.JSX.Element {
  const intl = useIntl();
  return (
    <AuthCard
      brandName={BRAND.productName}
      title={intl.formatMessage({ id: 'accept.titleError' })}
      footer={
        <Link component={RouterLink} to="/login" variant="body2">
          <FormattedMessage id="accept.backToSignIn" />
        </Link>
      }
    >
      <Typography variant="body1">{message}</Typography>
    </AuthCard>
  );
}

/**
 * Existing-identity AUTO-LINK branch (§6.3.2 case 4a): the invitee is already
 * signed in AS the invited email. Instead of a doomed signUp (Cognito would
 * 409 on the duplicate email), link the pending membership to their current
 * identity via the provider's linkInvitation(). On success a full reload lands
 * them in the app with the new membership in their TenantSwitcher.
 */
function AutoLinkCard({
  inviteToken,
  claims,
}: {
  readonly inviteToken: string;
  readonly claims: InviteTokenClaims;
}): React.JSX.Element {
  const intl = useIntl();
  const { user } = useAuth();
  const { linkInvitation } = useCurrentTenant();
  const [status, setStatus] = useState<'idle' | 'linking' | 'done'>('idle');
  const [error, setError] = useState<string | null>(null);

  const handleLink = async (): Promise<void> => {
    setError(null);
    setStatus('linking');
    try {
      await linkInvitation(inviteToken);
      setStatus('done');
    } catch (err) {
      setError(authErrorToMessage(intl, err));
      setStatus('idle');
    }
  };

  if (status === 'done') {
    return (
      <AuthCard
        brandName={BRAND.productName}
        title={intl.formatMessage({ id: 'accept.autoLinkSuccessTitle' })}
      >
        <Stack spacing={2}>
          <Typography variant="body1">
            <FormattedMessage id="accept.autoLinkSuccessBody" />
          </Typography>
          {/* Full reload (not SPA nav) so the already-mounted CurrentTenantProvider
              re-fetches memberships and the newly-linked tenant appears. */}
          <Button
            variant="contained"
            size="large"
            fullWidth
            onClick={() => window.location.assign('/')}
          >
            <FormattedMessage
              id="accept.autoLinkGoToApp"
              values={{ productName: BRAND.productName }}
            />
          </Button>
        </Stack>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      brandName={BRAND.productName}
      title={intl.formatMessage({ id: 'accept.autoLinkTitle' })}
      subtitle={welcomeSubtitle(intl, claims)}
      footer={
        <Link component={RouterLink} to="/" variant="body2">
          <FormattedMessage id="accept.autoLinkCancel" />
        </Link>
      }
    >
      <Stack spacing={2}>
        {error && (
          <Alert severity="error" role="alert">
            {error}
          </Alert>
        )}
        <Typography variant="body1">
          <FormattedMessage
            id="accept.autoLinkBody"
            values={{ email: user?.email ?? claims.email }}
          />
        </Typography>
        <SubmitButton
          variant="contained"
          size="large"
          fullWidth
          onClick={() => void handleLink()}
          pending={status === 'linking'}
        >
          <FormattedMessage
            id={status === 'linking' ? 'accept.autoLinkAdding' : 'accept.autoLinkCta'}
          />
        </SubmitButton>
      </Stack>
    </AuthCard>
  );
}

/**
 * Wrong-identity branch (§6.3.2 case 4c): signed in as someone OTHER than the
 * invited email. Never link the invite to the wrong account — ask them to sign
 * out + reopen the link (which then falls through to signup / sign-in-to-link).
 */
function DifferentIdentityCard({
  inviteEmail,
  sessionEmail,
}: {
  readonly inviteEmail: string;
  readonly sessionEmail: string;
}): React.JSX.Element {
  const intl = useIntl();
  const { signOut } = useAuth();
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSignOut = async (): Promise<void> => {
    setError(null);
    setSigningOut(true);
    try {
      await signOut();
      // Full reload re-runs the accept flow from a signed-out state.
      window.location.reload();
    } catch (err) {
      // Surface the failure rather than silently swallowing it — without
      // feedback the user clicks an apparently-dead button and is stuck on the
      // wrong identity. Keep them on this card so they can retry.
      // authErrorToMessage maps non-AuthError throwables to the generic
      // `auth.errors.UNKNOWN` copy, so this is always a non-empty message.
      setError(authErrorToMessage(intl, err));
      setSigningOut(false);
    }
  };

  return (
    <AuthCard
      brandName={BRAND.productName}
      title={intl.formatMessage({ id: 'accept.differentIdentityTitle' })}
      footer={
        <Link component={RouterLink} to="/login" variant="body2">
          <FormattedMessage id="accept.backToSignIn" />
        </Link>
      }
    >
      <Stack spacing={2}>
        {error && (
          <Alert severity="error" role="alert">
            {error}
          </Alert>
        )}
        <Typography variant="body1">
          <FormattedMessage
            id="accept.differentIdentityBody"
            values={{ inviteEmail, sessionEmail }}
          />
        </Typography>
        <SubmitButton
          variant="contained"
          size="large"
          fullWidth
          onClick={() => void handleSignOut()}
          pending={signingOut}
        >
          <FormattedMessage id="accept.differentIdentitySignOut" />
        </SubmitButton>
      </Stack>
    </AuthCard>
  );
}

export function AcceptPage(): React.JSX.Element {
  const [searchParams] = useSearchParams();
  const rawToken = searchParams.get('t');
  const navigate = useNavigate();
  const { signUp, user } = useAuth();
  const intl = useIntl();

  // Token decode is async — the decoder cryptographically
  // verifies the signature against the platform's JWKS, which requires a
  // network fetch + Web Crypto API ECDSA op. We start in 'PENDING' while
  // the verify is in flight, then transition to the resolved result. The
  // brief PENDING window is masked by a quiet loading state — typical
  // verify latency is <100ms with JWKS warm-cached.
  const [decoded, setDecoded] = useState<InviteTokenDecodeResult | 'PENDING' | null>(
    rawToken ? 'PENDING' : null,
  );

  useEffect(() => {
    if (!rawToken) {
      setDecoded(null);
      return undefined;
    }
    let cancelled = false;
    setDecoded('PENDING');
    void decodeInviteToken(rawToken).then((result) => {
      if (!cancelled) setDecoded(result);
    });
    return (): void => {
      cancelled = true;
    };
  }, [rawToken]);

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // ---- Loading + error states — render and bail ----

  if (!rawToken) {
    return <ErrorState message={intl.formatMessage({ id: 'accept.errorNoToken' })} />;
  }
  if (decoded === 'PENDING' || decoded === null) {
    // Loading state — the JWKS-backed token verify is in flight. A labeled
    // LoadingBlock announces the in-progress work to assistive technology
    // (the prior text-only card was silent to a screen reader). The typical
    // case is <100ms with JWKS warm-cached.
    return (
      <AuthCard
        brandName={BRAND.productName}
        title={intl.formatMessage({ id: 'accept.verifyingTitle' })}
      >
        <Stack spacing={2}>
          <Typography variant="body1" color="text.secondary">
            <FormattedMessage id="accept.verifyingSubtitle" />
          </Typography>
          <LoadingBlock label={intl.formatMessage({ id: 'accept.verifyingTitle' })} />
        </Stack>
      </AuthCard>
    );
  }
  if (decoded.kind === 'MALFORMED' || decoded.kind === 'INVALID_ISSUER') {
    return <ErrorState message={intl.formatMessage({ id: 'accept.errorMalformed' })} />;
  }
  if (decoded.kind === 'EXPIRED') {
    return <ErrorState message={intl.formatMessage({ id: 'accept.errorExpired' })} />;
  }
  if (decoded.kind === 'NOT_YET_VALID') {
    return <ErrorState message={intl.formatMessage({ id: 'accept.errorNotYetValid' })} />;
  }
  if (decoded.kind === 'INVALID_SIGNATURE') {
    // Specific copy — this is the "tampered token" signal. Same recovery
    // path as MALFORMED (ask the inviter to resend) but distinct
    // diagnostic in case operators ever need to differentiate from
    // CloudFront/access logs.
    return <ErrorState message={intl.formatMessage({ id: 'accept.errorInvalidSignature' })} />;
  }
  if (decoded.kind === 'JWKS_UNAVAILABLE') {
    return <ErrorState message={intl.formatMessage({ id: 'accept.errorJwksUnavailable' })} />;
  }

  // ---- VALID token ----

  const { claims } = decoded;

  // Existing-identity pivot (shared-cognito-pool-ambiguity.md §6.3.2). If the
  // invitee is already signed in:
  //   - as the invited email → auto-link this membership (a signUp would 409).
  //   - as a DIFFERENT email → sign-out-and-retry (identity-confusion guard).
  // Not signed in → fall through to the first-time signup form below. (A "sign
  // in to link" path for an existing-but-not-current identity needs a backend
  // existence probe we don't expose; it degrades to signup, which surfaces a
  // clear "already exists" error if the email is taken.)
  if (user) {
    if (user.email.toLowerCase() === claims.email.toLowerCase()) {
      return <AutoLinkCard inviteToken={rawToken} claims={claims} />;
    }
    return <DifferentIdentityCard inviteEmail={claims.email} sessionEmail={user.email} />;
  }

  // ---- Not signed in: first-time signup form ----

  const handleSubmit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    if (password !== confirmPassword) {
      setError(intl.formatMessage({ id: 'accept.passwordMismatch' }));
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      // Build the metadata bag. `invite_token` is always present (the
      // PostConfirmation Lambda KMS-verifies it server-side). `uuid` is
      // seeded from the token's `sub` claim — this carries the pre-created
      // backend user-record id and gives the new Cognito user a `custom:uuid`
      // attribute matching the dev-portal's SPA-seeds-UUID-at-signup
      // pattern. The developer-API scoped-token endpoint
      // (`/developer/scoped-token`) resolves this UUID back to the backend
      // user record + bound AccessProfile to mint a properly-scoped st_*.
      //
      // Defensive nullability: tokens minted before the backend
      // started emitting `sub` (rollout-window only) lack
      // the claim — the decoder normalizes those to `claims.sub = null`.
      // We omit `uuid` from the metadata bag in that case, leaving the
      // sub-user without `custom:uuid`. They still complete signup
      // successfully; only the developer-API access path is degraded for
      // that legacy population. New invites converge to zero quickly.
      const metadata: Record<string, string> = { invite_token: rawToken };
      if (claims.sub) {
        metadata['uuid'] = claims.sub;
      }
      const result: SignUpResult = await signUp({
        email: claims.email,
        password,
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        // The adapter translates `invite_token` → `custom:invite_token` and
        // `uuid` → `custom:uuid` for Cognito (see CognitoAuthProvider.signUp's
        // generic metadata → custom:<key> translation). Provider-agnostic.
        metadata,
      });
      // Defense-in-depth: drop the password fields from component state once
      // signUp has succeeded (known-followups §3 — secrets shouldn't linger in
      // React state past the moment they're needed).
      setPassword('');
      setConfirmPassword('');
      if (result.kind === 'CONFIRMATION_REQUIRED') {
        const params = new URLSearchParams();
        params.set('email', claims.email);
        params.set('t', rawToken);
        navigate(`/confirm?${params.toString()}`);
      } else {
        navigate('/login');
      }
    } catch (err) {
      setError(authErrorToMessage(intl, err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthCard
      brandName={BRAND.productName}
      title={intl.formatMessage({ id: 'accept.titleWelcome' })}
      subtitle={welcomeSubtitle(intl, claims)}
      footer={
        <Link component={RouterLink} to="/login" variant="body2">
          <FormattedMessage id="accept.backToSignIn" />
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
          <TextField
            label={intl.formatMessage({ id: 'login.emailLabel' })}
            type="email"
            autoComplete="email"
            value={claims.email}
            disabled
            // Locked email — invariant A from sub-user-invitations §11.2.
            // The signup proceeds against the token's email claim, not
            // whatever the user might type. `disabled` covers both the
            // visual + interaction lock; aria-readonly clarifies for AT.
            // MUI v7 — `slotProps.htmlInput` passes native HTML attributes
            // through to the underlying <input> (vs v5's `inputProps`).
            slotProps={{ htmlInput: { 'aria-readonly': true, readOnly: true } }}
            helperText={intl.formatMessage({ id: 'accept.emailHelper' })}
            fullWidth
          />
          <TextField
            label={intl.formatMessage({ id: 'accept.firstNameLabel' })}
            autoComplete="given-name"
            required
            fullWidth
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
            disabled={submitting}
            // Form is freshly mounted; focusing the first editable field is
            // standard signup UX. Same accepted trade-off as LoginPage.
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
          />
          <TextField
            label={intl.formatMessage({ id: 'accept.lastNameLabel' })}
            autoComplete="family-name"
            required
            fullWidth
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
            disabled={submitting}
          />
          {/* New password — strength meter ON (zxcvbn-ts engages here;
              dictionary lazy-loads only on this page). */}
          <PasswordField
            label={intl.formatMessage({ id: 'accept.passwordLabel' })}
            autoComplete="new-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={submitting}
            showStrengthMeter
          />
          {/* Confirmation field — meter OFF; the meter on the field above
              already shows strength, repeating it on the confirm field
              would be visual noise + double-load the chunk. */}
          <PasswordField
            label={intl.formatMessage({ id: 'accept.confirmPasswordLabel' })}
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
            disabled={!firstName.trim() || !lastName.trim() || !password || !confirmPassword}
          >
            <FormattedMessage id={submitting ? 'accept.submitting' : 'accept.submit'} />
          </SubmitButton>
        </Stack>
      </form>
    </AuthCard>
  );
}
