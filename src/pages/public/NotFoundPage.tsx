// ---------------------------------------------------------------------------
// NotFoundPage — the catch-all 404.
//
// Replaces the old `*` → Navigate("/") redirect, which silently swallowed bad
// URLs. A dedicated 404 is the right reference-app behavior: it tells the user
// the route doesn't exist and offers a way home. Chrome-less (no AppLayout /
// RequireAuth) so it renders for signed-in AND signed-out users alike; the
// "back home" link lands at `/` (which RequireAuth funnels to /login if the
// user has no session).
// ---------------------------------------------------------------------------

import { Link as RouterLink } from 'react-router';
import { Link, Typography } from '@mui/material';
import { FormattedMessage, useIntl } from 'react-intl';

import { AuthCard } from '@vectros-ai/react';
import { BRAND } from '../../brand';

export function NotFoundPage(): React.JSX.Element {
  const intl = useIntl();
  return (
    <AuthCard
      brandName={BRAND.productName}
      title={intl.formatMessage({ id: 'notFound.title' })}
      footer={
        <Link component={RouterLink} to="/" variant="body2">
          <FormattedMessage id="notFound.backHome" />
        </Link>
      }
    >
      <Typography variant="body1">
        <FormattedMessage id="notFound.body" />
      </Typography>
    </AuthCard>
  );
}
