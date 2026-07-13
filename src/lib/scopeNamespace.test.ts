// ---------------------------------------------------------------------------
// scopeNamespace — namespace grammar + reserved-word validation.
// ---------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';

import {
  namespaceFromScopeKey,
  scopeKey,
  validateScopeNamespace,
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
