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
// ---------------------------------------------------------------------------

export * from '@vectros-ai/react';
