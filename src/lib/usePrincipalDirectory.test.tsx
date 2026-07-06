// ---------------------------------------------------------------------------
// usePrincipalDirectory tests — the real principal → human-label resolver.
//
// Everything that consumes the directory mocks it; this exercises the actual
// implementation: it drains the tenant's users and maps `usr_<id>` principals
// to emails, handling keys and unresolvable users.
// ---------------------------------------------------------------------------

import type { ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { vectrosApiClient } from '../api/vectrosApi';
import type * as VectrosApi from '../api/vectrosApi';
import { TestTenantProvider } from '../test/TestTenantProvider';
import { usePrincipalDirectory } from './usePrincipalDirectory';

vi.mock('../api/vectrosApi', async (importOriginal) => {
  const actual = await importOriginal<typeof VectrosApi>();
  return { ...actual, vectrosApiClient: vi.fn() };
});

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={queryClient}>
      <TestTenantProvider>{children}</TestTenantProvider>
    </QueryClientProvider>
  );
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('usePrincipalDirectory', () => {
  it('resolves usr_, key_, and unresolvable principals', async () => {
    const listUsers = vi.fn().mockResolvedValue({
      data: [
        { id: 'alice', email: 'alice@example.com' },
        { id: 'bob', email: 'bob@example.com' },
        // A data-plane / SDK-created user with no email — only an externalId
        // (the test-tenant case the owner hit).
        { id: 'carol', externalId: 'carol-ext-123' },
      ],
      nextCursor: null,
    });
    vi.mocked(vectrosApiClient).mockReturnValue({ identity: { listUsers } } as never);

    const { result } = renderHook(() => usePrincipalDirectory(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    // A known user → email, with the matched user attached.
    expect(result.current.resolve('usr_alice')).toMatchObject({
      kind: 'user',
      label: 'alice@example.com',
      hasName: true,
      unresolved: false,
    });
    // Email-less user → falls back to externalId (still a real name).
    expect(result.current.resolve('usr_carol')).toMatchObject({
      kind: 'user',
      label: 'carol-ext-123',
      hasName: true,
      unresolved: false,
    });
    // A user not in the directory (e.g. removed) → falls back to the raw id.
    expect(result.current.resolve('usr_ghost')).toMatchObject({
      kind: 'user',
      label: 'usr_ghost',
      hasName: false,
      unresolved: true,
    });
    // A key has no name source → the id is the label.
    expect(result.current.resolve('key_bot')).toMatchObject({
      kind: 'key',
      label: 'key_bot',
      hasName: false,
      unresolved: false,
    });
    // The user list is exposed for the assign-by-name picker.
    expect(result.current.users).toHaveLength(3);
  });

  it('falls back to raw ids when the user list cannot load', async () => {
    vi.mocked(vectrosApiClient).mockReturnValue({
      identity: { listUsers: vi.fn().mockRejectedValue(new Error('boom')) },
    } as never);

    const { result } = renderHook(() => usePrincipalDirectory(), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));

    // No directory → a usr_ principal still resolves (to its raw id), so the
    // UI degrades gracefully rather than breaking.
    expect(result.current.resolve('usr_alice')).toMatchObject({
      kind: 'user',
      label: 'usr_alice',
      unresolved: true,
    });
  });
});
