import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  LENGTH_PRESETS, QUICK_START_KEYS, addHandoffWord, enabledFromModes, handoffList, modeSummary, quickStartLeft, removeHandoffWord, setupChecklist, statusTone,
} from '../src/components/conversation-ai/setup-model';
import { setupCopy } from '../src/components/conversation-ai/setup-copy';
import { ModeChoice, StatusCard, Checklist, HandoffChips, LengthPresets } from '../src/components/conversation-ai/setup-parts';
import type { ConversationAiItem, ConversationAiOverview } from '@hon/contracts';

// CE1 Conversation AI easy setup: pure helpers and the presentational parts. The 0420 http and input rules are in conversation-ai-ui.test.tsx.
const T = '2026-11-20T17:00:00.000Z';
const off = { SMS: 'OFF', WEB_CHAT: 'OFF', EMAIL: 'OFF' } as const;
const item = (n: number, patch: Partial<ConversationAiItem> = {}): ConversationAiItem => ({ itemId: `00000000-0000-4000-8000-00000000000${n}`, kind: 'FAQ', title: `Q${n}`,
  question: `Question ${n}?`, body: 'Answer.', staffNote: null, summary: null, status: 'ACTIVE', version: 1, updatedAt: T, updatedBy: null, file: null, ...patch });
const overview = (patch: Partial<ConversationAiOverview> = {}): ConversationAiOverview => ({ program: 'OFF', canConfigure: true, items: [],
  settings: { enabled: false, modes: { ...off }, handoffWords: ['human'], afterHoursText: null, smsMaxChars: 320, chatMaxChars: 800, languages: ['en'], enabledAt: null, enabledBy: null, version: 0 },
  ...patch });

describe('conversation AI setup helpers', () => {
  it('sums up the channel modes as one choice or a mix, and is on when any channel is on', () => {
    expect(modeSummary(off)).toBe('OFF');
    expect(modeSummary({ SMS: 'ASSIST', WEB_CHAT: 'ASSIST', EMAIL: 'ASSIST' })).toBe('ASSIST');
    expect(modeSummary({ SMS: 'AUTOMATIC', WEB_CHAT: 'ASSIST', EMAIL: 'OFF' })).toBe('MIXED');
    expect(enabledFromModes(off)).toBe(false);
    expect(enabledFromModes({ ...off, EMAIL: 'ASSIST' })).toBe(true);
  });
  it('ticks the checklist from real data only', () => {
    expect(setupCopy('en').checklist).toBeTruthy();
    expect(setupChecklist(overview())).toEqual({ how: false, answers: false, answerCount: 0, handoff: true, tryIt: false });
    const five = [1, 2, 3, 4, 5].map(n => item(n));
    const done = setupChecklist(overview({ items: five, settings: { ...overview().settings, modes: { ...off, SMS: 'ASSIST' }, handoffWords: [] } }));
    expect(done).toMatchObject({ how: true, answers: true, answerCount: 5, handoff: false });
    // A switched-off item does not count.
    expect(setupChecklist(overview({ items: [...five.slice(0, 4), item(6, { status: 'PAUSED' })] })).answers).toBe(false);
  });
  it('offers only quick start questions the school has not answered yet', () => {
    const copy = setupCopy('en');
    expect(QUICK_START_KEYS.length).toBeGreaterThanOrEqual(8);
    const all = quickStartLeft([], copy.quickStart);
    expect(all).toHaveLength(QUICK_START_KEYS.length);
    const trial = copy.quickStart.trial;
    const left = quickStartLeft([item(1, { question: `  ${trial.toUpperCase()} ` })], copy.quickStart);
    expect(left).not.toContain('trial'); expect(left).toHaveLength(QUICK_START_KEYS.length - 1);
    // A paused answer still counts as answered; a non-question item does not.
    expect(quickStartLeft([item(2, { kind: 'INSTRUCTION', question: null, title: trial })], copy.quickStart)).toContain('trial');
  });
  it('adds and removes hand-off words as the server will accept them', () => {
    expect(handoffList('human, Refund ,')).toEqual(['human', 'refund']);
    expect(addHandoffWord('human', ' Manager ')).toBe('human, manager');
    expect(addHandoffWord('', 'cancel')).toBe('cancel');
    expect(addHandoffWord('human', 'HUMAN')).toBeNull();
    expect(addHandoffWord('human', 'no!')).toBeNull();
    expect(addHandoffWord(Array.from({ length: 20 }, (_, i) => `w${i}`).join(', '), 'one more')).toBeNull();
    expect(removeHandoffWord('human, refund, billing', 'refund')).toBe('human, billing');
  });
  it('has three length presets inside the server range', () => {
    expect(LENGTH_PRESETS.map(p => p.chars)).toEqual([160, 320, 640]);
  });
  it('picks a status tone from the HQ program and the school modes', () => {
    expect(statusTone('OFF', 'AUTOMATIC')).toBe('waiting');
    expect(statusTone('LIVE', 'OFF')).toBe('off');
    expect(statusTone('LIVE', 'ASSIST')).toBe('on');
    expect(statusTone('TEST_MODE', 'MIXED')).toBe('practice');
  });
});

describe('conversation AI setup parts', () => {
  const copy = setupCopy('en');
  it('shows three plain choices with the current one pressed', () => {
    const html = renderToStaticMarkup(<ModeChoice copy={copy} value="ASSIST" disabled={false} onChoose={() => undefined} />);
    expect(html).toContain('Suggest replies'); expect(html).toContain('Reply for me'); expect(html).toContain('>Off<');
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(renderToStaticMarkup(<ModeChoice copy={copy} value="MIXED" disabled onChoose={() => undefined} />)).not.toContain('aria-pressed="true"');
  });
  it('says plainly what HQ allows', () => {
    const waiting = renderToStaticMarkup(<StatusCard copy={copy} program="OFF" summary="ASSIST" />);
    expect(waiting).toContain(copy.hq.OFF); expect(waiting).toContain('data-tone="waiting"');
    expect(renderToStaticMarkup(<StatusCard copy={copy} program="TEST_MODE" summary="AUTOMATIC" />)).toContain(copy.hq.TEST_MODE);
    expect(renderToStaticMarkup(<StatusCard copy={copy} program="LIVE" summary="OFF" />)).toContain(copy.now.OFF);
  });
  it('lists the four setup steps with ticks', () => {
    const html = renderToStaticMarkup(<Checklist copy={copy} state={{ how: true, answers: false, answerCount: 2, handoff: true, tryIt: false }} onGo={() => undefined} />);
    expect(html.match(/data-done="true"/g)).toHaveLength(2);
    expect(html).toContain(copy.steps.answers(2));
  });
  it('renders hand-off chips with a remove button each, and the presets', () => {
    const html = renderToStaticMarkup(<HandoffChips copy={copy} text="human, refund" disabled={false} onChange={() => undefined} />);
    expect(html.match(/aria-label="Remove /g)).toHaveLength(2);
    const presets = renderToStaticMarkup(<LengthPresets copy={copy} label="Texts" value={320} disabled={false} onChange={() => undefined} />);
    expect(presets.match(/aria-pressed="true"/g)).toHaveLength(1); expect(presets).toContain('320');
  });
  it('has every new string in English, Korean and Spanish', () => {
    const keys = (o: object): string[] => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? keys(v).map(x => `${k}.${x}`) : [k])).sort();
    for (const language of ['ko', 'es'] as const) expect(keys(setupCopy(language))).toEqual(keys(copy));
    for (const key of QUICK_START_KEYS) expect(copy.quickStart[key]).toBeTruthy();
  });
});
