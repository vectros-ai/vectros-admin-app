// ---------------------------------------------------------------------------
// React Router type helpers — shared shapes that multiple consumers use.
// ---------------------------------------------------------------------------

/**
 * Shape of the `location.state` value that `RequireAuth` writes when it
 * redirects an unauthenticated visitor to `/login`. LoginPage reads it to
 * route the user back to their intended destination after sign-in.
 *
 * Extracted from LoginPage. Kept
 * in `src/lib/` rather than `src/auth/` because the type is purely about
 * routing — auth happens to be the most prominent consumer.
 */
export interface LocationFromState {
  readonly from?: { readonly pathname?: string };
}
