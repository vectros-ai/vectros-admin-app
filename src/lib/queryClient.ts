// ---------------------------------------------------------------------------
// TanStack Query (`@tanstack/react-query`) default configuration.
//
// One singleton lives at the app root (instantiated in `main.tsx`); tests
// instantiate fresh per-test clients via `createQueryClient()` to keep the
// cache from leaking across `it()` blocks.
//
// The defaults below are the OPINIONATED reference-app baseline. Partner
// forks can override per-query via the second argument to `useQuery` /
// `useMutation`, or replace the client entirely. Notes on each:
//
//   - `retry: 1` — single transparent retry then bubble. Admin surfaces
//     shouldn't auto-retry forever; a single retry papers over the typical
//     transient network blip without masking real outages.
//
//   - `staleTime: 30_000` — 30s. Admin list reads (members, keys, logs)
//     tolerate up to 30s of staleness; this kills the cross-component
//     duplicate-fetch pattern that bit hand-rolled `useEffect` calls.
//
//   - `gcTime: 5 * 60_000` — 5min. Matches the Rust authorizer's policy-
//     cache window, so admin reads of authorizer-bound data have
//     predictable freshness.
//
//   - `refetchOnWindowFocus: false` — OFF. Default TanStack Query behavior
//     refetches on tab focus, which surprises partners migrating from
//     `useEffect` patterns (sudden network activity, jumping spinners).
//     The current admin surfaces don't need it; opt-in per-query if you do.
//
//   - `mutations.retry: 0` — mutations NEVER auto-retry. Callers must
//     decide whether a `createInvite` or `deleteUser` should retry (and
//     under what conditions — idempotency, side effects, etc.). Silent
//     retry on a non-idempotent mutation is the wrong default.
//
// ---------------------------------------------------------------------------

import { QueryClient } from '@tanstack/react-query';

export const QUERY_CLIENT_DEFAULTS = {
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: false,
    },
    mutations: {
      retry: 0,
    },
  },
} as const;

export function createQueryClient(): QueryClient {
  return new QueryClient(QUERY_CLIENT_DEFAULTS);
}
