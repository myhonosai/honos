import { BadRequestException } from '@nestjs/common';
import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Signed opaque keyset cursor for school-scoped list reads.
 *
 * A cursor carries only the previous page's last position. It never grants scope: the read re-resolves authority and
 * filters by the exact organization and school on every page. The whole canonical payload (format version, list,
 * exact school, filter and every position key) is authenticated with a server-owned HMAC, so a cursor that was edited,
 * re-bound to another school, list or filter, or minted by a client is refused with 400 INVALID_CURSOR instead of
 * silently skipping or repeating rows. Timestamps are exact microsecond UTC text rendered by SQL (never a JavaScript
 * Date, which drops microseconds).
 *
 * Key: HKDF-SHA256 of the API's own session-signing secret (HON_SESSION_JWT_SECRET, required in production and staging
 * by the startup gate and shared by every API instance), domain-separated by salt and info so it can never verify a
 * session. Without a valid session secret (local tests) a per-process random key is used: cursors then expire with the
 * process, which only means the client reloads the first page.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INSTANT = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d{3})(\d{3})Z$/;
const VERSION = /^[1-9]\d{0,15}$/;
/** Generated cursors are fixed-size (no free text), so this bound always leaves room for every valid cursor. */
export const MAX_LIST_CURSOR_LENGTH = 512;
const processKey = randomBytes(32);

export type ListCursorShape = 'instant' | 'uuid' | 'version';

function cursorKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const secret = env.HON_SESSION_JWT_SECRET;
  if (!secret || Buffer.byteLength(secret) < 32) return processKey;
  return Buffer.from(hkdfSync('sha256', Buffer.from(secret, 'utf8'), 'hon-list-cursor', 'hon.list-cursor.v1', 32));
}

function canonical(list: string, schoolId: string, filter: unknown, payload: string): string {
  return JSON.stringify(['hon.list-cursor.v1', list, schoolId.toLowerCase(), filter ?? null, payload]);
}

function sign(list: string, schoolId: string, filter: unknown, payload: string): Buffer {
  return createHmac('sha256', cursorKey()).update(canonical(list, schoolId, filter, payload)).digest();
}

function invalidCursor(): never {
  throw new BadRequestException({ code: 'INVALID_CURSOR', detail: 'The page cursor is not valid for this list, school and filter, or the list changed. Reload the first page.' });
}

/** True only for a real calendar instant with exactly six fractional digits. */
export function isCursorInstant(value: string): boolean {
  const match = INSTANT.exec(value);
  if (!match) return false;
  const parsed = new Date(`${match[1]}.${match[2]}Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === `${match[1]}.${match[2]}Z`;
}

function validKey(shape: ListCursorShape, key: unknown): key is string {
  if (typeof key !== 'string') return false;
  if (shape === 'instant') return isCursorInstant(key);
  if (shape === 'uuid') return UUID.test(key);
  return VERSION.test(key) && Number.isSafeInteger(Number(key));
}

export function encodeListCursor(list: string, schoolId: string, filter: unknown, shapes: readonly ListCursorShape[], keys: readonly string[]): string {
  if (keys.length !== shapes.length || keys.some((key, index) => !validKey(shapes[index]!, key))) {
    throw new Error('HON list cursor key does not match its declared shape.');
  }
  const payload = Buffer.from(JSON.stringify({ v: 1, k: keys }), 'utf8').toString('base64url');
  const cursor = `${payload}.${sign(list, schoolId, filter, payload).toString('base64url')}`;
  if (cursor.length > MAX_LIST_CURSOR_LENGTH) throw new Error('HON list cursor exceeds its fixed bound.');
  return cursor;
}

/**
 * Verifies the signature against the exact list, school and filter of this request, then the key shapes. Any mismatch
 * is a 400 INVALID_CURSOR before any database work.
 */
export function decodeListCursor(
  cursor: string | undefined,
  list: string,
  schoolId: string,
  filter: unknown,
  shapes: readonly ListCursorShape[],
): string[] | null {
  if (cursor === undefined) return null;
  if (typeof cursor !== 'string' || cursor.length > MAX_LIST_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(cursor)) invalidCursor();
  const [payload, signature] = cursor.split('.') as [string, string];
  const supplied = Buffer.from(signature, 'base64url');
  const expected = sign(list, schoolId, filter, payload);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) invalidCursor();
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { invalidCursor(); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) invalidCursor();
  const value = parsed as Record<string, unknown>;
  if (Object.keys(value).sort().join(',') !== 'k,v' || value.v !== 1) invalidCursor();
  const keys = value.k;
  if (!Array.isArray(keys) || keys.length !== shapes.length || keys.some((key, index) => !validKey(shapes[index]!, key))) invalidCursor();
  return keys as string[];
}

/** Thrown when a correctly signed cursor's anchor row no longer exists or changed since the page was read. */
export function staleListCursor(): never { invalidCursor(); }

/** SQL expression rendering a timestamptz as the exact cursor instant text, independent of the session TimeZone. */
export function cursorInstantSql(column: string): string {
  return `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}
