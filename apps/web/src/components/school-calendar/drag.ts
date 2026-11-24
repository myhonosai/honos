/**
 * Calendar card drag, resize and keyboard maths (0567). Pure: every value is school-local minutes after midnight on a
 * visible day, and an instant is made only from a school date, minutes and the school zone the server reports.
 */
export const SNAP_MINUTES = 15;
export const DEFAULT_LENGTH = 60;
export const MAX_LENGTH = 600;
const DAY = 24 * 60;

export const snap = (minutes: number, step = SNAP_MINUTES): number => Math.round(minutes / step) * step;
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/** The 15-minute slot under a point `offsetY` pixels below the top of a day column that starts at `firstHour`. */
export function slotAt(offsetY: number, firstHour: number, hourHeight: number): number {
  const minutes = firstHour * 60 + Math.floor((Math.max(0, offsetY) * 60) / hourHeight / SNAP_MINUTES) * SNAP_MINUTES;
  return clamp(minutes, 0, DAY - SNAP_MINUTES);
}

export type DragOrigin = Readonly<{ mode: 'move' | 'resize'; dayIndex: number; start: number; end: number; days: number }>;
export type DragSpot = Readonly<{ dayIndex: number; start: number; end: number }>;

/** Where a card lands after the pointer moved `dxDays` columns and `dyPx` pixels. */
export function dragTarget(origin: DragOrigin, dxDays: number, dyPx: number, hourHeight: number): DragSpot {
  const delta = snap((dyPx * 60) / hourHeight);
  if (origin.mode === 'resize') {
    const end = clamp(origin.end + delta, origin.start + SNAP_MINUTES, Math.min(DAY, origin.start + MAX_LENGTH));
    return { dayIndex: origin.dayIndex, start: origin.start, end };
  }
  const length = origin.end - origin.start, start = clamp(origin.start + delta, 0, DAY - length);
  return { dayIndex: clamp(origin.dayIndex + Math.round(dxDays), 0, origin.days - 1), start, end: start + length };
}

export type KeyStep = Readonly<{ days: number; minutes: number; resize: boolean }>;
/** Alt+Arrow Up/Down moves 15 minutes, Alt+Arrow Left/Right a day; Alt+Shift+Arrow Up/Down changes the length. */
export function keyboardStep(key: string, alt: boolean, shift: boolean): KeyStep | null {
  if (!alt) return null;
  if (key === 'ArrowUp' || key === 'ArrowDown') return { days: 0, minutes: key === 'ArrowUp' ? -SNAP_MINUTES : SNAP_MINUTES, resize: shift };
  if (shift) return null;
  if (key === 'ArrowLeft' || key === 'ArrowRight') return { days: key === 'ArrowLeft' ? -1 : 1, minutes: 0, resize: false };
  return null;
}

const parts = new Map<string, Intl.DateTimeFormat>();
function wall(instant: number, timeZone: string): number {
  let f = parts.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    parts.set(timeZone, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(instant)).map((x) => [x.type, x.value]));
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
}

/** The instant of `minutes` after school-local midnight of `date`, or null when that local time does not exist there. */
export function zonedInstant(date: string, minutes: number, timeZone: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m || !Number.isInteger(minutes) || minutes < 0 || minutes > DAY) return null;
  const local = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, minutes);
  if (new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).toISOString().slice(0, 10) !== date) return null;
  let guess = local - (wall(local, timeZone) - local);
  guess = local - (wall(guess, timeZone) - guess);
  return wall(guess, timeZone) === local ? new Date(guess).toISOString() : null;
}
