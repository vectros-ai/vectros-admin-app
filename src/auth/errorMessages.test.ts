// ---------------------------------------------------------------------------
// authErrorToMessage tests.
//
// Pinning the four branches of the helper:
//   1. AuthError with known code → catalog message.
//   2. AuthError with PASSWORD_POLICY_VIOLATION + non-empty message →
//      provider message verbatim (the rule that failed).
//   3. AuthError with PASSWORD_POLICY_VIOLATION + empty message → catalog
//      generic fallback.
//   4. Non-AuthError throwable → auth.errors.UNKNOWN.
//
// Uses react-intl's createIntl directly (no Provider) for unit isolation.
// ---------------------------------------------------------------------------

import { createIntl, createIntlCache } from 'react-intl';
import { describe, expect, it } from 'vitest';

import { AuthError } from '@vectros-ai/react';
import { authErrorToMessage } from '@vectros-ai/react';

import messagesEn from '../i18n/messages.en.json';

function makeIntl() {
  const cache = createIntlCache();
  return createIntl({ locale: 'en', messages: messagesEn }, cache);
}

describe('authErrorToMessage', () => {
  it('returns the catalog message for a known AuthError code', () => {
    const intl = makeIntl();
    const err = new AuthError('INVALID_CREDENTIALS', 'native msg');
    expect(authErrorToMessage(intl, err)).toBe(
      'The email or password you entered is incorrect.',
    );
  });

  it('surfaces the provider message verbatim for PASSWORD_POLICY_VIOLATION with message', () => {
    const intl = makeIntl();
    const err = new AuthError(
      'PASSWORD_POLICY_VIOLATION',
      'Password must contain at least one number.',
    );
    expect(authErrorToMessage(intl, err)).toBe(
      'Password must contain at least one number.',
    );
  });

  it('falls back to catalog message for PASSWORD_POLICY_VIOLATION with empty message', () => {
    const intl = makeIntl();
    const err = new AuthError('PASSWORD_POLICY_VIOLATION', '');
    expect(authErrorToMessage(intl, err)).toBe(
      'Your password does not meet the requirements.',
    );
  });

  it('returns auth.errors.UNKNOWN for non-AuthError throwables', () => {
    const intl = makeIntl();
    expect(authErrorToMessage(intl, new Error('something else'))).toBe(
      'Something went wrong. Please try again.',
    );
    expect(authErrorToMessage(intl, 'not-an-error')).toBe(
      'Something went wrong. Please try again.',
    );
    expect(authErrorToMessage(intl, null)).toBe('Something went wrong. Please try again.');
    expect(authErrorToMessage(intl, undefined)).toBe('Something went wrong. Please try again.');
  });

  it('matches the LIMIT_EXCEEDED catalog message for that code', () => {
    const intl = makeIntl();
    const err = new AuthError('LIMIT_EXCEEDED', 'native msg');
    expect(authErrorToMessage(intl, err)).toBe(
      'Too many attempts. Please wait a few minutes and try again.',
    );
  });

  it('matches the NETWORK_ERROR catalog message', () => {
    const intl = makeIntl();
    const err = new AuthError('NETWORK_ERROR', 'whatever');
    expect(authErrorToMessage(intl, err)).toBe(
      'A network problem occurred. Check your connection and try again.',
    );
  });
});
