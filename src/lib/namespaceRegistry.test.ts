// ---------------------------------------------------------------------------
// namespaceRegistry tests — the tenant-wide/context-own merge (mergeNamespaces).
// The hook itself (useNamespaceRegistry) is exercised indirectly by the
// components that consume it (ContextDetailPage's Entities tab, ProfileEditor).
// ---------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';

import { mergeNamespaces } from './namespaceRegistry';
import type { NamespaceResponse } from '../api/vectrosApi';

describe('mergeNamespaces', () => {
  it('passes through a tenant-wide namespace with no context-own override', () => {
    const tenantWide: NamespaceResponse[] = [
      { namespace: 'team', entityBacked: true, contextId: undefined },
    ];
    const result = mergeNamespaces(tenantWide, []);
    expect(result).toEqual([
      { namespace: 'team', entityBacked: true, contextId: null, defaultSchemaId: null },
    ]);
  });

  it("a context's own registration SHADOWS a same-named tenant-wide one", () => {
    const tenantWide: NamespaceResponse[] = [
      { namespace: 'team', entityBacked: false, contextId: undefined },
    ];
    const contextOwn: NamespaceResponse[] = [
      { namespace: 'team', entityBacked: true, contextId: 'myapp' },
    ];
    const result = mergeNamespaces(tenantWide, contextOwn);
    expect(result).toEqual([
      { namespace: 'team', entityBacked: true, contextId: 'myapp', defaultSchemaId: null },
    ]);
  });

  it('includes a context-own namespace that has no tenant-wide counterpart at all', () => {
    const contextOwn: NamespaceResponse[] = [
      { namespace: 'project', entityBacked: true, contextId: 'myapp' },
    ];
    const result = mergeNamespaces([], contextOwn);
    expect(result).toEqual([
      { namespace: 'project', entityBacked: true, contextId: 'myapp', defaultSchemaId: null },
    ]);
  });

  it('org and client are ordinary namespaces here — no name special-casing', () => {
    const tenantWide: NamespaceResponse[] = [
      { namespace: 'org', entityBacked: true, contextId: undefined },
      { namespace: 'client', entityBacked: true, contextId: undefined },
    ];
    const result = mergeNamespaces(tenantWide, []);
    expect(result.map((n) => n.namespace)).toEqual(['org', 'client']);
  });

  it('a tenant with nothing registered merges to an empty list', () => {
    expect(mergeNamespaces([], [])).toEqual([]);
  });

  it('drops a row with no namespace name (defensive against a malformed response)', () => {
    const tenantWide: NamespaceResponse[] = [{ namespace: undefined, entityBacked: true }];
    expect(mergeNamespaces(tenantWide, [])).toEqual([]);
  });

  it('carries entityBacked=false and a defaultSchemaId through unchanged', () => {
    const tenantWide: NamespaceResponse[] = [
      {
        namespace: 'org',
        entityBacked: false,
        contextId: undefined,
        defaultSchemaId: 'schema_123',
      },
    ];
    const result = mergeNamespaces(tenantWide, []);
    expect(result).toEqual([
      { namespace: 'org', entityBacked: false, contextId: null, defaultSchemaId: 'schema_123' },
    ]);
  });
});
