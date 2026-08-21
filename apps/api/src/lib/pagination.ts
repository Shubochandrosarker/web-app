import { and, asc, desc, or, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { ApiError } from './errors.ts';

/**
 * Keyset pagination.
 *
 * Not OFFSET, for the usual two reasons: `OFFSET 10000` makes Postgres walk
 * ten thousand rows it then discards, and a row inserted between page one and
 * page two shifts every later page by one — so a client paging through a list
 * silently skips a record.
 *
 * A keyset cursor encodes the sort value and the id of the last row returned.
 * The id is what makes the order *total*: sorting by `published_at` alone
 * leaves rows published in the same second in an undefined order, and an
 * undefined order means the cursor cannot say where it got to. Every query
 * here orders by `(sortColumn, id)` and every cursor carries both.
 */

export interface Cursor {
  readonly value: string;
  readonly id: string;
}

/**
 * Cursors are opaque to the client on purpose.
 *
 * base64url rather than a readable pair — not for secrecy, there is nothing
 * secret in it, but so nobody writes a client that constructs one by hand and
 * is then broken by a change to the sort key.
 */
export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(`${cursor.value}|${cursor.id}`, 'utf8').toString('base64url');
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function decodeCursor(raw: string): Cursor {
  const decoded = Buffer.from(raw, 'base64url').toString('utf8');
  const separator = decoded.lastIndexOf('|');
  if (separator === -1) throw ApiError.badRequest('Malformed cursor.');

  const value = decoded.slice(0, separator);
  const id = decoded.slice(separator + 1);

  // Checking the id shape here is cheap, and it stops a hand-built cursor from
  // becoming an invalid-uuid database error reported to the client as a 500.
  if (!UUID_PATTERN.test(id)) throw ApiError.badRequest('Malformed cursor.');

  return { value, id };
}

export type SortDirection = 'asc' | 'desc';

/**
 * The predicate that resumes after a cursor.
 *
 * Logically `(sort, id) < (value, id)` — a row comparison. It is written as
 * the equivalent `sort < value OR (sort = value AND id < id)` because Drizzle
 * has no row-constructor helper; Postgres plans both the same way against the
 * `(sort, id)` index.
 *
 * The values are bound as parameters and cast to the column's own type by
 * Postgres, so a timestamp column and a text cursor value compare correctly
 * without the caller having to know which is which.
 */
export function cursorCondition(
  sortColumn: AnyPgColumn,
  idColumn: AnyPgColumn,
  cursor: Cursor,
  direction: SortDirection,
): SQL {
  const beyond = direction === 'asc' ? sql`>` : sql`<`;

  return sql`(${sortColumn} ${beyond} ${cursor.value} OR (${sortColumn} = ${cursor.value} AND ${idColumn} ${beyond} ${cursor.id}))`;
}

export function orderFor(
  sortColumn: AnyPgColumn,
  idColumn: AnyPgColumn,
  direction: SortDirection,
): SQL[] {
  const order = direction === 'asc' ? asc : desc;
  return [order(sortColumn), order(idColumn)];
}

/** Combine a cursor predicate with the query's other conditions. */
export function withCursor(
  conditions: readonly (SQL | undefined)[],
  cursorClause: SQL | undefined,
): SQL | undefined {
  const all = [...conditions, cursorClause].filter((clause): clause is SQL => clause !== undefined);
  return all.length > 0 ? and(...all) : undefined;
}

/**
 * Turn a fetched page into a response.
 *
 * The caller asks for `limit + 1` rows; the extra one is what says whether a
 * next page exists, without a second COUNT over the same predicate. It is
 * dropped before the rows are returned, and `nextCursor` is built from the
 * last row that *is* returned — building it from the extra row would skip that
 * record on the following page.
 */
export function buildPage<T>(
  rows: readonly T[],
  limit: number,
  toCursor: (row: T) => Cursor,
): { items: T[]; nextCursor: string | undefined } {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : [...rows];
  const last = items.at(-1);

  return {
    items,
    nextCursor: hasMore && last !== undefined ? encodeCursor(toCursor(last)) : undefined,
  };
}

/** `or` re-exported so callers building compound predicates need one import. */
export { or };
