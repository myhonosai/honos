import { absenceWindow, dayLabel, localDate, localMidnight, upcomingDays, zoneOffsetMinutes } from '../src/schedule/absence-model';

describe('planned absence day windows', () => {
  it('computes the school zone offset, including DST', () => {
    expect(zoneOffsetMinutes('America/Los_Angeles', new Date('2026-07-01T12:00:00Z'))).toBe(-420);
    expect(zoneOffsetMinutes('America/Los_Angeles', new Date('2026-12-01T12:00:00Z'))).toBe(-480);
    expect(zoneOffsetMinutes('UTC', new Date('2026-12-01T12:00:00Z'))).toBe(0);
  });

  it('uses the school calendar date, not the phone or UTC date', () => {
    // 2026-11-18 05:00Z is still Nov 17 in Los Angeles.
    expect(localDate('America/Los_Angeles', new Date('2026-11-18T05:00:00Z'))).toBe('2026-11-17');
    expect(localMidnight('America/Los_Angeles', '2026-11-18').toISOString()).toBe('2026-11-18T08:00:00.000Z');
  });

  it('a whole future day runs midnight to midnight, across a DST change', () => {
    const now = new Date('2026-10-30T15:00:00Z');
    expect(absenceWindow('America/Los_Angeles', '2026-11-01', now)).toEqual({ startsAt: '2026-11-01T07:00:00.000Z', endsAt: '2026-11-02T08:00:00.000Z' });
  });

  it('today starts just after now (HON only accepts future starts); a finished day is refused', () => {
    const now = new Date('2026-11-17T15:00:30Z');
    expect(absenceWindow('America/Los_Angeles', '2026-11-17', now)).toEqual({ startsAt: '2026-11-17T15:02:00.000Z', endsAt: '2026-11-18T08:00:00.000Z' });
    expect(absenceWindow('America/Los_Angeles', '2026-11-16', now)).toBeNull();
  });

  it('lists the next 14 days and labels today and tomorrow', () => {
    const days = upcomingDays('America/Los_Angeles', new Date('2026-11-17T15:00:00Z'));
    expect(days).toHaveLength(14);
    expect(days[0]).toBe('2026-11-17');
    expect(dayLabel(days[0]!, days[0]!)).toBe('Today');
    expect(dayLabel(days[1]!, days[0]!)).toBe('Tomorrow');
    expect(dayLabel(days[2]!, days[0]!)).toBe('Thu, Nov 19');
  });
});
