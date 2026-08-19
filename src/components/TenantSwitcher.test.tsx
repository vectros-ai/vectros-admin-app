// ---------------------------------------------------------------------------
// TenantSwitcher tests (real memberships).
//
// Pinning:
//   1. A dropdown with one option per membership (labelled by ENV — Live/Test —
//      NOT the org name; both memberships share the org name on purpose so the
//      assertions prove the kind is what's rendered).
//   2. The active tenant is shown as the selected value.
//   3. Selecting an option switches the active tenant (persists via the adapter).
//   4. Re-selecting the active tenant does NOT fire a switch.
//   5. Single-membership user → a static label (no dropdown).
//   6. The combobox ARIA label.
//   7. Switch lifecycle: disabled while in flight; a failure toast keeps the
//      prior tenant and re-enables the control for a retry.
// ---------------------------------------------------------------------------

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuthProvider } from '../auth';
import { CurrentTenantProvider } from '../auth';
import type { TenantMembership, VectrosTenancyProvider } from '../auth';
import { makeMockAuthProvider } from '../test/mockAuthProvider';
import { TestIntlProvider } from '../test/intl';
import { TenantSwitcher } from './TenantSwitcher';

// Both memberships share the org name on purpose — the same org has a live and
// a test tenant. So an assertion for "Live"/"Test" can only pass if the switcher
// renders the tenant KIND, not the (identical) name.
const LIVE: TenantMembership = {
  tenantId: 'tnt_live',
  tenantName: 'Acme Org',
  tenantKind: 'live',
  role: 'OWNER',
  status: 'ACTIVE',
  partnerId: 'p1',
};
const TEST: TenantMembership = {
  tenantId: 'tnt_test',
  tenantName: 'Acme Org',
  tenantKind: 'test',
  role: 'OWNER',
  status: 'ACTIVE',
  partnerId: 'p1',
};

function renderSwitcher(
  opts: {
    tenant?: string;
    memberships?: ReadonlyArray<TenantMembership>;
    setActiveTenant?: VectrosTenancyProvider['setActiveTenant'];
  } = {},
) {
  const adapter = makeMockAuthProvider(
    opts.setActiveTenant ? { setActiveTenant: opts.setActiveTenant } : {},
  );
  return render(
    <TestIntlProvider>
      <AuthProvider provider={adapter}>
        <CurrentTenantProvider
          tenancyProvider={adapter}
          initialTenant={opts.tenant ?? 'tnt_test'}
          initialMemberships={opts.memberships ?? [LIVE, TEST]}
        >
          <TenantSwitcher />
        </CurrentTenantProvider>
      </AuthProvider>
    </TestIntlProvider>,
  );
}

/** Open the dropdown and return its option elements. */
async function openOptions(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('combobox', { name: /Switch tenant/i }));
  const listbox = await screen.findByRole('listbox');
  return listbox;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TenantSwitcher', () => {
  it('renders a dropdown with one option per membership', async () => {
    const user = userEvent.setup();
    renderSwitcher();
    const listbox = await openOptions(user);
    expect(within(listbox).getByRole('option', { name: 'Live' })).toBeInTheDocument();
    expect(within(listbox).getByRole('option', { name: 'Test' })).toBeInTheDocument();
  });

  it('shows the active tenant as the selected value', () => {
    renderSwitcher({ tenant: 'tnt_test' });
    expect(screen.getByRole('combobox', { name: /Switch tenant/i })).toHaveTextContent('Test');
  });

  it('switches the active tenant on selection (persists via the adapter)', async () => {
    const user = userEvent.setup();
    const setActiveTenant = vi.fn().mockResolvedValue(undefined);
    renderSwitcher({ tenant: 'tnt_test', setActiveTenant });

    await openOptions(user);
    await user.click(screen.getByRole('option', { name: 'Live' }));

    expect(setActiveTenant).toHaveBeenCalledWith('tnt_live');
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: /Switch tenant/i })).toHaveTextContent('Live'),
    );
  });

  it('does NOT switch when the already-active option is re-selected', async () => {
    const user = userEvent.setup();
    const setActiveTenant = vi.fn().mockResolvedValue(undefined);
    renderSwitcher({ tenant: 'tnt_test', setActiveTenant });

    await openOptions(user);
    await user.click(screen.getByRole('option', { name: 'Test' }));

    expect(setActiveTenant).not.toHaveBeenCalled();
    expect(screen.getByRole('combobox', { name: /Switch tenant/i })).toHaveTextContent('Test');
  });

  it('renders a static label (no dropdown) for a single-membership user', () => {
    renderSwitcher({ tenant: 'tnt_test', memberships: [TEST] });
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.getByLabelText(/Switch tenant/i)).toHaveTextContent('Test');
  });

  it('exposes the combobox ARIA label', () => {
    renderSwitcher();
    expect(screen.getByRole('combobox', { name: /Switch tenant/i })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Hardening: switching is a server-side op (persist / token refresh / refetch).
// The control disables while a switch settles (a second swap can't race the
// first), and a failure surfaces a role="alert" toast while the dropdown stays
// on its prior, unchanged value (the provider leaves `tenant` untouched).
// ---------------------------------------------------------------------------
describe('TenantSwitcher — switch lifecycle', () => {
  function deferred<T>(): {
    promise: Promise<T>;
    resolve: (v: T) => void;
    reject: (e: unknown) => void;
  } {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  it('disables the dropdown while the switch is in flight', async () => {
    const user = userEvent.setup();
    const gate = deferred<void>();
    const setActiveTenant = vi.fn().mockReturnValue(gate.promise);
    renderSwitcher({ tenant: 'tnt_test', setActiveTenant });

    await user.click(screen.getByRole('combobox', { name: /Switch tenant/i }));
    await user.click(screen.getByRole('option', { name: 'Live' }));

    // While in flight: the combobox reports disabled (announced via aria-disabled).
    const combobox = screen.getByRole('combobox', { name: /Switch tenant/i });
    await waitFor(() => expect(combobox).toHaveAttribute('aria-disabled', 'true'));

    gate.resolve();
    // After settling: interactive again.
    await waitFor(() => expect(combobox).not.toHaveAttribute('aria-disabled'));
  });

  it('surfaces a role="alert" toast when the switch fails (and keeps the prior tenant)', async () => {
    const user = userEvent.setup();
    const setActiveTenant = vi.fn().mockRejectedValue(new Error('persist failed'));
    renderSwitcher({ tenant: 'tnt_test', setActiveTenant });

    await user.click(screen.getByRole('combobox', { name: /Switch tenant/i }));
    await user.click(screen.getByRole('option', { name: 'Live' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/couldn't switch tenant/i);
    // The dropdown stays on the prior (Test) tenant — the provider left it
    // unchanged on failure, so the visual state matches reality.
    expect(screen.getByRole('combobox', { name: /Switch tenant/i })).toHaveTextContent('Test');
    // Interactive again so the user can retry.
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: /Switch tenant/i })).not.toHaveAttribute(
        'aria-disabled',
      ),
    );
  });
});
