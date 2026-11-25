/**
 * Kai teaching journal (KJ1, migration 0685). Owner request (David, 2026-11-18): instructors tell Kai, by voice or text, what
 * they taught; Kai recalls it ("what did we work on last week?") and offers a few suggestions from the patterns. This piece
 * uses no AI: recall is a fixed period parser and the suggestions are fixed rules over the instructor's own entries.
 * The database checks every input rule again. Spec: docs/architecture/KAI_TEACHING_JOURNAL.md.
 */
export const KAI_JOURNAL_LIMITS = Object.freeze({
  notesMax: 2000, classNameMax: 80, topicMax: 40, topicsMax: 10,
  /** Longest range one read may cover, in days (inclusive). */ rangeDays: 120,
  /** Most entries one read returns. */ readLimit: 300,
  /** How far back an entry's date may be. */ pastDays: 400,
  /** Window the suggestions look at. */ patternDays: 90,
});
export const KAI_JOURNAL_SOURCES = ['TYPED', 'SPOKEN'] as const;
export type KaiJournalSource = typeof KAI_JOURNAL_SOURCES[number];
export const KAI_JOURNAL_STATUSES = ['ACTIVE', 'REMOVED'] as const;
export type KaiJournalStatus = typeof KAI_JOURNAL_STATUSES[number];

export interface KaiJournalEntry {
  entryId: string; taughtOn: string; className: string | null;
  /** Null only on a REMOVED receipt: removing erases the text. */ notes: string | null;
  topics: string[]; source: KaiJournalSource; status: KaiJournalStatus;
  /** Shared read-only with the school's teaching team (owner decision 2026-11-18: private by default, each instructor may share). */ shared: boolean;
  version: number; createdAt: string; updatedAt: string;
}
export interface KaiJournalRead { timezone: string; today: string; from: string; to: string; entries: KaiJournalEntry[] }
export interface SaveKaiJournalEntryInput {
  entryId: string | null; expectedVersion: number; taughtOn: string; className: string | null; notes: string;
  topics: string[]; source: KaiJournalSource; status: KaiJournalStatus; shared: boolean;
}
export interface KaiJournalReceipt { entry: KaiJournalEntry; replayed: boolean }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE = /^20\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ZONE = /^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/;
// Single-line text: no control, markup or invisible direction characters.
// eslint-disable-next-line no-control-regex
const UNSAFE_LINE = /[<>\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/;
// Notes may hold line breaks (\n) and nothing else from the control range.
// eslint-disable-next-line no-control-regex
const UNSAFE_NOTES = /[<>\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/;

function invalid(): never { throw new Error('Invalid Kai journal data.'); }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key))) invalid();
  return row;
}
function uuid(value: unknown): string { if (typeof value !== 'string' || !UUID.test(value)) invalid(); return value.toLowerCase(); }
function version(value: unknown, min: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > 999_999_999) invalid();
  return value;
}
function line(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max || value.trim() !== value || UNSAFE_LINE.test(value)) invalid();
  return value;
}
function notesText(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > KAI_JOURNAL_LIMITS.notesMax || value.trim() !== value || UNSAFE_NOTES.test(value)) invalid();
  return value;
}
function date(value: unknown): string { if (!isKaiJournalDate(value)) invalid(); return value; }
function oneOf<T extends string>(value: unknown, list: readonly T[]): T { if (typeof value !== 'string' || !(list as readonly string[]).includes(value)) invalid(); return value as T; }

/** The key two topics are compared by: lower case, inner spaces collapsed. */
export function kaiTopicKey(topic: string): string { return topic.trim().replace(/\s+/g, ' ').toLowerCase(); }
function topicList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > KAI_JOURNAL_LIMITS.topicsMax) invalid();
  const seen = new Set<string>();
  return value.map((item) => {
    const topic = line(item, KAI_JOURNAL_LIMITS.topicMax);
    if (/\s{2}/.test(topic)) invalid();
    const key = kaiTopicKey(topic);
    if (seen.has(key)) invalid();
    seen.add(key);
    return topic;
  });
}

/** A real calendar date (YYYY-MM-DD, 2000-2099). */
export function isKaiJournalDate(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  const at = new Date(Date.UTC(y, m - 1, d));
  return at.getUTCFullYear() === y && at.getUTCMonth() === m - 1 && at.getUTCDate() === d;
}
const dayNumber = (value: string): number => { const [y, m, d] = value.split('-').map(Number) as [number, number, number]; return Date.UTC(y, m - 1, d) / 86_400_000; };
/** Whole days from a to b (b minus a). */
export function kaiDaysBetween(a: string, b: string): number { return dayNumber(b) - dayNumber(a); }
export function kaiAddDays(value: string, days: number): string { return new Date((dayNumber(value) + days) * 86_400_000).toISOString().slice(0, 10); }
/** A read range: real dates, from <= to, at most 120 days inclusive. */
export function isKaiJournalRange(from: unknown, to: unknown): boolean {
  return isKaiJournalDate(from) && isKaiJournalDate(to) && kaiDaysBetween(from, to) >= 0 && kaiDaysBetween(from, to) < KAI_JOURNAL_LIMITS.rangeDays;
}

