// ---------------------------------------------------------------------------
// Vitest setup — runs once before each test file.
//
// Imports `@testing-library/jest-dom` which extends `expect` with DOM
// matchers (toBeInTheDocument, toHaveTextContent, etc.) used throughout
// the test suite.
//
// Also stubs Vite's `import.meta.env` reads so src/config.ts does not
// throw when imported from tests. Real integration tests can override
// individual values via vi.stubEnv() per test.
// ---------------------------------------------------------------------------

import '@testing-library/jest-dom/vitest';
import { vi, afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

vi.stubEnv('VITE_COGNITO_USER_POOL_ID', 'us-east-1_TESTPOOL');
vi.stubEnv('VITE_COGNITO_USER_POOL_CLIENT_ID', 'testclientid1234567890');
vi.stubEnv('VITE_DEVELOPER_API_URL', 'https://api.test.example/dev');
vi.stubEnv('VITE_VECTROS_API_URL', 'https://api.test.example/partner');

afterEach(() => {
  cleanup();
});
