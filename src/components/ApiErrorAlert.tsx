// ---------------------------------------------------------------------------
// ApiErrorAlert — a friendly error message plus the support reference.
//
// Wraps an MUI error Alert with two things every API-error surface should have
// but most hand-rolled alerts skipped:
//   - `role="alert"` so the message is announced when it appears (MUI's Alert
//     has NO implicit ARIA role),
//   - the `requestId` correlation id (when the error carries one) as a small
//     reference line, so a user filing a support ticket can quote it.
//
// The friendly copy is the host's responsibility — pass it as children (usually
// a <FormattedMessage>). The reference line's own label is localized here.
// ---------------------------------------------------------------------------

import type { ReactNode } from 'react';
import { Alert } from '@mui/material';
import type { AlertProps } from '@mui/material';

import { RequestIdCaption } from './RequestIdCaption';

export interface ApiErrorAlertProps {
  /** The error thrown by the failed SDK call (its requestId is surfaced if present). */
  readonly error: unknown;
  /** The friendly, localized message (typically a <FormattedMessage>). */
  readonly children: ReactNode;
  /** Alert severity. Defaults to "error". */
  readonly severity?: AlertProps['severity'];
  /** Forwarded to the Alert (e.g. an `action`). */
  readonly action?: AlertProps['action'];
  /** Forwarded to the Alert root sx. */
  readonly sx?: AlertProps['sx'];
}

/**
 * An accessible error Alert that surfaces the friendly message and, when the
 * error carries one, the `requestId` for support correlation.
 */
export function ApiErrorAlert({
  error,
  children,
  severity = 'error',
  action,
  sx,
}: ApiErrorAlertProps): React.JSX.Element {
  return (
    <Alert severity={severity} role="alert" {...(action ? { action } : {})} {...(sx ? { sx } : {})}>
      {children}
      <RequestIdCaption error={error} />
    </Alert>
  );
}
