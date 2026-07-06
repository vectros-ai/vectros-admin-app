// ---------------------------------------------------------------------------
// TenantSwitcher — top-nav control for switching between the tenants the
// signed-in user has access to (the control-plane analogue of the data app's
// ContextSwitcher, at the tenant grain rather than the (tenant, context) grain).
//
// **Shape:** a compact dropdown (MUI Select, standard variant) sitting in the
// AppBar — one option per membership from useCurrentTenant(). For the initial
// shim that's [Live, Test] for everyone; a future backend update swaps the shim
// for a real `authProvider.getMemberships()` lookup with no change here.
//
// (Earlier this was a ToggleButtonGroup. It was replaced with a dropdown: the
// segmented buttons were styled for a dark AppBar and read as a near-invisible
// selected state on the light shell, and a single value display is calmer in a
// dense top nav. The dropdown also matches the data app's switcher for a
// consistent cross-app feel.)
//
// **Visibility:**
//   - initial load / zero memberships → render nothing.
//   - exactly one membership → a static label (nothing to switch between).
//   - two or more → the dropdown.
//
// `setTenant` is a server-side operation (persist + token refresh + refetch), so
// the control disables while a switch is in flight (a second swap can't race the
// first) and surfaces a failure via a toast — the right affordance for a top-nav
// control with no inline space, since the underlying error isn't user-actionable.
// ---------------------------------------------------------------------------

import { useState } from 'react';
import { Alert, FormControl, MenuItem, Select, Snackbar, Typography } from '@mui/material';
import type { SelectChangeEvent } from '@mui/material';
import { useIntl } from 'react-intl';
import type { IntlShape } from 'react-intl';

import { useCurrentTenant } from '../auth';
import type { TenantId, TenantMembership } from '../auth';

/** Label a membership by its tenant KIND (Live/Test) — the axis that actually
 *  distinguishes a user's tenants. The tenant *name* is the same org on both, so
 *  showing it would just repeat one label twice. */
function kindLabel(intl: IntlShape, kind: TenantMembership['tenantKind']): string {
  return intl.formatMessage({
    id: kind === 'live' ? 'layout.tenantKindLive' : 'layout.tenantKindTest',
  });
}

export function TenantSwitcher(): React.JSX.Element | null {
  const { tenant, setTenant, memberships, loading } = useCurrentTenant();
  const intl = useIntl();

  // `switching` disables the control while a switch settles (so a second swap
  // can't race the first); `switchFailed` surfaces a failure (a failed persist /
  // token refresh / refetch would otherwise leave the user with no feedback).
  const [switching, setSwitching] = useState(false);
  const [switchFailed, setSwitchFailed] = useState(false);

  // `loading` is initial-only (a later switch does NOT flip it), so once we're
  // past the initial load the control stays mounted across a switch — `switching`
  // disables it rather than the whole control unmounting and flashing back in.
  if (loading || memberships.length === 0) return null;

  const label = intl.formatMessage({ id: 'layout.tenantSwitcherLabel' });

  // Single membership → a static label; there's nothing to switch between.
  if (memberships.length === 1) {
    const only = memberships[0];
    return (
      <Typography variant="body2" sx={{ color: 'inherit', fontWeight: 600 }} aria-label={label}>
        {only ? kindLabel(intl, only.tenantKind) : ''}
      </Typography>
    );
  }

  const handleChange = (event: SelectChangeEvent): void => {
    const next = event.target.value as TenantId;
    // Select fires onChange only on a real change, but guard anyway: re-selecting
    // the active tenant would needlessly drop the token cache + refetch.
    if (next === tenant || switching) return;
    setSwitchFailed(false);
    setSwitching(true);
    // Await so a failure surfaces; on success the provider re-renders with the new
    // active tenant. On failure the provider leaves `tenant` unchanged, so the
    // dropdown stays visually consistent with the real state.
    void setTenant(next)
      .catch(() => {
        setSwitchFailed(true);
      })
      .finally(() => {
        setSwitching(false);
      });
  };

  return (
    <>
      <FormControl size="small" variant="standard">
        <Select
          value={tenant ?? ''}
          onChange={handleChange}
          variant="standard"
          disabled={switching}
          // aria-label on the combobox so the control is reachable without a
          // visible <label> in the dense AppBar (WCAG 4.1.2).
          inputProps={{ 'aria-label': label }}
          sx={{
            color: 'inherit',
            fontWeight: 600,
            '& .MuiSelect-icon': { color: 'inherit' },
          }}
        >
          {memberships.map((m) => (
            <MenuItem key={m.tenantId} value={m.tenantId}>
              {kindLabel(intl, m.tenantKind)}
            </MenuItem>
          ))}
        </Select>
      </FormControl>
      <Snackbar
        open={switchFailed}
        autoHideDuration={6000}
        onClose={() => setSwitchFailed(false)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        {/* Alert (not the bare Snackbar message) so the failure carries
            role="alert" + is announced; the message names the switch action
            since the underlying error isn't user-actionable. */}
        <Alert severity="error" onClose={() => setSwitchFailed(false)}>
          {intl.formatMessage({ id: 'layout.tenantSwitchError' })}
        </Alert>
      </Snackbar>
    </>
  );
}
