// ---------------------------------------------------------------------------
// Auth entry point for the Admin App.
//
// The auth stack (provider-agnostic adapter, Cognito reference implementation,
// partner-API token cache, scope gating, tenant switching, MFA) now lives in
// the shared @vectros-ai/react package so the reference apps share one
// implementation. This module re-exports it as the app's single auth import
// surface — call sites do `import { useAuth, AuthError } from '../auth'`.
//
// To swap auth providers in a fork: implement AuthProviderAdapter (see
// @vectros-ai/react) and construct it in main.tsx; nothing here changes.
//
// **`useAuth` is narrowed, not re-exported bare.** The package's own
// `AuthContextValue` marks every embedded-credential method optional (a
// hosted-redirect provider wouldn't have them at all — see
// @vectros-ai/react's types.ts file-header note). This app is ALWAYS
// Cognito/embedded — `main.tsx` only ever constructs a `CognitoAuthProvider`
// — so every embedded method really is guaranteed present here. Narrowing
// once, in this one file, means the ~15 pages calling `useAuth().signIn(...)`
// etc. stay fully typed with no per-call-site optional-chaining. An explicit
// named export below overrides the `export *` binding for `useAuth` (ES
// modules: an explicit export wins over a star-re-exported one of the same
// name), so this is the ONLY `useAuth` this module surfaces.
//
// The narrowing uses `assertEmbeddedAuth` (a real runtime check backing the
// type assertion), NOT a bare `as` cast — a cast would silently lie if a
// future change ever repoints main.tsx at a hosted-redirect provider without
// updating this file; the assertion instead throws immediately, with a clear
// message, at the first `useAuth()` call after such a mismatch, rather than
// a cryptic `TypeError: ... is not a function` from deep inside some page.
// ---------------------------------------------------------------------------

import { assertEmbeddedAuth, useAuth as useAuthBase } from '@vectros-ai/react';
import type { AuthContextValue, EmbeddedCredentialAuth } from '@vectros-ai/react';

export * from '@vectros-ai/react';

/** This app's fully-typed `useAuth()` — see the module header for why. */
export function useAuth(): AuthContextValue & EmbeddedCredentialAuth {
  const value = useAuthBase();
  assertEmbeddedAuth(value);
  return value;
}
