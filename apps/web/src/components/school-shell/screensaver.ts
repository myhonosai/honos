/**
 * School app screensaver timing (owner request 2026-11-16: replaces "School hidden while away").
 * Pure state machine: no DOM, no school data, no authority. The shell renders the overlay and
 * runs a quiet identity + exact-school re-check each time it lifts (`onReturn`).
 */
export const SCREENSAVER_IDLE_MS = 5 * 60_000;
/** Back within this long (and not restored from the back/forward cache): the screensaver lifts by itself. */
export const SCREENSAVER_BRIEF_AWAY_MS = 30_000;
/** Fired on window each time the screensaver covers the app (hidden, page hide or idle). Carries nothing. */
export const HON_SCREENSAVER_SHOWN_EVENT = 'hon:screensaver-shown';

/**
 * Calls `stop` whenever the app is put away: a hidden tab or app, page hide, or the screensaver
 * showing (which also covers 5 idle minutes). For things that must never keep running behind the
 * screensaver, such as hands-free HON voice listening and speaking. Page content is not touched.
 */
export function onAppPutAway(stop: () => void): () => void {
  const visibility = () => { if (document.visibilityState === 'hidden') stop(); };
  document.addEventListener('visibilitychange', visibility);
  window.addEventListener('pagehide', stop); window.addEventListener(HON_SCREENSAVER_SHOWN_EVENT, stop);
  return () => {
    document.removeEventListener('visibilitychange', visibility);
    window.removeEventListener('pagehide', stop); window.removeEventListener(HON_SCREENSAVER_SHOWN_EVENT, stop);
  };
}

export type ScreensaverClock = { now(): number; set(fn: () => void, ms: number): unknown; clear(handle: unknown): void };
const browserClock: ScreensaverClock = {
  now: () => Date.now(),
  set: (fn, ms) => setTimeout(fn, ms),
  clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class ScreensaverController {
  private shown = false;
  private hiddenAt: number | null = null;
  private shownBeforeHide = false;
  private idle: unknown = null;
  constructor(private readonly onChange: (showing: boolean) => void, private readonly onReturn: () => void,
    private readonly clock: ScreensaverClock = browserClock) {}

  showing(): boolean { return this.shown; }
  start(): void { this.arm(); }
  stop(): void { this.disarm(); }
  /** Touch, click, key or scroll while the app is in use. */
  activity(): void { if (!this.shown && this.hiddenAt === null) this.arm(); }
  /** The tab or app went to the background, or the page was hidden. */
  hidden(): void {
    if (this.hiddenAt !== null) return;
    this.hiddenAt = this.clock.now(); this.shownBeforeHide = this.shown;
    this.disarm(); this.show();
  }
  /** Back in view. `restored`: shown again from the back/forward cache, which always waits for a tap. */
  visible(options: { restored?: boolean } = {}): void {
    if (this.hiddenAt === null) return;
    const brief = this.clock.now() - this.hiddenAt < SCREENSAVER_BRIEF_AWAY_MS;
    this.hiddenAt = null;
    if (brief && !options.restored && !this.shownBeforeHide) this.lift();
  }
  /** A tap, click or key press on the screensaver. */
  dismiss(): void { if (!this.shown) return; this.hiddenAt = null; this.lift(); }

  private show(): void { if (this.shown) return; this.shown = true; this.onChange(true); }
  private lift(): void { this.shown = false; this.onChange(false); this.arm(); this.onReturn(); }
  private arm(): void { this.disarm(); this.idle = this.clock.set(() => { this.idle = null; this.show(); }, SCREENSAVER_IDLE_MS); }
  private disarm(): void { if (this.idle !== null) { this.clock.clear(this.idle); this.idle = null; } }
}
