/**
 * 0552 calendar settings: the school's public address and phone, block-out dates, and share calendars (one program, or a group
 * of program calendars) with a public read. Spec: docs/architecture/CALENDAR_SETTINGS_AND_SHARE_LINKS.md.
 */
import { classSeriesDate } from './class-series.js';

export const SHARE_CALENDAR_KINDS = ['PROGRAM', 'GROUP'] as const;
export type ShareCalendarKind = (typeof SHARE_CALENDAR_KINDS)[number];
export const CALENDAR_BLOCK_OUT_MAX_SPAN_DAYS = 62;
export const SHARE_CALENDAR_PUBLIC_ID = /^[a-f0-9]{48}$/;

export interface CalendarShareSettingsInput { expectedVersion: number | null; address: string; phone: string }
export interface CalendarShareSettings { address: string; phone: string; version: number | null }
export interface CalendarBlockOutInput { label: string; firstDate: string; lastDate: string }
export interface CalendarBlockOut { blockOutId: string; label: string; firstDate: string; lastDate: string; version: number }
export interface CalendarVersionInput { expectedVersion: number }
export interface ShareCalendarInput {
  expectedVersion: number | null; kind: ShareCalendarKind; name: string; description: string; programId: string | null;
  memberIds: string[]; ageMin: number | null; ageMax: number | null; enabled: boolean;
}
export interface ShareCalendar {
  shareCalendarId: string; publicId: string; kind: ShareCalendarKind; name: string; description: string; programId: string | null;
  programName: string | null; memberIds: string[]; ageMin: number | null; ageMax: number | null; enabled: boolean; version: number;
  upcomingCount: number | null;
}
export type ShareCalendarReceipt = Omit<ShareCalendar, 'upcomingCount'>;
export interface ShareCalendarDeleteReceipt { shareCalendarId: string; status: 'DELETED'; version: number }
export interface CalendarBlockOutRemoveReceipt extends CalendarBlockOut { status: 'REMOVED' }
export interface CalendarSettings {
  timezone: string; localToday: string; schoolName: string; settings: CalendarShareSettings; programs: { programId: string; name: string }[];
  blockOuts: CalendarBlockOut[]; shareCalendars: ShareCalendar[];
}
export interface CalendarBlockOutsQuery { from: string; to: string }
export interface CalendarBlockOuts { blockOuts: CalendarBlockOut[] }

export interface PublicShareCalendarCard {
  publicId: string; name: string; description: string; ageMin: number | null; ageMax: number | null; upcomingCount: number;
}
export interface PublicShareCalendarTime {
  name: string; startsAt: string; endsAt: string; localDate: string; localStart: string; localEnd: string; room: string; spotsLeft: number;
}
export interface PublicShareCalendar {
  publicId: string; kind: ShareCalendarKind; name: string; description: string; timezone: string;
  school: { name: string; address: string; phone: string; logoUrl: string | null; accentColor: string | null; contactLine: string | null };
  ageMin: number | null; ageMax: number | null; calendars: PublicShareCalendarCard[]; times: PublicShareCalendarTime[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const CLOCK = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const ZONE = /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/;
const PHONE = /^[0-9+() .-]{3,40}$/;

function invalid(): never { throw new Error('Invalid calendar settings data.'); }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== keys.length || keys.some(key => !(key in row))) invalid();
  return row;
}
function uuid(value: unknown): string { if (typeof value !== 'string' || !UUID.test(value)) invalid(); return value.toLowerCase(); }
function count(value: unknown, minimum: number, maximum = 999_999_999): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) invalid();
  return value;
}
function text(value: unknown, minimum: number, maximum: number): string {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum || value.trim() !== value || CONTROL.test(value)) invalid();
  return value;
}
function bool(value: unknown): boolean { if (typeof value !== 'boolean') invalid(); return value; }
function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T { if (typeof value !== 'string' || !allowed.includes(value as T)) invalid(); return value as T; }
function age(value: unknown): number | null { return value === null ? null : count(value, 0, 99); }
function phone(value: unknown): string { if (typeof value !== 'string' || (value !== '' && !PHONE.test(value))) invalid(); return value; }
function nullableVersion(value: unknown): number | null { return value === null ? null : count(value, 1); }
function publicId(value: unknown): string { if (typeof value !== 'string' || !SHARE_CALENDAR_PUBLIC_ID.test(value)) invalid(); return value; }
function instant(value: unknown): string {
  if (typeof value !== 'string' || !INSTANT.test(value) || new Date(value).toISOString() !== value) invalid();
  return value;
}
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