/** Closed check of a save before it is sent. Throws on anything else. */
export function validateSaveKaiJournalEntryInput(value: unknown): SaveKaiJournalEntryInput {
  const row = record(value, ['entryId', 'expectedVersion', 'taughtOn', 'className', 'notes', 'topics', 'source', 'status', 'shared']);
  const entryId = row.entryId === null ? null : uuid(row.entryId);
  const expectedVersion = version(row.expectedVersion, 0);
  const status = oneOf(row.status, KAI_JOURNAL_STATUSES);
  if (entryId === null ? expectedVersion !== 0 || status !== 'ACTIVE' : expectedVersion < 1) invalid();
  if (typeof row.shared !== 'boolean') invalid();
  return {
    entryId, expectedVersion, taughtOn: date(row.taughtOn), className: row.className === null ? null : line(row.className, KAI_JOURNAL_LIMITS.classNameMax),
    notes: notesText(row.notes), topics: topicList(row.topics), source: oneOf(row.source, KAI_JOURNAL_SOURCES), status, shared: row.shared,
  };
}

function entryOf(value: unknown): KaiJournalEntry {
  const row = record(value, ['entryId', 'taughtOn', 'className', 'notes', 'topics', 'source', 'status', 'shared', 'version', 'createdAt', 'updatedAt']);
  const status = oneOf(row.status, KAI_JOURNAL_STATUSES);
  const removed = status === 'REMOVED';
  if (typeof row.shared !== 'boolean' || (removed && row.shared)) invalid();
  if (removed && (row.notes !== null || row.className !== null || !Array.isArray(row.topics) || row.topics.length)) invalid();
  if (typeof row.createdAt !== 'string' || !INSTANT.test(row.createdAt) || typeof row.updatedAt !== 'string' || !INSTANT.test(row.updatedAt)) invalid();
  return {
    entryId: uuid(row.entryId), taughtOn: date(row.taughtOn),
    className: row.className === null ? null : line(row.className, KAI_JOURNAL_LIMITS.classNameMax),
    notes: removed ? null : notesText(row.notes), topics: topicList(row.topics), source: oneOf(row.source, KAI_JOURNAL_SOURCES), status, shared: row.shared,
    version: version(row.version, 1), createdAt: row.createdAt, updatedAt: row.updatedAt,
  };
}

/** A read answer for exactly the requested range: active entries only, inside the range, newest first, unique. */
export function verifyKaiJournalRead(value: unknown, expected: { from: string; to: string }): KaiJournalRead {
  const row = record(value, ['timezone', 'today', 'from', 'to', 'entries']);
  if (typeof row.timezone !== 'string' || !ZONE.test(row.timezone) || row.from !== expected.from || row.to !== expected.to) invalid();
  const today = date(row.today);
  if (!Array.isArray(row.entries) || row.entries.length > KAI_JOURNAL_LIMITS.readLimit) invalid();
  const seen = new Set<string>();
  let previous: string | null = null;
  const entries = row.entries.map((item) => {
    const entry = entryOf(item);
    if (entry.status !== 'ACTIVE' || seen.has(entry.entryId) || entry.taughtOn < expected.from || entry.taughtOn > expected.to) invalid();
    if (previous !== null && entry.taughtOn > previous) invalid();
    previous = entry.taughtOn; seen.add(entry.entryId);
    return entry;
  });
  return { timezone: row.timezone, today, from: expected.from, to: expected.to, entries };
}

/** A save receipt: the next version, the same entry when one was named, the status that was asked for. */
export function verifyKaiJournalReceipt(value: unknown, input: SaveKaiJournalEntryInput): KaiJournalReceipt {
  const row = record(value, ['entry', 'replayed']);
  if (typeof row.replayed !== 'boolean') invalid();
  const entry = entryOf(row.entry);
  if (entry.version !== input.expectedVersion + 1 || entry.status !== input.status || (input.status === 'ACTIVE' && entry.shared !== input.shared) || (input.entryId !== null && entry.entryId !== input.entryId)) invalid();
  return { entry, replayed: row.replayed };
}

