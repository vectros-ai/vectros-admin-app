// ---------------------------------------------------------------------------
// scopeNamespace — namespace grammar + reserved-word validation.
// ---------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';

import {
  namespaceFromScopeKey,
  scopeKey,
  validateScopeNamespace,
  validateScopeValue,
} from './scopeNamespace';

describe('validateScopeNamespace', () => {
  it('accepts the built-ins and well-formed custom namespaces', () => {
    for (const ns of ['org', 'client', 'group', 'eng-team', 'a1', 'region_1']) {
      expect(validateScopeNamespace(ns)).toBeNull();
    }
  });

  it('rejects the empty string', () => {
    expect(validateScopeNamespace('')).toEqual({ code: 'empty' });
    expect(validateScopeNamespace('   ')).toEqual({ code: 'empty' });
  });

  it('rejects reserved namespaces', () => {
    for (const ns of ['user', 'self', 'tenant', 'context', 'scope']) {
      expect(validateScopeNamespace(ns)).toEqual({ code: 'reserved', namespace: ns });
    }
  });

  it('rejects grammar violations', () => {
    for (const ns of ['A', 'Ns', '1group', '-x', 'has space', 'toolongtoolongtoolongtoolongtoolong', 'x']) {
      expect(validateScopeNamespace(ns)?.code).toBe('grammar');
    }
  });

  it('accepts the 2-char and 32-char boundaries', () => {
    expect(validateScopeNamespace('ab')).toBeNull();
    expect(validateScopeNamespace('a' + 'b'.repeat(31))).toBeNull(); // 32 chars
    expect(validateScopeNamespace('a' + 'b'.repeat(32))?.code).toBe('grammar'); // 33 chars
  });
});

describe('validateScopeValue', () => {
  it('accepts mixed-case, digit-leading, and dash/underscore values', () => {
    for (const v of ['org_123', 'A1', 'eng-team', 'UUID-4f2b', '9', 'a'.repeat(128)]) {
      expect(validateScopeValue(v)).toBeNull();
    }
  });

  it('rejects a colon (the load-bearing rejection — it can break a storage key)', () => {
    expect(validateScopeValue('a:b')).toEqual({ code: 'grammar' });
  });

  it('rejects other punctuation and a leading dash/underscore', () => {
    for (const v of ['a b', 'a.b', '-x', '_x', 'a$b', 'a{b}']) {
      expect(validateScopeValue(v)?.code).toBe('grammar');
    }
  });

  it('rejects a value over 128 characters', () => {
    expect(validateScopeValue('a'.repeat(129))?.code).toBe('grammar');
  });

  it('rejects the empty string (callers must blank-check separately)', () => {
    expect(validateScopeValue('')?.code).toBe('grammar');
  });
});

describe('scopeKey / namespaceFromScopeKey', () => {
  it('round-trips a namespace through the scope: prefix', () => {
    expect(scopeKey('group')).toBe('scope:group');
    expect(namespaceFromScopeKey('scope:group')).toBe('group');
  });

  it('returns null for a non-scope key', () => {
    expect(namespaceFromScopeKey('orgId')).toBeNull();
    expect(namespaceFromScopeKey('scope:')).toBeNull();
  });
});