// Input validators (the database checks the same rules again).
export function validateCalendarShareSettingsInput(value: unknown): CalendarShareSettingsInput {
  const row = record(value, ['expectedVersion', 'address', 'phone']);
  return { expectedVersion: nullableVersion(row.expectedVersion), address: text(row.address, 0, 200), phone: phone(row.phone) };
}
export function validateCalendarBlockOutInput(value: unknown): CalendarBlockOutInput {
  const row = record(value, ['label', 'firstDate', 'lastDate']);
  const input = { label: text(row.label, 1, 80), firstDate: classSeriesDate(row.firstDate), lastDate: classSeriesDate(row.lastDate) };
  const span = daysBetween(input.firstDate, input.lastDate);
  if (span < 0 || span > CALENDAR_BLOCK_OUT_MAX_SPAN_DAYS) invalid();
  return input;
}
export function validateCalendarVersionInput(value: unknown): CalendarVersionInput {
  const row = record(value, ['expectedVersion']);
  return { expectedVersion: count(row.expectedVersion, 1) };
}
export function validateShareCalendarInput(value: unknown, editing: boolean): ShareCalendarInput {
  const row = record(value, ['expectedVersion', 'kind', 'name', 'description', 'programId', 'memberIds', 'ageMin', 'ageMax', 'enabled']);
  if (!Array.isArray(row.memberIds) || row.memberIds.length > 20) invalid();
  const input: ShareCalendarInput = {
    expectedVersion: nullableVersion(row.expectedVersion), kind: oneOf(row.kind, SHARE_CALENDAR_KINDS), name: text(row.name, 1, 80),
    description: text(row.description, 0, 300), programId: row.programId === null ? null : uuid(row.programId), memberIds: row.memberIds.map(uuid),
    ageMin: age(row.ageMin), ageMax: age(row.ageMax), enabled: bool(row.enabled),
  };
  if ((input.expectedVersion === null) === editing || new Set(input.memberIds).size !== input.memberIds.length) invalid();
  if (input.kind === 'PROGRAM' ? input.programId === null || input.memberIds.length || (input.ageMin !== null && input.ageMax !== null && input.ageMin > input.ageMax)
    : input.programId !== null || input.ageMin !== null || input.ageMax !== null || input.memberIds.length < 2) invalid();
  return input;
}
export function validateCalendarBlockOutsQuery(value: unknown): CalendarBlockOutsQuery {
  const row = record(value, ['from', 'to']);
  const query = { from: classSeriesDate(row.from), to: classSeriesDate(row.to) };
  const span = daysBetween(query.from, query.to);
  if (span < 0 || span > 42) invalid();
  return query;
}

