import { verifyParentJourneyView } from '@hon/contracts/parent-journey-view';
import { bookingLabel, childSummaries, formatAwardDate, formatClassTime, nextClass, requirementCounts, upcomingFor } from '../src/home/model';
import { journeyBody, NOW } from './fixtures';

const view = verifyParentJourneyView(journeyBody());
const now = new Date(NOW);

describe('home model', () => {
  it('picks the soonest upcoming class across all children and says whose it is', () => {
    const next = nextClass(view, 'all', now);
    expect(next?.childName).toBe('Test Child B');
    expect(next?.booking.name).toBe('Juniors');
  });

  it('scopes the next class to the selected child only', () => {
    expect(nextClass(view, 0, now)?.booking.startsAt).toBe('2026-11-18T23:00:00.000Z');
    expect(nextClass(view, 1, now)?.childName).toBe('Test Child B');
  });

  it('never offers a cancelled or already-started class as next', () => {
    const v = verifyParentJourneyView(journeyBody({ children: [{ ...journeyBody().children[1], schedule: { status: 'AVAILABLE', limited: false, items: [
      { name: 'Juniors', program: 'Juniors', startsAt: '2026-11-17T14:30:00.000Z', endsAt: '2026-11-17T15:30:00.000Z', room: null, bookingStatus: 'BOOKED', sessionStatus: 'SCHEDULED', kind: 'REGULAR' },
      { name: 'Juniors', program: 'Juniors', startsAt: '2026-11-18T22:00:00.000Z', endsAt: '2026-11-18T23:00:00.000Z', room: null, bookingStatus: 'CANCELLED', sessionStatus: 'SCHEDULED', kind: 'REGULAR' },
      { name: 'Juniors', program: 'Juniors', startsAt: '2026-11-19T22:00:00.000Z', endsAt: '2026-11-19T23:00:00.000Z', room: null, bookingStatus: 'BOOKED', sessionStatus: 'CANCELLED', kind: 'REGULAR' },
    ] } }] }));
    expect(nextClass(v, 'all', now)).toBeNull();
  });

  it('returns null for an unknown child position instead of falling back to another child', () => {
    expect(nextClass(view, 7, now)).toBeNull();
  });

  it('labels a waitlisted spot as waitlisted, never as booked', () => {
    expect(bookingLabel('WAITLISTED')).toBe('Waitlisted');
    expect(bookingLabel('BOOKED')).toBe('Booked');
  });

  it('counts only recorded requirement results; unrecorded ones are not counted as missing or met', () => {
    expect(requirementCounts(view.children[0]!.programs[0]!)).toEqual({ met: 1, recorded: 2, total: 3, available: true });
    expect(requirementCounts(view.children[1]!.programs[0]!)).toEqual({ met: 0, recorded: 0, total: 0, available: false });
  });

  it('summarizes each child by position so two children with the same name stay separate', () => {
    const twin = journeyBody(); twin.children[1] = { ...twin.children[1]!, name: 'Test Child A' };
    const s = childSummaries(verifyParentJourneyView(twin));
    expect(s.map(c => c.key)).toEqual(['child-0', 'child-1']);
    expect(s[0]!.rank).toBe('Yellow Belt');
    expect(s[1]!.rank).toBeNull();
    expect(s[0]!.latestAchievement).toBe('Best Forms');
  });

  it('shows class times in the school time zone and says so when it falls back to the phone', () => {
    expect(formatClassTime('2026-11-18T23:00:00.000Z', 'America/Los_Angeles')).toEqual({ text: 'Wed, Nov 18, 3:00 PM', zoneNote: null });
    const fallback = formatClassTime('2026-11-18T23:00:00.000Z', null);
    expect(fallback.zoneNote).toBe("Shown in your phone's time zone");
  });
});

describe('child upcoming list', () => {
  it('lists a child\'s upcoming classes soonest first, skipping past ones', () => {
    const list = upcomingFor(view.children[0]!, now, 5);
    expect(list.map((b: { startsAt: string }) => b.startsAt)).toEqual(['2026-11-18T23:00:00.000Z', '2026-11-19T23:00:00.000Z']);
  });
  it('formats an award date as a calendar date without shifting the day', () => {
    expect(formatAwardDate('2026-11-01')).toBe('Nov 1, 2026');
  });
});
