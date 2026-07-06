// ---------------------------------------------------------------------------
// useBeforeNavigate tests.
//
// **Test-infra convention** (lesson from smoke verification):
//   - Use the LEGACY `<MemoryRouter>` component — NOT `createMemoryRouter`.
//     Production wires the app under `<BrowserRouter>` in main.tsx, and
//     `<BrowserRouter>` + `<MemoryRouter>` share the legacy non-data-router
//     plumbing. The original test file in this MR used `createMemoryRouter`
//     (the data-router variant) which silently diverged from production —
//     hiding a runtime crash caught only by smoke. The convention going
//     forward: tests should run against the SAME router type production
//     does so that React-Router-specific API mismatches surface at vitest
//     time, not smoke time.
//
// **What this hook does now (v1):**
//   - Attaches a `beforeunload` listener while `when` is true.
//   - Removes the listener when `when` flips back to false or the
//     component unmounts.
//   - Does NOT guard in-app navigation (route changes inside the SPA).
//     That capability requires `useBlocker`, which only works under the
//     data-router API. See useBeforeNavigate.ts file header for the
//     deferred-until-router-migration framing.
//
// Pinning:
//   1. `when=false` — no beforeunload listener attached on mount.
//   2. `when=true` — listener attached on mount; the registered handler
//      calls preventDefault when fired.
//   3. Toggle false → true → false — listener correctly added + removed
//      across transitions (no leaks).
//   4. Unmount with `when=true` — listener removed (no leak).
// ---------------------------------------------------------------------------

import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TestIntlProvider } from '../test/intl';
import { useBeforeNavigate } from './useBeforeNavigate';

/**
 * Harness — a component that calls `useBeforeNavigate(when)` where `when`
 * is controlled via a checkbox. Tests toggle the checkbox to drive
 * listener-add / listener-remove transitions.
 */
function Harness({ defaultWhen }: { defaultWhen: boolean }) {
  const [when, setWhen] = useState(defaultWhen);
  useBeforeNavigate(when);
  return (
    <label>
      <input
        type="checkbox"
        checked={when}
        onChange={(e) => setWhen(e.target.checked)}
        aria-label="dirty"
      />
      dirty
    </label>
  );
}

function renderHarness(opts: { defaultWhen: boolean }) {
  return render(
    <TestIntlProvider>
      <MemoryRouter initialEntries={['/edit']}>
        <Harness defaultWhen={opts.defaultWhen} />
      </MemoryRouter>
    </TestIntlProvider>,
  );
}

beforeEach(() => {
  vi.spyOn(window, 'addEventListener');
  vi.spyOn(window, 'removeEventListener');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useBeforeNavigate', () => {
  it('does not attach the beforeunload listener when `when` is false', () => {
    renderHarness({ defaultWhen: false });
    const beforeUnloadAdds = vi
      .mocked(window.addEventListener)
      .mock.calls.filter((c) => c[0] === 'beforeunload');
    expect(beforeUnloadAdds).toHaveLength(0);
  });

  it('attaches the beforeunload listener when `when` is true; preventDefault fires', () => {
    renderHarness({ defaultWhen: true });
    const adds = vi
      .mocked(window.addEventListener)
      .mock.calls.filter((c) => c[0] === 'beforeunload');
    expect(adds).toHaveLength(1);

    // Pull the registered handler + drive it directly to confirm it
    // calls preventDefault. (returnValue's post-cancel value is
    // browser-specific — jsdom reads it back as `true` once an event
    // has been preventDefault'd, while DOM-spec implies '' is also
    // valid. preventDefault is the load-bearing call.)
    const handler = adds[0]?.[1] as (e: BeforeUnloadEvent) => unknown;
    const event = new Event('beforeunload') as BeforeUnloadEvent;
    const preventDefaultSpy = vi.spyOn(event, 'preventDefault');
    handler(event);
    expect(preventDefaultSpy).toHaveBeenCalled();
  });

  it('toggles listener add/remove across `when` transitions', async () => {
    const user = userEvent.setup();
    renderHarness({ defaultWhen: false });

    // Initially off — no listener.
    expect(
      vi.mocked(window.addEventListener).mock.calls.filter((c) => c[0] === 'beforeunload'),
    ).toHaveLength(0);

    // Flip dirty on — listener attached.
    await user.click(screen.getByLabelText('dirty'));
    expect(
      vi.mocked(window.addEventListener).mock.calls.filter((c) => c[0] === 'beforeunload'),
    ).toHaveLength(1);

    // Flip dirty off — listener removed.
    await user.click(screen.getByLabelText('dirty'));
    expect(
      vi.mocked(window.removeEventListener).mock.calls.filter((c) => c[0] === 'beforeunload'),
    ).toHaveLength(1);
  });

  it('removes the listener on unmount when `when` was true', () => {
    const { unmount } = renderHarness({ defaultWhen: true });
    unmount();
    expect(
      vi.mocked(window.removeEventListener).mock.calls.filter((c) => c[0] === 'beforeunload'),
    ).toHaveLength(1);
  });
});
