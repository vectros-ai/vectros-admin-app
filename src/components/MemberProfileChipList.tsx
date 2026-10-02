// ---------------------------------------------------------------------------
// MemberProfileChipList — renders a member's AccessProfiles as one chip per
// app context, each linking to that context's profile editor. Shared between
// MembersPage's list column and MemberDetailPage's own profiles panel so the
// "reserved control-plane context can't be opened from here" special case
// lives in exactly one place.
// ---------------------------------------------------------------------------

import { Chip, Stack, Tooltip, Typography } from '@mui/material';
import { Link as RouterLink } from 'react-router';
import { FormattedMessage, useIntl } from 'react-intl';

import type { AccessProfileResponse } from '../api/vectrosApi';
import { RESERVED_VECTROS_ADMIN_CONTEXT_ID } from '../lib/reservedContexts';
import type { MemberProfilesResult } from '../lib/useMemberProfiles';

export function MemberProfileChipList({
  result,
}: {
  readonly result: MemberProfilesResult;
}): React.JSX.Element {
  const intl = useIntl();

  if (result === undefined) {
    return (
      <Typography variant="caption" color="text.secondary">
        <FormattedMessage id="members.profileLoading" />
      </Typography>
    );
  }
  if (result === 'error') {
    return (
      <Typography variant="body2" color="error">
        <FormattedMessage id="members.profileError" />
      </Typography>
    );
  }
  if (result === 'unavailable') {
    return (
      <Typography variant="body2" color="text.secondary">
        <FormattedMessage id="members.profileCrossContextUnavailable" />
      </Typography>
    );
  }
  if (result.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary">
        <FormattedMessage id="members.profileNone" />
      </Typography>
    );
  }

  return (
    <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
      {result.map((p: AccessProfileResponse) => {
        // The reserved control-plane context can hold a profile (bound via a scoped key) that
        // this app can never mint a bearer for — see MembersPage's own header comment for why.
        // Show it, but not as a dead link.
        const isReserved = p.contextId === RESERVED_VECTROS_ADMIN_CONTEXT_ID;
        const key = p.id ?? `${p.contextId ?? ''}-${p.principalId ?? ''}`;
        return isReserved ? (
          <Tooltip key={key} title={intl.formatMessage({ id: 'members.profileContextReserved' })}>
            <Chip size="small" variant="outlined" label={p.contextId} sx={{ fontFamily: 'monospace' }} />
          </Tooltip>
        ) : (
          <Chip
            key={key}
            component={RouterLink}
            to={`/access/contexts/${p.contextId}/profiles/${encodeURIComponent(p.principalId ?? '')}`}
            clickable
            size="small"
            label={p.contextId}
            sx={{ fontFamily: 'monospace' }}
          />
        );
      })}
    </Stack>
  );
}
