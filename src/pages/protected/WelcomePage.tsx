// ---------------------------------------------------------------------------
// WelcomePage — protected landing page (path: `/`).
//
// Minimal MVP scope: greet the signed-in user, surface enough
// identity info for them to verify activation worked + reference in support
// contacts, and set expectations for the features that come next.
//
// What this page DELIBERATELY DOES NOT DO (yet):
//   - Fetch the user's AccessProfile from the Vectros API. That requires
//     either a custom Cognito attribute set by PostConfirmation OR a new
//     `GET /developer/me`-style endpoint on the developer API. A future
//     update will introduce the right backend abstraction; until then, this page reads
//     only what the Cognito identity itself exposes via useAuth().user.
//   - Member management, API-key management, activity logs. Those land as
//     separate routes later, replacing the "What's next" card.
//
// The page is auth-provider-agnostic — it consumes useAuth().user, which is
// the normalized AuthUser interface from src/auth/types.ts. Swap providers
// without changing this file.
// ---------------------------------------------------------------------------

import { Box, Card, CardContent, Stack, Typography } from '@mui/material';
import { FormattedMessage, useIntl } from 'react-intl';
import type { IntlShape } from 'react-intl';
import { LoadingBlock, MetaList, MetaRow } from '@vectros-ai/react';

import { useAuth } from '../../auth';
import { BRAND } from '../../brand';

function formatFullName(
  intl: IntlShape,
  firstName: string | null,
  lastName: string | null,
): string {
  const parts: string[] = [];
  if (firstName) parts.push(firstName);
  if (lastName) parts.push(lastName);
  return parts.length > 0 ? parts.join(' ') : intl.formatMessage({ id: 'welcome.nameUnknown' });
}

export function WelcomePage(): React.JSX.Element {
  const { user } = useAuth();
  const intl = useIntl();

  // Defensive guard. RequireAuth ensures we only reach this component when a
  // user is loaded — but if a future refactor weakens that, fail soft (a
  // labeled loading affordance, not a bare ellipsis) rather than throwing.
  if (!user) {
    return <LoadingBlock label={intl.formatMessage({ id: 'welcome.loading' })} />;
  }

  return (
    <Stack spacing={4}>
      <Box>
        <Typography variant="h4" component="h1" sx={{ fontWeight: 700 }}>
          {user.firstName ? (
            <FormattedMessage
              id="welcome.headingWithName"
              values={{ firstName: user.firstName }}
            />
          ) : (
            <FormattedMessage id="welcome.heading" />
          )}
        </Typography>
        <Typography variant="body1" color="text.secondary" sx={{ mt: 1 }}>
          <FormattedMessage id="welcome.intro" values={{ productName: BRAND.productName }} />
        </Typography>
      </Box>

      <Card>
        <CardContent>
          <Typography variant="h6" component="h2" sx={{ fontWeight: 700, mb: 2 }}>
            <FormattedMessage id="welcome.accountTitle" />
          </Typography>
          <MetaList>
            <MetaRow label={<FormattedMessage id="welcome.nameLabel" />} labelWidth={120}>
              {formatFullName(intl, user.firstName, user.lastName)}
            </MetaRow>
            <MetaRow label={<FormattedMessage id="welcome.emailLabel" />} labelWidth={120}>
              {user.email}
            </MetaRow>
            <MetaRow label={<FormattedMessage id="welcome.userIdLabel" />} labelWidth={120}>
              {user.sub}
            </MetaRow>
          </MetaList>
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <Typography variant="h6" component="h2" sx={{ fontWeight: 700, mb: 1 }}>
            <FormattedMessage id="welcome.nextStepsTitle" />
          </Typography>
          <Typography variant="body2" color="text.secondary">
            <FormattedMessage id="welcome.nextStepsBody" />
          </Typography>
        </CardContent>
      </Card>
    </Stack>
  );
}