/** One entry another instructor shared with the school's teaching team: what they taught, by display name only. */
export interface KaiTeamJournalEntry { entryId: string; authorName: string; taughtOn: string; className: string | null; notes: string; topics: string[]; updatedAt: string }
export interface KaiTeamJournalRead { today: string; from: string; to: string; entries: KaiTeamJournalEntry[] }
/** The team read for exactly the requested range: inside the range, newest first, unique, no author ids. */
export function verifyKaiTeamJournalRead(value: unknown, expected: { from: string; to: string }): KaiTeamJournalRead {
  const row = record(value, ['today', 'from', 'to', 'entries']);
  if (row.from !== expected.from || row.to !== expected.to || !Array.isArray(row.entries) || row.entries.length > KAI_JOURNAL_LIMITS.readLimit) invalid();
  const today = date(row.today); const seen = new Set<string>(); let previous: string | null = null;
  const entries = row.entries.map((item): KaiTeamJournalEntry => {
    const e = record(item, ['entryId', 'authorName', 'taughtOn', 'className', 'notes', 'topics', 'updatedAt']);
    const entry = { entryId: uuid(e.entryId), authorName: line(e.authorName, 120), taughtOn: date(e.taughtOn),
      className: e.className === null ? null : line(e.className, KAI_JOURNAL_LIMITS.classNameMax), notes: notesText(e.notes), topics: topicList(e.topics),
      updatedAt: typeof e.updatedAt === 'string' && INSTANT.test(e.updatedAt) ? e.updatedAt : invalid() };
    if (seen.has(entry.entryId) || entry.taughtOn < expected.from || entry.taughtOn > expected.to || (previous !== null && entry.taughtOn > previous)) invalid();
    previous = entry.taughtOn; seen.add(entry.entryId);
    return entry;
  });
  return { today, from: expected.from, to: expected.to, entries };
}

/* ------------------------------ recall ------------------------------ */

export type KaiJournalPeriodKind = 'TODAY' | 'YESTERDAY' | 'THIS_WEEK' | 'LAST_WEEK' | 'THIS_MONTH' | 'LAST_MONTH' | 'LAST_DAYS' | 'LAST_WEEKS' | 'DEFAULT';
export interface KaiJournalPeriod { kind: KaiJournalPeriodKind; from: string; to: string; count: number | null; understood: boolean }
const mondayOf = (day: string): string => { const weekday = new Date(dayNumber(day) * 86_400_000).getUTCDay(); return kaiAddDays(day, -((weekday + 6) % 7)); };
const firstOfMonth = (day: string): string => `${day.slice(0, 8)}01`;

/**
 * Turns an instructor's question into a school-local date range. English, Korean and Spanish. Weeks run Monday to Sunday.
 * A question it does not recognise gets the last 14 days with understood=false, so the page can say so.
 */
export function kaiJournalPeriod(question: string, today: string): KaiJournalPeriod {
  if (!isKaiJournalDate(today)) invalid();
  const q = question.normalize('NFC').toLowerCase();
  const at = (kind: KaiJournalPeriodKind, from: string, to: string, count: number | null = null): KaiJournalPeriod => ({ kind, from, to, count, understood: kind !== 'DEFAULT' });
  const days = /(?:last|past)\s+(\d{1,3})\s+days?|지난\s*(\d{1,3})\s*일|[úu]ltimos?\s+(\d{1,3})\s+d[íi]as/.exec(q);
  if (days) { const n = Math.min(Math.max(Number(days[1] ?? days[2] ?? days[3]), 1), KAI_JOURNAL_LIMITS.rangeDays); return at('LAST_DAYS', kaiAddDays(today, 1 - n), today, n); }
  const weeks = /(?:last|past)\s+(\d{1,2})\s+weeks?|지난\s*(\d{1,2})\s*주|[úu]ltimas?\s+(\d{1,2})\s+semanas/.exec(q);
  if (weeks) { const n = Math.min(Math.max(Number(weeks[1] ?? weeks[2] ?? weeks[3]), 1), Math.floor(KAI_JOURNAL_LIMITS.rangeDays / 7)); return at('LAST_WEEKS', kaiAddDays(today, 1 - 7 * n), today, n); }
  if (/yesterday|어제|\bayer\b/.test(q)) { const y = kaiAddDays(today, -1); return at('YESTERDAY', y, y); }
  if (/\btoday\b|오늘|\bhoy\b/.test(q)) return at('TODAY', today, today);
  if (/(?:last|previous)\s+week|(?:지난|저번)\s*주|semana\s+pasada/.test(q)) { const monday = kaiAddDays(mondayOf(today), -7); return at('LAST_WEEK', monday, kaiAddDays(monday, 6)); }
  if (/this\s+week|이번\s*주|esta\s+semana/.test(q)) return at('THIS_WEEK', mondayOf(today), today);
  if (/(?:last|previous)\s+month|(?:지난|저번)\s*달|mes\s+pasado/.test(q)) { const first = firstOfMonth(kaiAddDays(firstOfMonth(today), -1)); return at('LAST_MONTH', first, kaiAddDays(firstOfMonth(today), -1)); }
  if (/this\s+month|이번\s*달|este\s+mes/.test(q)) return at('THIS_MONTH', firstOfMonth(today), today);
  return at('DEFAULT', kaiAddDays(today, -13), today);
}

