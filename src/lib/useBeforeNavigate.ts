// ---------------------------------------------------------------------------
// useBeforeNavigate — prevent tab close / refresh / hard navigation when
// `when` is true, prompting the user via the browser's native unsaved-
// changes warning.
//
// **Scope: `beforeunload` only.** The guard covers tab close, page refresh,
// address-bar navigation and Cmd-W. It does not intercept in-app navigation
// (a Cancel button, a breadcrumb or a Link click), so unsaved work can still be
// lost that way.
//
// Guarding in-app navigation needs react-router's `useBlocker`, which exists
// only under the data-router API (`createBrowserRouter` / `RouterProvider`).
// `src/main.tsx` uses the `<BrowserRouter>` component, under which `useBlocker`
// throws on mount. An app that moves to the data router can add the in-app
// guard here; the `access.shared.discardConfirm` message is the confirm
// prompt for it and is not shown today.
//
// Modern browsers display their own generic "Changes you made may not be
// saved" text for `beforeunload`.
//
// **Testing**: `useBeforeNavigate.test.tsx` covers the beforeunload
// listener add/remove lifecycle around `when` toggles.
// ---------------------------------------------------------------------------

import { useEffect } from 'react';

/**
 * Attach a `beforeunload` guard while `when` is true.
 *
 * Usage:
 *
 *     const dirty = formState !== loadedEntity;
 *     useBeforeNavigate(dirty);
 *
 * Browser shows its native unsaved-changes warning on tab close /
 * refresh. In-app navigation (Cancel button, etc.) is not guarded; see the
 * file header.
 *
 * Safe to call unconditionally (e.g., as the first hook in an editor
 * component); pass `false` to disable.
 */
export function useBeforeNavigate(when: boolean): void {
  useEffect(() => {
    if (!when) return undefined;

    const handler = (e: BeforeUnloadEvent): string => {
      // Modern browsers ignore the message text and show a generic
      // "Changes you made may not be saved" string; `preventDefault()`
      // + setting `returnValue` is what actually triggers the prompt.
      // Older browsers (and some node-test environments) honor the
      // returned string. Belt + suspenders.
      e.preventDefault();
      e.returnValue = '';
      return '';
    };

    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [when]);
}
