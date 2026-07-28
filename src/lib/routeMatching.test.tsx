// ---------------------------------------------------------------------------
// Route-matching regression tests.
//
// The router is a load-bearing dependency whose matching and path-encoding
// rules changed under us, in two ways a page-level suite does not notice:
//
//   * RANKING between a static segment and a sibling dynamic one. If :ctxId
//     out-ranks the literal "contexts", then /access/contexts renders the
//     DETAIL page for a context named "contexts" — a real page, mounted
//     without error, so any test that only asserts "something rendered" stays
//     green while the list becomes unreachable.
//   * Path-param ENCODING. The encoder follows RFC 3986 path-segment rules, so
//     the pchar set ($ & + , ; = : @) is left literal rather than
//     percent-encoded. Principal ids here are email-shaped — `+` and `@` are
//     both realistic and both in that set — so an encode/match round-trip is
//     exactly where a silent regression lands.
//
// Both are asserted through a RENDERED router, not through matchPath(): only a
// rendered Routes tree can express "which sibling won", and matchPath() does
// not decode params the way the router does (it returns "a%3Fb" where the
// router hands the page "a?b"), so asserting against it would pin the wrong
// contract.
//
// Patterns are copied from App.tsx — keep them in sync.
// ---------------------------------------------------------------------------

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MemoryRouter, Navigate, Route, Routes, generatePath, useParams } from 'react-router';

const CONTEXTS = '/access/contexts';
const CONTEXT_DETAIL = '/access/contexts/:ctxId';
const ROLE_EDITOR = '/access/contexts/:ctxId/roles/:tplId';
const PROFILE_EDITOR = '/access/contexts/:ctxId/profiles/:principalId';

/** Renders the id of whichever route matched, plus its params. */
function Marker({ id }: { id: string }) {
  const params = useParams();
  return (
    <div>
      <span data-testid="route">{id}</span>
      <span data-testid="ctxId">{params.ctxId ?? ''}</span>
      <span data-testid="tplId">{params.tplId ?? ''}</span>
      <span data-testid="principalId">{params.principalId ?? ''}</span>
    </div>
  );
}

/**
 * The access-section route table, mirroring App.tsx's sibling ORDER and
 * patterns. Sibling order matters: it is the tie-breaker the ranking rules
 * fall back on, so a test that reorders them is not testing the real table.
 */
function AccessRoutes() {
  return (
    <Routes>
      <Route path="/access" element={<Navigate to="/access/contexts" replace />} />
      <Route path={CONTEXTS} element={<Marker id="contexts-list" />} />
      <Route path={CONTEXT_DETAIL} element={<Marker id="context-detail" />} />
      <Route path={ROLE_EDITOR} element={<Marker id="role-editor" />} />
      <Route path={PROFILE_EDITOR} element={<Marker id="profile-editor" />} />
      <Route path="*" element={<Marker id="not-found" />} />
    </Routes>
  );
}

function renderAt(url: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <AccessRoutes />
    </MemoryRouter>,
  );
}

const matched = () => screen.getByTestId('route').textContent;

describe('route ranking', () => {
  it('sends the bare list url to the LIST, not to :ctxId', () => {
    renderAt('/access/contexts');
    expect(matched()).toBe('contexts-list');
  });

  it('sends a real context id to the DETAIL route', () => {
    renderAt('/access/contexts/ctx-1');
    expect(matched()).toBe('context-detail');
    expect(screen.getByTestId('ctxId').textContent).toBe('ctx-1');
  });

  it('redirects /access to the contexts list', () => {
    renderAt('/access');
    expect(matched()).toBe('contexts-list');
  });

  it('routes a nested roles url to the role editor', () => {
    renderAt('/access/contexts/c1/roles/r1');
    expect(matched()).toBe('role-editor');
    expect(screen.getByTestId('ctxId').textContent).toBe('c1');
    expect(screen.getByTestId('tplId').textContent).toBe('r1');
  });

  it('routes a nested profiles url to the profile editor', () => {
    renderAt('/access/contexts/c1/profiles/p1');
    expect(matched()).toBe('profile-editor');
    expect(screen.getByTestId('ctxId').textContent).toBe('c1');
    expect(screen.getByTestId('principalId').textContent).toBe('p1');
  });

  it('falls through to the catch-all for a truncated nested url', () => {
    // /access/contexts/c1/roles has no route; it must NOT be absorbed by
    // :ctxId or by the roles pattern.
    renderAt('/access/contexts/c1/roles');
    expect(matched()).toBe('not-found');
  });
});

describe('path-param round-trip', () => {
  // Every value is one a principal id can really take. The first group sits in
  // the RFC 3986 pchar set whose encoding changed; the second is the
  // structural characters that must stay escaped so a crafted id cannot break
  // out of its own path segment into a different route.
  const IDS = [
    'alice@example.com',
    'alice+admin@example.com',
    'user.name+tag@example.com',
    'id:with:colons',
    'id,with,commas',
    'id=with=equals',
    'id$with&specials',
    'plain-id-123',
    'a/b',
    'a?b',
    'a#b',
    'a%b',
    'a b',
    'ä-unicode',
  ];

  it.each(IDS)('generatePath -> router -> useParams returns %j unchanged', (principalId) => {
    const url = generatePath(PROFILE_EDITOR, { ctxId: 'ctx-1', principalId });
    renderAt(url);

    // The link must still land on the profile route — an id that escaped its
    // segment would match a different route (or the catch-all) instead.
    expect(matched()).toBe('profile-editor');
    // And the page must read back exactly what was put in. Whether the encoder
    // percent-encoded a character or left it literal is its business; the
    // decoded value the page sees is the contract.
    expect(screen.getByTestId('principalId').textContent).toBe(principalId);
    expect(screen.getByTestId('ctxId').textContent).toBe('ctx-1');
  });

  it('round-trips a role id through the roles pattern too', () => {
    const url = generatePath(ROLE_EDITOR, { ctxId: 'ctx-1', tplId: 'role+one@v2' });
    renderAt(url);

    expect(matched()).toBe('role-editor');
    expect(screen.getByTestId('tplId').textContent).toBe('role+one@v2');
  });
});
