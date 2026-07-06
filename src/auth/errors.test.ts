import { describe, expect, it } from 'vitest';

import { AuthError, isAuthError } from '@vectros-ai/react';

describe('AuthError', () => {
  it('preserves code and message', () => {
    const err = new AuthError('INVALID_CREDENTIALS', 'wrong password');
    expect(err.code).toBe('INVALID_CREDENTIALS');
    expect(err.message).toBe('wrong password');
    expect(err.name).toBe('AuthError');
  });

  it('survives instanceof across try/catch boundaries', () => {
    try {
      throw new AuthError('LIMIT_EXCEEDED', 'too many attempts');
    } catch (e) {
      expect(e).toBeInstanceOf(AuthError);
      expect(e).toBeInstanceOf(Error);
    }
  });

  it('isAuthError returns true for AuthError instances only', () => {
    expect(isAuthError(new AuthError('UNKNOWN', 'x'))).toBe(true);
    expect(isAuthError(new Error('x'))).toBe(false);
    expect(isAuthError(null)).toBe(false);
    expect(isAuthError(undefined)).toBe(false);
    expect(isAuthError('string')).toBe(false);
    expect(isAuthError({ code: 'INVALID_CREDENTIALS' })).toBe(false);
  });
});
