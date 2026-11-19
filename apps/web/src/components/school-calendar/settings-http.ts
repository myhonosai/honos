import {
  validateCalendarBlockOutInput, validateCalendarBlockOutsQuery, validateCalendarShareSettingsInput, validateCalendarVersionInput, validateShareCalendarInput,
  verifyCalendarBlockOutReceipt, verifyCalendarBlockOutRemoveReceipt, verifyCalendarBlockOuts, verifyCalendarSettings, verifyCalendarShareSettingsReceipt,
  verifyPublicShareCalendar, verifyShareCalendarDeleteReceipt, verifyShareCalendarReceipt, SHARE_CALENDAR_PUBLIC_ID,
  type CalendarBlockOut, type CalendarBlockOutInput, type CalendarBlockOuts, type CalendarSettings, type CalendarShareSettings,
  type CalendarShareSettingsInput, type PublicShareCalendar, type ShareCalendarInput, type ShareCalendarReceipt,
} from '@hon/contracts';
import { CardError, exchange, type CardScope, type Owned } from './cards-http';

/**
 * Calendar settings (0568): the Settings tab read and its commands, the closed days for the calendar view, and the public
 * shared calendar read. Every command sends its own X-HON-Human-Command and Idempotency-Key; the server decides everything again.
 */
export const SETTINGS_COMMANDS = {
  profile: 'schedule.calendar.settings.save', addBlockOut: 'schedule.calendar.block_out.add', removeBlockOut: 'schedule.calendar.block_out.remove',
  saveShare: 'schedule.calendar.share.save', deleteShare: 'schedule.calendar.share.delete',
} as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function id(value: string): string { if (!UUID.test(value)) throw new CardError('INVALID'); return value.toLowerCase(); }
const base = (scope: CardScope) => `/api/v1/organizations/${id(scope.organizationId)}/schools/${id(scope.schoolId)}/schedule/calendar`;
function checked<T>(validate: () => T): T { try { return validate(); } catch { throw new CardError('INVALID'); } }

export interface CalendarSettingsApi {
  read(scope: CardScope, signal: AbortSignal, owned: Owned): Promise<CalendarSettings>;
  blockOuts(scope: CardScope, from: string, to: string, signal: AbortSignal, owned: Owned): Promise<CalendarBlockOuts>;
  saveProfile(scope: CardScope, input: CalendarShareSettingsInput, key: string, signal: AbortSignal, owned: Owned): Promise<CalendarShareSettings>;
  addBlockOut(scope: CardScope, input: CalendarBlockOutInput, key: string, signal: AbortSignal, owned: Owned): Promise<CalendarBlockOut>;
  removeBlockOut(scope: CardScope, blockOutId: string, expectedVersion: number, key: string, signal: AbortSignal, owned: Owned): Promise<unknown>;
  saveShare(scope: CardScope, shareCalendarId: string | null, input: ShareCalendarInput, key: string, signal: AbortSignal, owned: Owned): Promise<ShareCalendarReceipt>;
  deleteShare(scope: CardScope, shareCalendarId: string, expectedVersion: number, key: string, signal: AbortSignal, owned: Owned): Promise<unknown>;
}

export const calendarSettingsApi: CalendarSettingsApi = {
  read(scope, signal, owned) { return Promise.resolve().then(() => exchange(`${base(scope)}/settings`, verifyCalendarSettings, signal, owned)); },
  blockOuts(scope, from, to, signal, owned) {
    return Promise.resolve().then(() => {
      const query = checked(() => validateCalendarBlockOutsQuery({ from, to }));
      return exchange(`${base(scope)}/block-outs?${new URLSearchParams({ from: query.from, to: query.to }).toString()}`, (v) => verifyCalendarBlockOuts(v, query), signal, owned);
    });
  },
  saveProfile(scope, input, key, signal, owned) {
    return Promise.resolve().then(() => {
      const body = checked(() => validateCalendarShareSettingsInput(input));
      return exchange(`${base(scope)}/settings/profile`, (v) => verifyCalendarShareSettingsReceipt(v, body), signal, owned, { name: SETTINGS_COMMANDS.profile, body, key });
    });
  },
  addBlockOut(scope, input, key, signal, owned) {
    return Promise.resolve().then(() => {
      const body = checked(() => validateCalendarBlockOutInput(input));
      return exchange(`${base(scope)}/settings/block-outs`, (v) => verifyCalendarBlockOutReceipt(v, body), signal, owned, { name: SETTINGS_COMMANDS.addBlockOut, body, key });
    });
  },
  removeBlockOut(scope, blockOutId, expectedVersion, key, signal, owned) {
    return Promise.resolve().then(() => {
      const body = checked(() => validateCalendarVersionInput({ expectedVersion }));
      return exchange(`${base(scope)}/settings/block-outs/${id(blockOutId)}/remove`, (v) => verifyCalendarBlockOutRemoveReceipt(v, { blockOutId, input: body }), signal, owned,
        { name: SETTINGS_COMMANDS.removeBlockOut, body, key });
    });
  },
  saveShare(scope, shareCalendarId, input, key, signal, owned) {
    return Promise.resolve().then(() => {
      const body = checked(() => validateShareCalendarInput(input, shareCalendarId !== null));
      const path = shareCalendarId === null ? `${base(scope)}/settings/share-calendars` : `${base(scope)}/settings/share-calendars/${id(shareCalendarId)}/edit`;
      return exchange(path, (v) => verifyShareCalendarReceipt(v, { shareCalendarId, input: body }), signal, owned, { name: SETTINGS_COMMANDS.saveShare, body, key });
    });
  },
  deleteShare(scope, shareCalendarId, expectedVersion, key, signal, owned) {
    return Promise.resolve().then(() => {
      const body = checked(() => validateCalendarVersionInput({ expectedVersion }));
      return exchange(`${base(scope)}/settings/share-calendars/${id(shareCalendarId)}/delete`, (v) => verifyShareCalendarDeleteReceipt(v, { shareCalendarId, input: body }),
        signal, owned, { name: SETTINGS_COMMANDS.deleteShare, body, key });
    });
  },
};

export type PublicCalendarRead = 'LOADING' | 'NOT_FOUND' | 'UNAVAILABLE' | PublicShareCalendar;
/** The public shared calendar: no cookie is sent and no tenant id is read; the link id is the only selector. */
export async function readPublicShareCalendar(publicId: string, signal: AbortSignal): Promise<PublicCalendarRead> {
  if (!SHARE_CALENDAR_PUBLIC_ID.test(publicId)) return 'NOT_FOUND';
  let r: Response;
  try {
    r = await fetch(`/api/v1/public/calendars/${publicId}`, { credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', signal,
      headers: { Accept: 'application/json' } });
  } catch (error) { if (signal.aborted) throw error; return 'UNAVAILABLE'; }
  if (r.status === 404 || r.status === 400) return 'NOT_FOUND';
  if (r.status !== 200) return 'UNAVAILABLE';
  try {
    const value = await r.json() as { data?: unknown };
    return verifyPublicShareCalendar(value.data, publicId);
  } catch { return 'UNAVAILABLE'; }
}
