/// <reference types="vite/client" />

// ---------------------------------------------------------------------------
// Vite exposes env vars via `import.meta.env`. Declaring them here gives us
// type-safe access at the read site. Keep this list in sync with .env.example
// and src/config.ts.
// ---------------------------------------------------------------------------

interface ImportMetaEnv {
  readonly VITE_COGNITO_USER_POOL_ID: string;
  readonly VITE_COGNITO_USER_POOL_CLIENT_ID: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
