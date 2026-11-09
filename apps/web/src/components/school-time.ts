import { verifyCrmSchoolClock, type CrmSchoolClock } from '@hon/contracts';
import { reportConfirmedSessionInvalidation } from './session-invalidation';

/**
 * B-CRM-3 (0236): CRM times are entered and shown in the school's own timezone. The server names the timezone
 * (GET .../crm/school-clock); this tab never infers it. Every command still sends an offset-qualified UTC instant.
 */
export type SchoolClockScope = Readonly<{ organizationId: string; schoolId: string }>;
export type SchoolClockRead = { state: 'READY'; clock: CrmSchoolClock } | { state: 'UNAVAILABLE' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const schoolClockPath = (s: SchoolClockScope): string => {
  if (!UUID.test(s.organizationId) || !UUID.test(s.schoolId)) throw new Error('Invalid school clock scope.');
  return `/api/v1/organizations/${s.organizationId.toLowerCase()}/schools/${s.schoolId.toLowerCase()}/crm/school-clock`;
};

/** Reads the verified school clock. Any failure is UNAVAILABLE: screens then keep explicit UTC entry. */
export async function readSchoolClock(scope: SchoolClockScope, signal: AbortSignal): Promise<SchoolClockRead> {
  let response: Response;
  try {
    response = await fetch(schoolClockPath(scope), { method: 'GET', mode: 'same-origin', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      referrerPolicy: 'no-referrer', signal, headers: { Accept: 'application/json' } });
  } catch { return { state: 'UNAVAILABLE' }; }
  if (response.status === 401) { reportConfirmedSessionInvalidation(); return { state: 'UNAVAILABLE' }; }
  if (!response.ok) return { state: 'UNAVAILABLE' };
  try {
    const raw = await response.text();
    if (raw.length > 4096) return { state: 'UNAVAILABLE' };
    const body = JSON.parse(raw) as unknown;
    if (!body || typeof body !== 'object' || Array.isArray(body) || !Object.hasOwn(body, 'data')) return { state: 'UNAVAILABLE' };
    const clock = verifyCrmSchoolClock((body as { data: unknown }).data, scope.schoolId);
    if (!validTimeZone(clock.schoolTimezone)) return { state: 'UNAVAILABLE' };
    return { state: 'READY', clock };
  } catch { return { state: 'UNAVAILABLE' }; }
}

export function validTimeZone(zone: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(0); return true; } catch { return false; }
}

const LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;
const parts = (ms: number, zone: string) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(ms).map(x => [x.type, x.value]));
  return { y: +p.year!, mo: +p.month!, d: +p.day!, h: +p.hour!, mi: +p.minute!, s: +p.second! };
};
/** The zone's UTC offset (ms) at one instant. */
const offsetAt = (ms: number, zone: string): number => {
  const q = parts(ms, zone);
  return Date.UTC(q.y, q.mo - 1, q.d, q.h, q.mi, q.s) - Math.floor(ms / 1000) * 1000;
};
const pad = (n: number, w = 2) => String(n).padStart(w, '0');

export type ZonedInstant = { state: 'OK'; instant: string; ambiguous: boolean } | { state: 'INVALID' | 'NONEXISTENT' };

/**
 * Converts a school wall time (datetime-local value, minutes or seconds) to a UTC instant. A time skipped by a
 * daylight-saving change is NONEXISTENT and refused; a repeated time takes its earlier instant and is flagged.
 */
export function schoolLocalToInstant(local: string, zone: string): ZonedInstant {
  const m = LOCAL.exec(local);
  if (!m || !validTimeZone(zone)) return { state: 'INVALID' };
  const [y, mo, d, h, mi, s] = [+m[1]!, +m[2]!, +m[3]!, +m[4]!, +m[5]!, m[6] ? +m[6] : 0];
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  const check = new Date(wall);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d || h > 23 || mi > 59 || s > 59) return { state: 'INVALID' };
  const candidates = [...new Set([offsetAt(wall - 86_400_000, zone), offsetAt(wall, zone), offsetAt(wall + 86_400_000, zone)].map(o => wall - o))]
    .filter(c => { const q = parts(c, zone); return q.y === y && q.mo === mo && q.d === d && q.h === h && q.mi === mi && q.s === s; })
    .sort((a, b) => a - b);
  if (candidates.length === 0) return { state: 'NONEXISTENT' };
  return { state: 'OK', instant: new Date(candidates[0]!).toISOString(), ambiguous: candidates.length > 1 };
}

/** The school wall time (YYYY-MM-DDTHH:mm) of an instant, for prefilling a datetime-local field. */
export function instantToSchoolLocal(instant: string, zone: string): string {
  const ms = Date.parse(instant);
  if (Number.isNaN(ms) || !validTimeZone(zone)) throw new Error('Invalid instant or zone.');
  const q = parts(ms, zone);
  return `${pad(q.y, 4)}-${pad(q.mo)}-${pad(q.d)}T${pad(q.h)}:${pad(q.mi)}`;
}

/** An instant shown in school time, with the zone's short name, in the viewer's language. */
export function formatInSchool(instant: string, zone: string, language: string): string {
  const ms = Date.parse(instant);
  if (Number.isNaN(ms) || !validTimeZone(zone)) return instant;
  try {
    return new Intl.DateTimeFormat(language, { timeZone: zone, dateStyle: 'medium', timeStyle: 'short', timeZoneName: undefined }).format(ms)
      + ' ' + (new Intl.DateTimeFormat(language, { timeZone: zone, timeZoneName: 'short' }).formatToParts(ms).find(p => p.type === 'timeZoneName')?.value ?? zone);
  } catch { return new Date(ms).toISOString(); }
}
