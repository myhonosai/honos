import { expect, it } from 'vitest';
import { addDays, calendarRange, hourBounds, layoutLanes, localDateOf, localMinutesOf, monthGrid, parseCalendarTab, parseCalendarView, shiftAnchor, weekStart } from '../src/components/school-calendar/range';

it('computes the visible range for day, week (Monday start, like the Manus scheduler) and month views, end exclusive', () => {
  expect(calendarRange('day', '2026-11-18')).toEqual({ start: '2026-11-18', end: '2026-11-19' });
  expect(weekStart('2026-11-18')).toBe('2026-11-16');
  expect(weekStart('2026-11-16')).toBe('2026-11-16');
  expect(weekStart('2026-11-15')).toBe('2026-11-09');
  expect(calendarRange('week', '2026-11-18')).toEqual({ start: '2026-11-16', end: '2026-11-23' });
  // Month view covers the whole weeks that hold the month.
  expect(calendarRange('month', '2026-11-18')).toEqual({ start: '2026-10-26', end: '2026-12-07' });
  expect(calendarRange('month', '2026-06-10')).toEqual({ start: '2026-06-01', end: '2026-07-06' });
});

it('shifts the anchor by one day, week or month, clamping the day of month', () => {
  expect(shiftAnchor('day', '2026-12-31', 1)).toBe('2027-01-01');
  expect(shiftAnchor('week', '2026-11-18', -1)).toBe('2026-11-11');
  expect(shiftAnchor('month', '2026-01-31', 1)).toBe('2026-02-28');
  expect(shiftAnchor('month', '2026-03-15', -1)).toBe('2026-02-15');
  expect(addDays('2026-11-30', 1)).toBe('2026-12-01');
});

it('builds a month grid of whole weeks, marking days outside the month', () => {
  const grid = monthGrid('2026-11-18');
  expect(grid).toHaveLength(6);
  expect(grid.every((w) => w.length === 7)).toBe(true);
  expect(grid[0]![0]).toEqual({ date: '2026-10-26', inMonth: false });
  expect(grid[0]![6]).toEqual({ date: '2026-11-01', inMonth: true });
  expect(grid[5]![6]).toEqual({ date: '2026-12-06', inMonth: false });
});

it('finds the school-local date and minutes after midnight of an instant', () => {
  expect(localDateOf('2026-11-16T07:30:00.000Z', 'America/Los_Angeles')).toBe('2026-11-15');
  expect(localDateOf('2026-11-16T07:30:00.000Z', 'Asia/Seoul')).toBe('2026-11-16');
  expect(localMinutesOf('2026-11-17T00:30:00.000Z', 'America/Los_Angeles')).toBe(16 * 60 + 30);
  expect(localMinutesOf('2026-11-16T15:00:00.000Z', 'Asia/Seoul')).toBe(0);
});

it('places overlapping classes side by side and keeps separate ones full width', () => {
  const lanes = layoutLanes([{ start: 1110, end: 1155 }, { start: 1110, end: 1170 }, { start: 1170, end: 1215 }, { start: 1200, end: 1260 }, { start: 600, end: 660 }]);
  expect(lanes).toEqual([{ lane: 0, lanes: 2 }, { lane: 1, lanes: 2 }, { lane: 0, lanes: 2 }, { lane: 1, lanes: 2 }, { lane: 0, lanes: 1 }]);
  expect(hourBounds([{ start: 6 * 60 + 30, end: 7 * 60 + 30 }, { start: 20 * 60, end: 21 * 60 + 15 }])).toEqual({ first: 6, last: 22 });
  expect(hourBounds([])).toEqual({ first: 7, last: 21 });
});

it('accepts only closed tab and view values', () => {
  expect(parseCalendarTab('timetable')).toBe('timetable');
  expect(parseCalendarTab('events')).toBe('events');
  expect(parseCalendarTab(['events'])).toBe('calendar');
  expect(parseCalendarTab('nope')).toBe('calendar');
  expect(parseCalendarView('month')).toBe('month');
  expect(parseCalendarView(undefined)).toBe('week');
});
