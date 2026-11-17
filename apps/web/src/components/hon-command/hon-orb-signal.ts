/**
 * The HON orb's "life": which state it shows and how strongly it reacts right now. Pure and clock-injected so it can be
 * tested; the orb component samples it once per animation frame. No audio is read here: the voice flow pulses the signal
 * on recognised words (listening) and spoken word boundaries (speaking). See docs/architecture/HON_ORB_PRESENCE.md.
 */
import type { HonVoiceState } from './hon-voice';

export type HonOrbState = 'idle' | 'standby' | 'listening' | 'thinking' | 'speaking';
/** The only states with a script-driven level; every other state is pure CSS. */
export const ORB_LIVE_STATES: ReadonlySet<HonOrbState> = new Set<HonOrbState>(['listening', 'speaking']);

export interface HonOrbSignal {
  /** Adds energy (0..1, capped at 1 in total). `now` defaults to the page clock used by animation frames. */
  pulse(strength: number, now?: number): void;
  /** Energy left at `now`, fading by half every half-life. */
  sample(now: number): number;
}

const clamp01 = (value: number): number => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0);
const pageNow = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export function createHonOrbSignal(halfLifeMs = 180): HonOrbSignal {
  let energy = 0;
  let at = 0;
  const left = (now: number): number => energy * Math.pow(0.5, Math.max(0, now - at) / halfLifeMs);
  return {
    pulse(strength, now = pageNow()) {
      const add = clamp01(strength);
      if (add === 0) return;
      energy = Math.min(1, left(now) + add); at = now;
    },
    sample: (now) => clamp01(left(now)),
  };
}

export function honOrbStateFor(state: HonVoiceState): HonOrbState {
  switch (state) {
    case 'WAITING_WAKE': return 'standby';
    case 'LISTENING': case 'FOLLOW_UP': return 'listening';
    case 'SENDING': return 'thinking';
    case 'SPEAKING': return 'speaking';
    default: return 'idle';
  }
}

/** How strongly the orb answers right now (0..1). Speaking keeps a soft talking rhythm for voices without word events. */
export function orbLevel(state: HonOrbState, energy: number, now: number): number {
  const e = clamp01(energy);
  if (state === 'listening') return clamp01(0.12 + e * 0.85);
  if (state === 'speaking') {
    const rhythm = Math.abs(Math.sin(now / 95) * Math.sin(now / 260));
    return clamp01(0.26 + rhythm * 0.22 + e * 0.55);
  }
  return 0;
}

/** A pulse for newly recognised text: none if nothing new, more for more new characters, never above 1. */
export function heardPulse(previous: string, next: string): number {
  const grown = next.length - previous.length;
  if (grown <= 0 || !next.trim()) return 0;
  return clamp01(0.35 + grown / 24);
}
