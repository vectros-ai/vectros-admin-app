// ---------------------------------------------------------------------------
// RequestIdCaption — the support-reference line.
//
// Renders "Reference ID: <id>" when a failed SDK call carries a `requestId`,
// else nothing. Factored out so the same correlation id can be shown both in a
// standalone {@link ApiErrorAlert} and inside another container (e.g. a
// ConfirmDialog's in-dialog error slot) without duplicating the extract logic.
// ---------------------------------------------------------------------------

import { Typography } from '@mui/material';
import { FormattedMessage } from 'react-intl';

import { extractRequestId } from '../lib/apiError';

export interface RequestIdCaptionProps {
  /** The error thrown by the failed SDK call. */
  readonly error: unknown;
}

/** A small monospace caption with the error's support reference id, or null. */
export function RequestIdCaption({ error }: RequestIdCaptionProps): React.JSX.Element | null {
  const requestId = extractRequestId(error);
  if (requestId === undefined) return null;
  return (
    <Typography
      variant="caption"
      component="p"
      sx={{ mt: 0.5, opacity: 0.85, fontFamily: 'monospace' }}
    >
      <FormattedMessage id="error.requestId" values={{ requestId }} />
    </Typography>
  );
}
