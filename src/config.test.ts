// ---------------------------------------------------------------------------
// Tests for src/config.ts — exercises the fail-fast contract on missing
// env vars. The default stubs in src/test/setup.ts make config import OK;
// these tests un-stub specific vars and re-import to check the throw.
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  // Re-apply baseline stubs so other tests aren't affected.
  vi.stubEnv('VITE_COGNITO_USER_POOL_ID', 'us-east-1_TESTPOOL');
  vi.stubEnv('VITE_COGNITO_USER_POOL_CLIENT_ID', 'testclientid1234567890');
});

describe('config', () => {
  it('exports COGNITO_CONFIG with values from import.meta.env', async () => {
    const { COGNITO_CONFIG } = await import('./config');
    expect(COGNITO_CONFIG.userPoolId).toBe('us-east-1_TESTPOOL');
    expect(COGNITO_CONFIG.userPoolClientId).toBe('testclientid1234567890');
  });

  it('throws when VITE_COGNITO_USER_POOL_ID is missing', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_COGNITO_USER_POOL_ID', '');
    await expect(import('./config')).rejects.toThrow(/VITE_COGNITO_USER_POOL_ID is not set/);
  });

  it('throws when VITE_COGNITO_USER_POOL_CLIENT_ID is whitespace-only', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_COGNITO_USER_POOL_CLIENT_ID', '   ');
    await expect(import('./config')).rejects.toThrow(/VITE_COGNITO_USER_POOL_CLIENT_ID is not set/);
  });
});