// Output verifiers: every database answer is checked strictly before it reaches a client.
export function verifyCalendarShareSettings(value: unknown): CalendarShareSettings {
  const row = record(value, ['address', 'phone', 'version']);
  return { address: text(row.address, 0, 200), phone: phone(row.phone), version: nullableVersion(row.version) };
}
export function verifyCalendarBlockOut(value: unknown): CalendarBlockOut {
  const row = record(value, ['blockOutId', 'label', 'firstDate', 'lastDate', 'version']);
  const out = { blockOutId: uuid(row.blockOutId), label: text(row.label, 1, 80), firstDate: classSeriesDate(row.firstDate), lastDate: classSeriesDate(row.lastDate), version: count(row.version, 1) };
  const span = daysBetween(out.firstDate, out.lastDate);
  if (span < 0 || span > CALENDAR_BLOCK_OUT_MAX_SPAN_DAYS) invalid();
  return out;
}
export function verifyCalendarBlockOutRemoveReceipt(value: unknown, expect: { blockOutId: string; input: CalendarVersionInput }): CalendarBlockOutRemoveReceipt {
  if (!value || typeof value !== 'object' || (value as Record<string, unknown>).status !== 'REMOVED') invalid();
  const { status: _status, ...rest } = value as Record<string, unknown>;
  const out = verifyCalendarBlockOut(rest);
  if (out.blockOutId !== expect.blockOutId.toLowerCase() || out.version !== expect.input.expectedVersion + 1) invalid();
  return { ...out, status: 'REMOVED' };
}
function shareCalendarFields(row: Record<string, unknown>): ShareCalendarReceipt {
  if (!Array.isArray(row.memberIds) || row.memberIds.length > 20) invalid();
  const out: ShareCalendarReceipt = {
    shareCalendarId: uuid(row.shareCalendarId), publicId: publicId(row.publicId), kind: oneOf(row.kind, SHARE_CALENDAR_KINDS), name: text(row.name, 1, 80),
    description: text(row.description, 0, 300), programId: row.programId === null ? null : uuid(row.programId),
    programName: row.programName === null ? null : text(row.programName, 1, 120), memberIds: row.memberIds.map(uuid),
    ageMin: age(row.ageMin), ageMax: age(row.ageMax), enabled: bool(row.enabled), version: count(row.version, 1),
  };
  if ((out.kind === 'PROGRAM') !== (out.programId !== null) || (out.programId === null) !== (out.programName === null)
    || (out.kind === 'PROGRAM' && out.memberIds.length) || (out.kind === 'GROUP' && (out.ageMin !== null || out.ageMax !== null))) invalid();
  return out;
}
export function verifyShareCalendarReceipt(value: unknown, expect: { shareCalendarId: string | null; input: ShareCalendarInput }): ShareCalendarReceipt {
  const out = shareCalendarFields(record(value, ['shareCalendarId', 'publicId', 'kind', 'name', 'description', 'programId', 'programName', 'memberIds', 'ageMin', 'ageMax', 'enabled', 'version']));
  const i = expect.input;
  if ((expect.shareCalendarId !== null && out.shareCalendarId !== expect.shareCalendarId.toLowerCase())
    || out.version !== (i.expectedVersion === null ? 1 : i.expectedVersion + 1) || out.kind !== i.kind || out.name !== i.name
    || out.description !== i.description || out.programId !== i.programId || out.enabled !== i.enabled || out.ageMin !== i.ageMin || out.ageMax !== i.ageMax
    || out.memberIds.join() !== i.memberIds.join()) invalid();
  return out;
}
export function verifyShareCalendarDeleteReceipt(value: unknown, expect: { shareCalendarId: string; input: CalendarVersionInput }): ShareCalendarDeleteReceipt {
  const row = record(value, ['shareCalendarId', 'status', 'version']);
  const out = { shareCalendarId: uuid(row.shareCalendarId), status: oneOf(row.status, ['DELETED'] as const), version: count(row.version, 2) };
  if (out.shareCalendarId !== expect.shareCalendarId.toLowerCase() || out.version !== expect.input.expectedVersion + 1) invalid();
  return out;
}
export function verifyCalendarShareSettingsReceipt(value: unknown, input: CalendarShareSettingsInput): CalendarShareSettings {
  const out = verifyCalendarShareSettings(value);
  if (out.address !== input.address || out.phone !== input.phone || out.version !== (input.expectedVersion === null ? 1 : input.expectedVersion + 1)) invalid();
  return out;
}
export function verifyCalendarBlockOutReceipt(value: unknown, input: CalendarBlockOutInput): CalendarBlockOut {
  const out = verifyCalendarBlockOut(value);
  if (out.label !== input.label || out.firstDate !== input.firstDate || out.lastDate !== input.lastDate || out.version !== 1) invalid();
  return out;
}
export function verifyCalendarSettings(value: unknown): CalendarSettings {
  const row = record(value, ['timezone', 'localToday', 'schoolName', 'settings', 'programs', 'blockOuts', 'shareCalendars']);
  if (typeof row.timezone !== 'string' || !ZONE.test(row.timezone) || row.timezone.length > 64) invalid();
  if (!Array.isArray(row.programs) || row.programs.length > 200 || !Array.isArray(row.blockOuts) || row.blockOuts.length > 500
    || !Array.isArray(row.shareCalendars) || row.shareCalendars.length > 40) invalid();
  const out: CalendarSettings = {
    timezone: row.timezone, localToday: classSeriesDate(row.localToday), schoolName: text(row.schoolName, 1, 120), settings: verifyCalendarShareSettings(row.settings),
    programs: row.programs.map((program) => { const g = record(program, ['programId', 'name']); return { programId: uuid(g.programId), name: text(g.name, 1, 120) }; }),
    blockOuts: row.blockOuts.map(verifyCalendarBlockOut),
    shareCalendars: row.shareCalendars.map((item) => {
      const c = record(item, ['shareCalendarId', 'publicId', 'kind', 'name', 'description', 'programId', 'programName', 'memberIds', 'ageMin', 'ageMax', 'enabled', 'version', 'upcomingCount']);
      const base = shareCalendarFields(c);
      const upcomingCount = c.upcomingCount === null ? null : count(c.upcomingCount, 0, 200);
      if ((base.kind === 'PROGRAM') !== (upcomingCount !== null)) invalid();
      return { ...base, upcomingCount };
    }),
  };
  if (new Set(out.shareCalendars.map(c => c.publicId)).size !== out.shareCalendars.length) invalid();
  return out;
}
export function verifyCalendarBlockOuts(value: unknown, query: CalendarBlockOutsQuery): CalendarBlockOuts {
  const row = record(value, ['blockOuts']);
  if (!Array.isArray(row.blockOuts) || row.blockOuts.length > 200) invalid();
  const blockOuts = row.blockOuts.map(verifyCalendarBlockOut);
  if (blockOuts.some(b => b.firstDate > query.to || b.lastDate < query.from)) invalid();
  return { blockOuts };
}
export function verifyPublicShareCalendar(value: unknown, expectPublicId: string): PublicShareCalendar {
  const row = record(value, ['publicId', 'kind', 'name', 'description', 'timezone', 'school', 'ageMin', 'ageMax', 'calendars', 'times']);
  if (typeof row.timezone !== 'string' || !ZONE.test(row.timezone) || row.timezone.length > 64) invalid();
  const s = record(row.school, ['name', 'address', 'phone', 'logoUrl', 'accentColor', 'contactLine']);
  const nullableString = (v: unknown, max: number) => v === null ? null : typeof v === 'string' && v.length <= max ? v : invalid();
  if (!Array.isArray(row.calendars) || row.calendars.length > 20 || !Array.isArray(row.times) || row.times.length > 200) invalid();
  const out: PublicShareCalendar = {
    publicId: publicId(row.publicId), kind: oneOf(row.kind, SHARE_CALENDAR_KINDS), name: text(row.name, 1, 80), description: text(row.description, 0, 300),
    timezone: row.timezone,
    school: { name: text(s.name, 1, 200), address: text(s.address, 0, 200), phone: phone(s.phone), logoUrl: nullableString(s.logoUrl, 2048),
      accentColor: nullableString(s.accentColor, 7), contactLine: nullableString(s.contactLine, 160) },
    ageMin: age(row.ageMin), ageMax: age(row.ageMax),
    calendars: row.calendars.map((item) => {
      const c = record(item, ['publicId', 'name', 'description', 'ageMin', 'ageMax', 'upcomingCount']);
      return { publicId: publicId(c.publicId), name: text(c.name, 1, 80), description: text(c.description, 0, 300), ageMin: age(c.ageMin), ageMax: age(c.ageMax),
        upcomingCount: count(c.upcomingCount, 0, 200) };
    }),
    times: row.times.map((item) => {
      const t = record(item, ['name', 'startsAt', 'endsAt', 'localDate', 'localStart', 'localEnd', 'room', 'spotsLeft']);
      const clock = (v: unknown) => typeof v === 'string' && CLOCK.test(v) ? v : invalid();
      return { name: text(t.name, 1, 200), startsAt: instant(t.startsAt), endsAt: instant(t.endsAt), localDate: classSeriesDate(t.localDate),
        localStart: clock(t.localStart), localEnd: clock(t.localEnd), room: text(t.room, 0, 200), spotsLeft: count(t.spotsLeft, 0, 100_000) };
    }),
  };
  if (out.publicId !== expectPublicId || (out.kind === 'PROGRAM' && out.calendars.length) || (out.kind === 'GROUP' && out.times.length)) invalid();
  return out;
}

/** The public link and iframe embed code of a share calendar, for a web origin such as https://app.example. */
export function shareCalendarLinks(origin: string, id: string): { link: string; embed: string } {
  const link = `${origin.replace(/\/$/, '')}/calendars/${publicId(id)}`;
  return { link, embed: `<iframe src="${link}" title="Class calendar" width="100%" height="720" style="border:0" loading="lazy"></iframe>` };
}
