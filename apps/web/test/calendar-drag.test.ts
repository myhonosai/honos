import { describe, expect, it } from 'vitest';
import { dragTarget, keyboardStep, slotAt, snap, zonedInstant, MAX_LENGTH, SNAP_MINUTES } from '../src/components/school-calendar/drag';

describe('calendar drag maths (0551)', () => {
  it('snaps to 15 minutes', () => {
    expect(SNAP_MINUTES).toBe(15);
    expect([0, 7, 8, 22, 23, -7, -8].map((m) => snap(m))).toEqual([0, 0, 15, 15, 30, -0, -15]);
  });
  it('turns a click height into a 15-minute slot from the first hour', () => {
    // 64 px per hour, grid starts at 7 AM
    expect(slotAt(0, 7, 64)).toBe(7 * 60);
    expect(slotAt(15, 7, 64)).toBe(7 * 60);
    expect(slotAt(16, 7, 64)).toBe(7 * 60 + 15);
    expect(slotAt(64 * 3 + 50, 7, 64)).toBe(10 * 60 + 45);
    expect(slotAt(-20, 7, 64)).toBe(7 * 60);
    expect(slotAt(64 * 30, 7, 64)).toBe(24 * 60 - 15);
  });
  it('moves a card by whole days and 15-minute steps, keeping its length inside the day', () => {
    const origin = { mode: 'move' as const, dayIndex: 2, start: 600, end: 660, days: 7 };
    expect(dragTarget(origin, 0, 0, 64)).toEqual({ dayIndex: 2, start: 600, end: 660 });
    expect(dragTarget(origin, 1, 32, 64)).toEqual({ dayIndex: 3, start: 630, end: 690 });
    expect(dragTarget(origin, -5, -4, 64)).toEqual({ dayIndex: 0, start: 600, end: 660 });
    expect(dragTarget(origin, 9, 0, 64)).toEqual({ dayIndex: 6, start: 600, end: 660 });
    expect(dragTarget(origin, 0, -64 * 20, 64)).toEqual({ dayIndex: 2, start: 0, end: 60 });
    expect(dragTarget(origin, 0, 64 * 20, 64)).toEqual({ dayIndex: 2, start: 1380, end: 1440 });
  });
  it('resizes from the bottom edge: at least 15 minutes, at most 600, never past midnight, never another day', () => {
    const origin = { mode: 'resize' as const, dayIndex: 1, start: 600, end: 660, days: 7 };
    expect(dragTarget(origin, 3, 32, 64)).toEqual({ dayIndex: 1, start: 600, end: 690 });
    expect(dragTarget(origin, 0, -200, 64)).toEqual({ dayIndex: 1, start: 600, end: 615 });
    expect(dragTarget(origin, 0, 64 * 40, 64)).toEqual({ dayIndex: 1, start: 600, end: 600 + MAX_LENGTH });
    expect(dragTarget({ ...origin, start: 1320, end: 1380 }, 0, 64 * 5, 64)).toEqual({ dayIndex: 1, start: 1320, end: 1440 });
  });
  it('maps keys: Alt+Up/Down 15 minutes, Alt+Left/Right a day, Alt+Shift+Up/Down resizes', () => {
    expect(keyboardStep('ArrowUp', true, false)).toEqual({ days: 0, minutes: -15, resize: false });
    expect(keyboardStep('ArrowDown', true, false)).toEqual({ days: 0, minutes: 15, resize: false });
    expect(keyboardStep('ArrowLeft', true, false)).toEqual({ days: -1, minutes: 0, resize: false });
    expect(keyboardStep('ArrowRight', true, false)).toEqual({ days: 1, minutes: 0, resize: false });
    expect(keyboardStep('ArrowDown', true, true)).toEqual({ days: 0, minutes: 15, resize: true });
    expect(keyboardStep('ArrowLeft', true, true)).toBeNull();
    expect(keyboardStep('ArrowDown', false, false)).toBeNull();
    expect(keyboardStep('Enter', true, false)).toBeNull();
  });
  it('turns a school date and time into an exact instant in the school zone', () => {
    expect(zonedInstant('2026-11-23', 18 * 60, 'America/Los_Angeles')).toBe('2026-11-24T02:00:00.000Z');
    expect(zonedInstant('2026-07-01', 9 * 60 + 30, 'America/Los_Angeles')).toBe('2026-07-01T16:30:00.000Z');
    expect(zonedInstant('2026-11-23', 0, 'Asia/Seoul')).toBe('2026-11-22T15:00:00.000Z');
    expect(zonedInstant('2026-11-23', 24 * 60, 'UTC')).toBe('2026-11-24T00:00:00.000Z');
    // 2:30 AM does not exist on the spring-forward day.
    expect(zonedInstant('2027-03-14', 2 * 60 + 30, 'America/Los_Angeles')).toBeNull();
    expect(zonedInstant('2026-02-30', 600, 'UTC')).toBeNull();
  });
});
