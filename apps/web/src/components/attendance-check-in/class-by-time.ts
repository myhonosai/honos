'use client';
import { useEffect, useState } from 'react';
import type { CurrentSchoolClassSession } from '@hon/contracts';

/**
 * Choosing the class by the clock, from the school's own schedule. Check-in opens this long before a class starts, so a
 * front desk is already on the next class while the last one finishes.
 */
export const CHECK_IN_OPENS_MS = 30 * 60_000;
export const CLASS_BY_TIME_TICK_MS = 60_000;

type Timed = Pick<CurrentSchoolClassSession, 'sessionId' | 'startsAt' | 'endsAt' | 'status'>;

/**
 * The class to check in to now: the latest class that has opened for check-in and not ended; else the next class to
 * start; else the last class of the list. Cancelled classes are never chosen. '' when there is none.
 */
export function classForNow(sessions: readonly Timed[], now = Date.now()): string {
  const live = sessions.filter((s) => s.status !== 'CANCELLED').sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
  const open = live.filter((s) => Date.parse(s.startsAt) - CHECK_IN_OPENS_MS <= now && now < Date.parse(s.endsAt));
  if (open.length) return open[open.length - 1]!.sessionId;
  return (live.find((s) => Date.parse(s.startsAt) > now) ?? live[live.length - 1])?.sessionId ?? '';
}

/**
 * While "by time" is on, the class follows the clock (checked every minute) except while `paused` (a check-in is being
 * sent or confirmed). Choosing a class by hand turns it off; staff can turn it back on.
 */
export function useClassByTime(sessions: readonly Timed[] | null, choose: (sessionId: string) => void, paused = false): [boolean, (on: boolean) => void] {
  const [auto, setAuto] = useState(true);
  useEffect(() => {
    if (!auto || !sessions || paused) return undefined;
    let last = '';
    const pick = () => { const id = classForNow(sessions); if (id && id !== last) { last = id; choose(id); } };
    pick();
    const timer = setInterval(pick, CLASS_BY_TIME_TICK_MS);
    return () => clearInterval(timer);
  }, [auto, sessions, paused]); // eslint-disable-line react-hooks/exhaustive-deps
  return [auto, setAuto];
}
