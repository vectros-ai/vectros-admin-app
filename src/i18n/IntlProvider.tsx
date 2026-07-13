// ---------------------------------------------------------------------------
// IntlProvider — the Admin App's i18n entry point.
//
// The locale-detection + react-intl wrapper now lives in @vectros-ai/react
// (catalog-agnostic). This thin wrapper supplies THIS app's English catalog and
// keeps the same `<IntlProvider>` import surface for the app + its tests, so
// call sites don't change. Adding a locale: import the JSON and add an entry to
// MESSAGES_BY_LOCALE.
// ---------------------------------------------------------------------------

import type { ReactNode } from 'react';
import { IntlProvider as VectrosIntlProvider, baseMessagesEn } from '@vectros-ai/react';
import type { MessagesByLocale } from '@vectros-ai/react';

import messagesEn from './messages.en.json';
// Per-flow hardening catalogs. Split so parallel work on different flows
// never collides on one JSON file; all disjoint, merged additively here.
import membersEn from './hardening/members.en.json';
import contextsEn from './hardening/contexts.en.json';
import keysEn from './hardening/keys.en.json';
import rolesEn from './hardening/roles.en.json';
import accountEn from './hardening/account.en.json';
import authShellEn from './hardening/authShell.en.json';
import accessLogEn from './hardening/accessLog.en.json';

// Re-export so existing call sites keep importing the locale constant from the
// app's i18n module rather than reaching into the library.
export { I18N_DEFAULT_LOCALE } from '@vectros-ai/react';

// Merge the package's component-string defaults (AppLayout chrome, PasswordField,
// MFA) UNDER this app's catalog so we never hand-copy those keys (app keys win
// on collision). This app's catalog carries only its own surfaces + overrides.
const MESSAGES_BY_LOCALE: MessagesByLocale = {
  en: {
    ...baseMessagesEn,
    ...messagesEn,
    ...membersEn,
    ...contextsEn,
    ...keysEn,
    ...rolesEn,
    ...accountEn,
    ...authShellEn,
    ...accessLogEn,
  },
};

interface IntlProviderProps {
  readonly children: ReactNode;
  /** Optional locale override — primarily for tests and Storybook. */
  readonly locale?: string;
}

export function IntlProvider({ children, locale }: IntlProviderProps): React.JSX.Element {
  return (
    <VectrosIntlProvider messagesByLocale={MESSAGES_BY_LOCALE} locale={locale}>
      {children}
    </VectrosIntlProvider>
  );
}
