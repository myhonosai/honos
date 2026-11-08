import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';

/**
 * Opaque keyset cursor for school-scoped list reads.
 *
 * A cursor carries only the last row's sort key. It never grants scope: the read re-resolves authority and filters by
 * the exact organization and school on every page. The cursor is bound to the list, the exact school and the filter
 * that produced it, so a cursor from another school, another list or a different filter is refused instead of
 * silently skipping or repeating rows. Timestamps are carried as exact microsecond UTC text (never a JavaScript Date,
 * which would drop microseconds and repeat or skip rows sharing a millisecond).
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const CURSOR_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const MAX_CURSOR_LENGTH = 1024;

export type ListCursorKey = string;

function binding(list: string, schoolId: string, filter: unknown): string {
  return createHash('sha256').update(JSON.stringify([list, schoolId.toLowerCase(), filter ?? null])).digest('base64url').slice(0, 22);
}

function invalidCursor(): never {
  throw new BadRequestException({ code: 'INVALID_CURSOR', detail: 'The page cursor is not valid for this list, school and filter. Reload the first page.' });
}

export function encodeListCursor(list: string, schoolId: string, filter: unknown, keys: readonly ListCursorKey[]): string {
  return Buffer.from(JSON.stringify({ v: 1, b: binding(list, schoolId, filter), k: keys }), 'utf8').toString('base64url');
}

/**
 * Decodes a cursor and checks its binding and key shapes. `shapes` lists, per key, `instant`, `uuid` or `text`
 * (bounded text such as a name). Any mismatch is a 400 INVALID_CURSOR; nothing is read.
 */
export function decodeListCursor(
  cursor: string | undefined,
  list: string,
  schoolId: string,
  filter: unknown,
  shapes: readonly ('instant' | 'uuid' | 'text')[],
): string[] | null {
  if (cursor === undefined) return null;
  if (typeof cursor !== 'string' || !cursor || cursor.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(cursor)) invalidCursor();
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); } catch { invalidCursor(); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) invalidCursor();
  const value = parsed as Record<string, unknown>;
  if (Object.keys(value).sort().join(',') !== 'b,k,v' || value.v !== 1 || value.b !== binding(list, schoolId, filter)) invalidCursor();
  const keys = value.k;
  if (!Array.isArray(keys) || keys.length !== shapes.length) invalidCursor();
  keys.forEach((key, index) => {
    if (typeof key !== 'string') invalidCursor();
    const shape = shapes[index];
    if (shape === 'instant' && !CURSOR_INSTANT.test(key)) invalidCursor();
    if (shape === 'uuid' && !UUID.test(key)) invalidCursor();
    if (shape === 'text' && (key.length > 400 || key.includes('\u0000'))) invalidCursor();
  });
  return keys as string[];
}

/** SQL expression rendering a timestamptz as the exact cursor instant text, independent of the session TimeZone. */
export function cursorInstantSql(column: string): string {
  return `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}
