// ---------------------------------------------------------------------------
// TestIntlProvider — i18n + TanStack Query wrapper for unit tests.
//
// Despite the historical name, this wraps BOTH:
//
//   1. <IntlProvider> — tests assert against rendered English strings
//      (e.g. `getByText('Sign in')`), so we use the same English catalog the
//      runtime uses. Pinned `locale="en"` here for determinism independent
//      of jsdom's `navigator.language` defaults.
//
//   2. <QueryClientProvider> — every test gets a FRESH QueryClient so the
//      cache doesn't leak across `it()` blocks. Tests that don't use queries
//      pay near-zero cost (no queries fire). Inlined test-strict defaults
//      override the production defaults from src/lib/queryClient.ts:
//        - retry: false           — failures must surface immediately; no
//                                   silent retry-then-pass behavior
//        - gcTime: Infinity       — cached data stays for the test duration
//                                   so assertion timing is deterministic
//        - staleTime: Infinity    — no background refetches mid-test
//
// The name `TestIntlProvider` is retained to avoid churning every existing
// test's import statement; mentally substitute "TestProviders" if it helps.
// ---------------------------------------------------------------------------

import { useState } from 'react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { I18N_DEFAULT_LOCALE, IntlProvider } from '../i18n/IntlProvider';

interface TestIntlProviderProps {
  readonly children: ReactNode;
  /**
   * Query stale time. Defaults to `Infinity` so assertion timing is
   * deterministic; pass `0` to exercise the automatic refetches production's
   * finite stale time allows (returning to a cached key, a reconnect).
   */
  readonly staleTime?: number | undefined;
}

export function TestIntlProvider({
  children,
  staleTime = Infinity,
}: TestIntlProviderProps): React.JSX.Element {
  // Fresh QueryClient per render — `useState`'s lazy initializer guarantees
  // exactly-once construction within a render's lifetime, and each test's
  // `render()` call mounts a new TestIntlProvider → new client.
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: false, gcTime: Infinity, staleTime },
          mutations: { retry: false },
        },
      }),
  );
  return (
    <QueryClientProvider client={queryClient}>
      <IntlProvider locale={I18N_DEFAULT_LOCALE}>{children}</IntlProvider>
    </QueryClientProvider>
  );
}
