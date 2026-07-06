// ---------------------------------------------------------------------------
// useBeforeNavigate — prevent tab close / refresh / hard navigation when
// `when` is true, prompting the user via the browser's native unsaved-
// changes warning.
//
// **v1 scope: `beforeunload` only.** Caveat called out below.
//
// The in-app navigation guard (intercepting a Link click or programmatic
// `navigate(...)` with a confirm prompt) requires react-router's
// `useBlocker` hook, which is ONLY available when the app uses the
// data-router API (`createBrowserRouter` / `RouterProvider`).
// `ui/admin-app/src/main.tsx` uses the legacy `<BrowserRouter>` component;
// calling `useBlocker` under that throws and ErrorBoundary catches it,
// showing "Something went wrong." This was caught in smoke
// verification — the editor pages crashed on mount in the real app even
// though the unit tests passed (they use `createMemoryRouter`).
//
// Until the app migrates to the data-router API (a separate refactor
// well out of scope here — it'd reshape main.tsx + every Route),
// only `beforeunload` is wired here. That's the more important guard:
// it covers tab close, page refresh, address-bar typing, Cmd-W. The
// in-app navigation case (Cancel button, breadcrumb click, etc.)
// silently proceeds without a prompt — users CAN lose work that way.
// Acceptable v1 tradeoff; the "or — more refined" fallback is what this
// implements.
//
// **Modern browsers** display a generic "Changes you made may not be
// saved" string for `beforeunload`; the i18n message
// `access.shared.discardConfirm` is reserved for the future in-app
// path and is currently unused at runtime.
//
// **Testing**: `useBeforeNavigate.test.tsx` covers the beforeunload
// listener add/remove lifecycle around `when` toggles.
//
// References:
//   - https://reactrouter.com/6.30.3/hooks/use-blocker (the missing piece)
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
 * refresh. In-app navigation (Cancel button, etc.) is NOT currently
 * guarded — see the file header for the deferred-to-data-router-migration
 * follow-up.
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
