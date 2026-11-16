import { describe, expect, it, vi } from 'vitest';
import { SCREENSAVER_BRIEF_AWAY_MS, SCREENSAVER_IDLE_MS, ScreensaverController } from '../src/components/school-shell/screensaver';

function harness() {
  let now = 1_000_000;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let next = 1;
  const clock = {
    now: () => now,
    set: (fn: () => void, ms: number) => { const id = next++; timers.set(id, { at: now + ms, fn }); return id; },
    clear: (id: unknown) => { timers.delete(id as number); },
  };
  const advance = (ms: number) => {
    now += ms;
    for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); }
  };
  const shown: boolean[] = [];
  const returned = vi.fn();
  const saver = new ScreensaverController(show => shown.push(show), returned, clock);
  return { saver, shown, returned, advance, timers };
}

describe('school screensaver', () => {
  it('shows after five minutes with no activity, and activity restarts the wait', () => {
    const { saver, shown, advance } = harness();
    saver.start();
    advance(SCREENSAVER_IDLE_MS - 1000); saver.activity();
    advance(SCREENSAVER_IDLE_MS - 1000); expect(shown).toEqual([]);
    advance(1000); expect(shown).toEqual([true]); expect(saver.showing()).toBe(true);
  });

  it('a tap lifts it, keeps the school (no conceal) and asks for a quiet re-check', () => {
    const { saver, shown, returned, advance } = harness();
    saver.start(); advance(SCREENSAVER_IDLE_MS);
    saver.dismiss(); saver.dismiss();
    expect(shown).toEqual([true, false]); expect(returned).toHaveBeenCalledTimes(1);
    advance(SCREENSAVER_IDLE_MS); expect(shown).toEqual([true, false, true]);
  });

  it('covers the app as soon as it is hidden; a long absence waits for a tap', () => {
    const { saver, shown, returned, advance } = harness();
    saver.start(); saver.hidden(); expect(shown).toEqual([true]);
    advance(SCREENSAVER_BRIEF_AWAY_MS); saver.visible();
    expect(saver.showing()).toBe(true); expect(returned).not.toHaveBeenCalled();
    saver.dismiss(); expect(returned).toHaveBeenCalledTimes(1);
  });

  it('a brief absence lifts by itself on return, with a quiet re-check', () => {
    const { saver, shown, returned, advance } = harness();
    saver.start(); saver.hidden(); saver.hidden();
    advance(SCREENSAVER_BRIEF_AWAY_MS - 1); saver.visible();
    expect(shown).toEqual([true, false]); expect(returned).toHaveBeenCalledTimes(1);
  });

  it('does not count idle time while hidden, and an idle screensaver stays after a brief absence', () => {
    const { saver, shown, advance } = harness();
    saver.start(); saver.hidden(); advance(SCREENSAVER_IDLE_MS * 3); expect(shown).toEqual([true]);
    const second = harness();
    second.saver.start(); second.advance(SCREENSAVER_IDLE_MS); second.saver.hidden(); second.advance(1000); second.saver.visible();
    expect(second.saver.showing()).toBe(true); expect(second.shown).toEqual([true]);
  });

  it('a page restored from the back/forward cache always waits for a tap', () => {
    const { saver, advance, returned } = harness();
    saver.start(); saver.hidden(); advance(10); saver.visible({ restored: true });
    expect(saver.showing()).toBe(true); expect(returned).not.toHaveBeenCalled();
  });

  it('a return without a hide does nothing, and stop clears the idle timer', () => {
    const { saver, shown, advance, timers } = harness();
    saver.start(); saver.visible(); expect(shown).toEqual([]);
    saver.stop(); expect(timers.size).toBe(0); advance(SCREENSAVER_IDLE_MS * 2); expect(shown).toEqual([]);
  });
});
