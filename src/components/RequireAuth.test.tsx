// ---------------------------------------------------------------------------
// RequireAuth tests.
//
// Strategy: render RequireAuth inside an <AuthProvider> with an inline mock
// adapter (the abstraction pays off — no aws-amplify mocking needed), then
// assert what gets rendered under each auth state.
// ---------------------------------------------------------------------------

import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router';

import { AuthProvider } from '../auth';
import type { AuthUser } from '../auth';
import { makeMockAuthProvider as mockAdapter } from '../test/mockAuthProvider';
import { RequireAuth } from '@vectros-ai/react';
import { TestIntlProvider } from '../test/intl';

const aliceUser: AuthUser = {
  sub: 'sub-1',
  email: 'alice@example.com',
  firstName: 'Alice',
  lastName: 'Smith',
};

afterEach(() => {
  vi.clearAllMocks();
});

describe('RequireAuth', () => {
  it('renders a loading spinner during the initial session probe', () => {
    // Adapter that never resolves — keeps loading=true for the assertion.
    const neverResolves = vi
      .fn<() => Promise<AuthUser | null>>()
      .mockImplementation(() => new Promise<AuthUser | null>(() => undefined));
    const provider = mockAdapter({ getCurrentUser: neverResolves });
    render(
      <TestIntlProvider><MemoryRouter>
        <AuthProvider provider={provider}>
          <RequireAuth>
            <div>protected content</div>
          </RequireAuth>
        </AuthProvider>
      </MemoryRouter></TestIntlProvider>,
    );
    expect(screen.getByLabelText('Loading session')).toBeInTheDocument();
    expect(screen.queryByText('protected content')).not.toBeInTheDocument();
  });

  it('renders children once the user is authenticated', async () => {
    const provider = mockAdapter({
      getCurrentUser: vi.fn().mockResolvedValue(aliceUser),
    });
    render(
      <TestIntlProvider><MemoryRouter>
        <AuthProvider provider={provider}>
          <RequireAuth>
            <div>protected content</div>
          </RequireAuth>
        </AuthProvider>
      </MemoryRouter></TestIntlProvider>,
    );
    await waitFor(() => {
      expect(screen.getByText('protected content')).toBeInTheDocument();
    });
  });

  it('redirects to /login when no session, after the probe resolves', async () => {
    const provider = mockAdapter({
      getCurrentUser: vi.fn().mockResolvedValue(null),
    });
    render(
      <TestIntlProvider><MemoryRouter initialEntries={['/protected']}>
        <AuthProvider provider={provider}>
          <Routes>
            <Route
              path="/protected"
              element={
                <RequireAuth>
                  <div>protected content</div>
                </RequireAuth>
              }
            />
            <Route path="/login" element={<div>login page</div>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter></TestIntlProvider>,
    );
    await waitFor(() => {
      expect(screen.getByText('login page')).toBeInTheDocument();
    });
    expect(screen.queryByText('protected content')).not.toBeInTheDocument();
  });

  it('honors a custom redirectTo path', async () => {
    const provider = mockAdapter({
      getCurrentUser: vi.fn().mockResolvedValue(null),
    });
    render(
      <TestIntlProvider><MemoryRouter initialEntries={['/protected']}>
        <AuthProvider provider={provider}>
          <Routes>
            <Route
              path="/protected"
              element={
                <RequireAuth redirectTo="/custom-login">
                  <div>protected content</div>
                </RequireAuth>
              }
            />
            <Route path="/custom-login" element={<div>custom login</div>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter></TestIntlProvider>,
    );
    await waitFor(() => {
      expect(screen.getByText('custom login')).toBeInTheDocument();
    });
  });
});
