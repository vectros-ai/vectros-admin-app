// ---------------------------------------------------------------------------
// drainPages tests — the cursor-paginator behind the auth-list enumerations
// (context list + per-context counts, role/profile pickers). A regression here
// silently truncates or hangs enumeration, so every termination branch is
// covered: null-cursor stop, absent-cursor stop, the non-advancing-cursor
// guard, the maxPages ceiling, an empty page, and cursor threading.
// ---------------------------------------------------------------------------

import { describe, expect, it, vi } from 'vitest';

import { drainPages, type CursorPage } from './drainPages';

interface Item {
  readonly id: string;
}

/** Build a fetchPage backed by fixed pages, recording the cursors it was called with. */
function pagedFetcher(pages: ReadonlyArray<CursorPage<Item>>): {
  fetchPage: (startFrom: string | undefined) => Promise<CursorPage<Item>>;
  calls: Array<string | undefined>;
} {
  const calls: Array<string | undefined> = [];
  let index = 0;
  const fetchPage = (startFrom: string | undefined): Promise<CursorPage<Item>> => {
    calls.push(startFrom);
    const page = pages[index] ?? { data: [], nextCursor: null };
    index++;
    return Promise.resolve(page);
  };
  return { fetchPage, calls };
}

describe('drainPages', () => {
  it('follows nextCursor across pages and concatenates in order', async () => {
    const { fetchPage, calls } = pagedFetcher([
      { data: [{ id: 'a' }, { id: 'b' }], nextCursor: 'b' },
      { data: [{ id: 'c' }], nextCursor: null }, // null cursor → terminal
    ]);
    const result = await drainPages(fetchPage);
    expect(result.map((i) => i.id)).toEqual(['a', 'b', 'c']);
    // First page no cursor; second page seeded from page 1's nextCursor.
    expect(calls).toEqual([undefined, 'b']);
  });

  it('stops on an absent cursor (undefined) even when the page is full', async () => {
    const { fetchPage, calls } = pagedFetcher([
      { data: [{ id: 'a' }, { id: 'b' }] }, // no nextCursor field → exhausted
    ]);
    const result = await drainPages(fetchPage);
    expect(result.map((i) => i.id)).toEqual(['a', 'b']);
    expect(calls).toEqual([undefined]);
  });

  it('handles an empty first page', async () => {
    const { fetchPage, calls } = pagedFetcher([{ data: [], nextCursor: null }]);
    const result = await drainPages(fetchPage);
    expect(result).toEqual([]);
    expect(calls).toEqual([undefined]);
  });

  it('tolerates a page with no data array', async () => {
    const { fetchPage } = pagedFetcher([{ nextCursor: null }]);
    const result = await drainPages(fetchPage);
    expect(result).toEqual([]);
  });

  it('stops when the cursor does not advance (defensive against a loop)', async () => {
    // Every page returns the SAME non-null cursor → would loop without the guard.
    const fetchPage = vi.fn(() =>
      Promise.resolve<CursorPage<Item>>({ data: [{ id: 'x' }], nextCursor: 'stuck' }),
    );
    const result = await drainPages(fetchPage);
    // Page 1 (startFrom undefined) accepted; page 2 (startFrom 'stuck') returns
    // the same 'stuck' cursor → stop.
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(2);
  });

  it('honors the maxPages ceiling', async () => {
    // Always returns a full, advancing page → only maxPages stops it.
    let n = 0;
    const fetchPage = vi.fn(() =>
      Promise.resolve<CursorPage<Item>>({ data: [{ id: `id-${n}` }], nextCursor: `c-${n++}` }),
    );
    const result = await drainPages(fetchPage, 3);
    expect(fetchPage).toHaveBeenCalledTimes(3);
    expect(result).toHaveLength(3);
  });
});