/** Topics in these entries, most taught first (ties: alphabetical), shown in their most recent spelling. */
export function kaiJournalTopicTally(entries: readonly KaiJournalEntry[]): { topic: string; count: number }[] {
  const tally = new Map<string, { topic: string; count: number; last: string }>();
  for (const entry of entries) if (entry.status === 'ACTIVE') for (const topic of entry.topics) {
    const key = kaiTopicKey(topic); const row = tally.get(key);
    if (!row) tally.set(key, { topic, count: 1, last: entry.taughtOn });
    else { row.count++; if (entry.taughtOn > row.last) { row.last = entry.taughtOn; row.topic = topic; } }
  }
  return [...tally.values()].sort((a, b) => b.count - a.count || kaiTopicKey(a.topic).localeCompare(kaiTopicKey(b.topic))).map(({ topic, count }) => ({ topic, count }));
}

/* ------------------------------ suggestions ------------------------------ */

export type KaiJournalSuggestion =
  | { kind: 'FOCUS'; topic: string; count: number; total: number }
  | { kind: 'REVISIT'; topic: string; daysAgo: number; count: number }
  | { kind: 'LOG'; lastDate: string }
  | { kind: 'TAG' };
export const KAI_JOURNAL_SUGGESTIONS_MAX = 3;

/**
 * Kai's pattern notes, by fixed rules over the last 90 days (no AI). At most three, in this order: one FOCUS, up to two REVISIT,
 * LOG, TAG. Entries dated after today are ignored.
 */
export function kaiJournalSuggestions(entries: readonly KaiJournalEntry[], today: string): KaiJournalSuggestion[] {
  if (!isKaiJournalDate(today)) invalid();
  const recent = entries.filter(e => e.status === 'ACTIVE' && kaiDaysBetween(e.taughtOn, today) >= 0 && kaiDaysBetween(e.taughtOn, today) < KAI_JOURNAL_LIMITS.patternDays)
    .slice().sort((a, b) => b.taughtOn.localeCompare(a.taughtOn) || b.createdAt.localeCompare(a.createdAt));
  if (!recent.length) return [];
  const out: KaiJournalSuggestion[] = [];
  const last28 = recent.filter(e => kaiDaysBetween(e.taughtOn, today) < 28);
  let focusKey: string | null = null;
  if (last28.length >= 4) {
    const top = kaiJournalTopicTally(last28)[0];
    if (top && top.count * 2 >= last28.length) { out.push({ kind: 'FOCUS', topic: top.topic, count: top.count, total: last28.length }); focusKey = kaiTopicKey(top.topic); }
  }
  const seen = new Map<string, { topic: string; count: number; last: string }>();
  for (const entry of recent) for (const topic of entry.topics) {
    const key = kaiTopicKey(topic); const row = seen.get(key);
    if (!row) seen.set(key, { topic, count: 1, last: entry.taughtOn }); else row.count++;
  }
  const revisit = [...seen.entries()]
    .filter(([key, row]) => key !== focusKey && row.count >= 2 && kaiDaysBetween(row.last, today) >= 21)
    .map(([key, row]) => ({ key, ...row, daysAgo: kaiDaysBetween(row.last, today) }))
    .sort((a, b) => b.count - a.count || b.daysAgo - a.daysAgo || a.key.localeCompare(b.key))
    .slice(0, 2);
  for (const row of revisit) out.push({ kind: 'REVISIT', topic: row.topic, daysAgo: row.daysAgo, count: row.count });
  if (kaiDaysBetween(recent[0]!.taughtOn, today) >= 7) out.push({ kind: 'LOG', lastDate: recent[0]!.taughtOn });
  if (recent.slice(0, 5).filter(e => e.topics.length === 0).length >= 3) out.push({ kind: 'TAG' });
  return out.slice(0, KAI_JOURNAL_SUGGESTIONS_MAX);
}

/** Topics used before whose words appear in these notes (for the topic chips), most taught first, at most 6. */
export function kaiJournalTopicHints(notes: string, known: readonly { topic: string; count: number }[], chosen: readonly string[]): string[] {
  const text = ` ${notes.toLowerCase().replace(/\s+/g, ' ')} `;
  const taken = new Set(chosen.map(kaiTopicKey));
  return known.filter(k => !taken.has(kaiTopicKey(k.topic)) && text.includes(kaiTopicKey(k.topic))).slice(0, 6).map(k => k.topic);
}
