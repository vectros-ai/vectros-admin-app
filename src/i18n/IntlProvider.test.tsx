// ---------------------------------------------------------------------------
// IntlProvider tests — verify locale detection + message resolution.
//
// What we're pinning:
//   1. Known locale (English) resolves messages from the catalog.
//   2. Unknown browser locale falls back to English silently.
//   3. Explicit `locale` prop overrides browser detection.
//   4. ICU value interpolation (the {variable} pattern used by BRAND-aware
//      messages) works as expected.
// ---------------------------------------------------------------------------

import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FormattedMessage } from 'react-intl';

import { I18N_DEFAULT_LOCALE, IntlProvider } from './IntlProvider';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('IntlProvider', () => {
  it('renders catalog messages for the default locale', () => {
    render(
      <IntlProvider locale={I18N_DEFAULT_LOCALE}>
        <FormattedMessage id="login.title" />
      </IntlProvider>,
    );
    expect(screen.getByText('Sign in')).toBeInTheDocument();
  });

  it('interpolates ICU values into messages', () => {
    render(
      <IntlProvider locale={I18N_DEFAULT_LOCALE}>
        <FormattedMessage id="welcome.headingWithName" values={{ firstName: 'Alice' }} />
      </IntlProvider>,
    );
    expect(screen.getByText('Welcome, Alice')).toBeInTheDocument();
  });

  it('falls back to English when the browser locale is unknown', () => {
    // jsdom's default is en-US. Stub navigator.language to something we
    // do NOT ship a catalog for and confirm the fallback renders English.
    vi.stubGlobal('navigator', { language: 'xx-XX' });
    render(
      <IntlProvider>
        <FormattedMessage id="login.title" />
      </IntlProvider>,
    );
    expect(screen.getByText('Sign in')).toBeInTheDocument();
  });

  it('uses the explicit `locale` prop over browser detection', () => {
    // Even with a stubbed browser locale, the explicit prop wins.
    vi.stubGlobal('navigator', { language: 'xx-XX' });
    render(
      <IntlProvider locale={I18N_DEFAULT_LOCALE}>
        <FormattedMessage id="layout.signOut" />
      </IntlProvider>,
    );
    expect(screen.getByText('Sign out')).toBeInTheDocument();
  });

  it('interpolates BRAND-style productName variables', () => {
    render(
      <IntlProvider locale={I18N_DEFAULT_LOCALE}>
        <FormattedMessage id="login.subtitle" values={{ productName: 'Test Brand' }} />
      </IntlProvider>,
    );
    expect(screen.getByText('Welcome back to Test Brand.')).toBeInTheDocument();
  });
});
