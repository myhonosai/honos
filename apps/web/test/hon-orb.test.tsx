import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createHonOrbSignal, heardPulse, honOrbStateFor, orbLevel, ORB_LIVE_STATES } from '../src/components/hon-command/hon-orb-signal';
import { HonOrb } from '../src/components/hon-command/hon-orb';
import { browserSpeech } from '../src/components/hon-command/hon-voice';

describe('orb signal', () => {
  it('starts silent, rises on a pulse and fades by half each half-life', () => {
    const signal = createHonOrbSignal(200);
    expect(signal.sample(1000)).toBe(0);
    signal.pulse(0.8, 1000);
    expect(signal.sample(1000)).toBeCloseTo(0.8);
    expect(signal.sample(1200)).toBeCloseTo(0.4);
    expect(signal.sample(1400)).toBeCloseTo(0.2);
  });
  it('adds pulses together but never above 1, and ignores bad input', () => {
    const signal = createHonOrbSignal(200);
    signal.pulse(0.7, 0); signal.pulse(0.7, 0);
    expect(signal.sample(0)).toBe(1);
    signal.pulse(Number.NaN, 0); signal.pulse(-5, 0);
    expect(signal.sample(0)).toBe(1);
    expect(signal.sample(-100)).toBe(1); // a clock that steps back never grows the energy
  });
  it('maps every voice state to an orb state', () => {
    expect(honOrbStateFor('IDLE')).toBe('idle');
    expect(honOrbStateFor('BLOCKED')).toBe('idle');
    expect(honOrbStateFor('WAITING_WAKE')).toBe('standby');
    expect(honOrbStateFor('LISTENING')).toBe('listening');
    expect(honOrbStateFor('FOLLOW_UP')).toBe('listening');
    expect(honOrbStateFor('SENDING')).toBe('thinking');
    expect(honOrbStateFor('SPEAKING')).toBe('speaking');
  });
  it('drives a level only while listening or speaking, always within 0..1', () => {
    expect([...ORB_LIVE_STATES]).toEqual(['listening', 'speaking']);
    for (const now of [0, 37, 500, 1234, 99999]) {
      expect(orbLevel('idle', 1, now)).toBe(0);
      expect(orbLevel('thinking', 1, now)).toBe(0);
      expect(orbLevel('standby', 1, now)).toBe(0);
      for (const energy of [0, 0.5, 1]) {
        for (const state of ['listening', 'speaking'] as const) {
          const level = orbLevel(state, energy, now);
          expect(level).toBeGreaterThanOrEqual(0); expect(level).toBeLessThanOrEqual(1);
        }
      }
    }
    expect(orbLevel('listening', 1, 0)).toBeGreaterThan(orbLevel('listening', 0, 0));
    // Speaking keeps a talking rhythm even when the voice reports no word boundaries.
    const rhythm = [0, 60, 120, 180, 240, 300, 360, 420].map((t) => orbLevel('speaking', 0, t));
    expect(Math.min(...rhythm)).toBeGreaterThan(0.2);
    expect(Math.max(...rhythm) - Math.min(...rhythm)).toBeGreaterThan(0.05);
  });
  it('pulses on newly heard words only, more for more new text', () => {
    expect(heardPulse('', '')).toBe(0);
    expect(heardPulse('how many', 'how many')).toBe(0);
    expect(heardPulse('how many trials', 'how')).toBe(0);
    expect(heardPulse('', 'how')).toBeGreaterThan(0);
    expect(heardPulse('how', 'how many trials this week')).toBeGreaterThan(heardPulse('how', 'how many'));
    expect(heardPulse('', 'x'.repeat(500))).toBeLessThanOrEqual(1);
  });
});

describe('HonOrb', () => {
  const render = (props: React.ComponentProps<typeof HonOrb>) => renderToStaticMarkup(<HonOrb {...props} />);
  it('is decorative, shows the HON core art and its state', () => {
    const html = render({ state: 'thinking', className: 'size' });
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('data-orb-state="thinking"');
    expect(html).toContain('src="/ai/hon-core.webp"');
    expect(html).toContain('alt=""');
    expect(html).toMatch(/class="[^"]*size/);
  });
  it('defaults to idle with eight direction ticks on the outer ring', () => {
    const html = render({});
    expect(html).toContain('data-orb-state="idle"');
    expect(html.match(/data-orb-tick=""/g)).toHaveLength(8);
  });
});

describe('browser speech word pulses', () => {
  type U = { text: string; onstart: (() => void) | null; onboundary: ((e: { name?: string }) => void) | null; onend: (() => void) | null; onerror: (() => void) | null; lang: string; voice: unknown; rate: number };
  const setup = () => {
    const spoken: U[] = [];
    class Utter { onstart = null; onboundary = null; onend = null; onerror = null; lang = ''; voice = null; rate = 1; constructor(public text: string) {} }
    const win = { speechSynthesis: { speak: (u: U) => { spoken.push(u); }, cancel: () => {}, getVoices: () => [] }, SpeechSynthesisUtterance: Utter };
    let words = 0;
    const speech = browserSpeech(win as never, { onWord: () => { words++; } });
    return { spoken, speech, words: () => words };
  };
  it('reports each word boundary and each chunk start of the current answer', () => {
    const { spoken, speech, words } = setup();
    speech.speak('Three trials today. Two tomorrow.', 'en-US', () => {});
    expect(spoken.length).toBeGreaterThan(0);
    spoken[0]!.onstart?.();
    spoken[0]!.onboundary?.({ name: 'word' }); spoken[0]!.onboundary?.({ name: 'word' });
    spoken[0]!.onboundary?.({ name: 'sentence' });
    expect(words()).toBe(3);
  });
  it('ignores events from an answer that was cancelled', () => {
    const { spoken, speech, words } = setup();
    speech.speak('An old answer.', 'en-US', () => {});
    const old = spoken[0]!;
    speech.cancel();
    old.onstart?.(); old.onboundary?.({ name: 'word' });
    expect(words()).toBe(0);
  });
  it('still works without a word listener', () => {
    const spoken: U[] = [];
    class Utter { onstart = null; onboundary = null; onend = null; onerror = null; lang = ''; voice = null; rate = 1; constructor(public text: string) {} }
    const speech = browserSpeech({ speechSynthesis: { speak: (u: U) => { spoken.push(u); }, cancel: () => {}, getVoices: () => [] }, SpeechSynthesisUtterance: Utter } as never);
    speech.speak('Hello.', 'en-US', () => {});
    expect(() => { spoken[0]!.onstart?.(); spoken[0]!.onboundary?.({ name: 'word' }); }).not.toThrow();
  });
});
