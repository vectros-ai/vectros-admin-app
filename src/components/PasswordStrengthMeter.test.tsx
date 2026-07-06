// ---------------------------------------------------------------------------
// PasswordStrengthMeter tests.
//
// Strategy: render the component directly (no React.lazy boundary). The
// zxcvbn-ts loader engages on mount — the first assertion waits for the
// async load to resolve via @testing-library's waitFor. Subsequent tests
// reuse the module-cached scorer (one paid load per test file).
//
// Score thresholds we pin (from zxcvbn-ts's documented behavior):
//   - "abc"           → score 0 (Very Weak)
//   - "hunter2"       → score 0–1 (very common; very weak)
//   - "Tr0ub4dor&3"   → score ~3 (Good) — classic xkcd reference, real entropy
//                       is moderate
//   - "correct horse battery staple" → score 4 (Strong) — high entropy via
//                       length even though all-lowercase common words
//
// Real-zxcvbn-ts-engagement test takes ~200ms per assertion; we keep the
// count low. The PasswordField test file uses a mock to keep its surface
// fast.
// ---------------------------------------------------------------------------

import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { PasswordStrengthMeter } from '@vectros-ai/react';
import { TestIntlProvider } from '../test/intl';

function renderMeter(
  props: React.ComponentProps<typeof PasswordStrengthMeter>,
): void {
  render(
    <TestIntlProvider>
      <PasswordStrengthMeter {...props} />
    </TestIntlProvider>,
  );
}

describe('PasswordStrengthMeter — visibility', () => {
  it('renders nothing for an empty value', () => {
    const { container } = render(
      <TestIntlProvider>
        <PasswordStrengthMeter value="" />
      </TestIntlProvider>,
    );
    // No meter role rendered — meter is hidden until a value is typed.
    expect(container.querySelector('[role="meter"]')).toBeNull();
  });

  it('renders a meter role once a non-empty value is scored', async () => {
    renderMeter({ value: 'abc' });
    const meter = await screen.findByRole('meter', {}, { timeout: 5000 });
    expect(meter).toBeInTheDocument();
    expect(meter).toHaveAttribute('aria-valuemin', '0');
    expect(meter).toHaveAttribute('aria-valuemax', '4');
    expect(meter).toHaveAttribute('aria-valuenow');
  });
});

describe('PasswordStrengthMeter — known-score regressions', () => {
  it('"abc" scores as Very Weak (0) — common dictionary fragment', async () => {
    renderMeter({ value: 'abc' });
    const meter = await screen.findByRole('meter', {}, { timeout: 5000 });
    expect(meter).toHaveAttribute('aria-valuenow', '0');
    expect(screen.getByText(/Very weak/)).toBeInTheDocument();
  });

  it('"correct horse battery staple" scores as Strong (4) — high entropy', async () => {
    renderMeter({ value: 'correct horse battery staple' });
    const meter = await screen.findByRole('meter', {}, { timeout: 5000 });
    expect(meter).toHaveAttribute('aria-valuenow', '4');
    expect(screen.getByText(/Strong/)).toBeInTheDocument();
  });
});

describe('PasswordStrengthMeter — onStrengthChange callback', () => {
  it('fires with the resolved score when the value is scored', async () => {
    const onStrengthChange = vi.fn();
    renderMeter({ value: 'abc', onStrengthChange });
    await waitFor(
      () => expect(onStrengthChange).toHaveBeenCalled(),
      { timeout: 5000 },
    );
    // First call should be score 0 (Very Weak) for 'abc'.
    expect(onStrengthChange).toHaveBeenCalledWith(0);
  });
});

describe('PasswordStrengthMeter — id wiring for aria-describedby', () => {
  it('honors id prop for aria-describedby wiring', async () => {
    renderMeter({ value: 'abc', id: 'meter-xyz' });
    const meter = await screen.findByRole('meter', {}, { timeout: 5000 });
    expect(meter).toHaveAttribute('id', 'meter-xyz');
  });
});
