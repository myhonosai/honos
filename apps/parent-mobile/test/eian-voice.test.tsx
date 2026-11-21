import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { ParentApp } from '../src/ParentApp';
import { createParentApi } from '../src/api/client';
import { createSampleApi } from '../src/sample/sample-api';
import { spokenText, VOICE_NOTE, type EianVoice, type HeardResult } from '../src/eian/voice';
import { NOW } from './fixtures';

const signedOut = { token: async () => null, clear: async () => {}, subscribe: () => () => {} };
const now = () => new Date(NOW);
const liveApi = createParentApi({ baseUrl: 'https://api.example.test', getToken: async () => null, fetchImpl: jest.fn() });

function fakeVoice(canListen = true) {
  const state = { spoken: [] as string[], stops: 0, cancels: 0, listenStops: 0, done: null as null | (() => void),
    on: null as null | { partial(text: string): void; end(result: HeardResult): void } };
  const voice: EianVoice = {
    speak(text, onDone) { state.spoken.push(text); state.done = onDone; },
    stopSpeaking() { state.stops += 1; },
    canListen: () => canListen,
    listen(on) { state.on = on; return { stop() { state.listenStops += 1; }, cancel() { state.cancels += 1; } }; },
  };
  return { voice, state };
}
async function open(voice?: EianVoice) {
  await render(<ParentApp api={liveApi} session={signedOut} now={now} newKey={() => 'k'} sampleApi={() => createSampleApi(now)} voice={voice} />);
  await fireEvent.press(await screen.findByRole('button', { name: 'Try with a sample family' }));
  await screen.findByRole('button', { name: 'Open Mia Sample journey' });
  await fireEvent.press(screen.getByRole('tab', { name: 'Eian' }));
  await screen.findByText(/next class is/);
}

describe('Eian voice', () => {
  it('says the lines of an answer and nothing else', () => {
    expect(spokenText({ intent: 'help', lines: ['Good morning!', ' One invoice is open ', '', 'Due:'], source: 'Billing', action: { label: 'Open billing', tab: 'More' } }))
      .toBe('Good morning! One invoice is open. Due:');
  });

  it('stays text only when the phone supplies no voice', async () => {
    await open();
    expect(screen.queryByRole('button', { name: 'Ask Eian by voice' })).toBeNull();
    expect(screen.queryByRole('button', { name: "Read Eian's answer aloud" })).toBeNull();
    expect(screen.queryByText(/your phone's own voice/)).toBeNull();
  });

  it('hears one question, asks it like a typed one, and reads the answer aloud', async () => {
    const { voice, state } = fakeVoice();
    await open(voice);
    await fireEvent.press(screen.getByRole('button', { name: 'Ask Eian by voice' }));
    expect(screen.getByRole('button', { name: 'Stop listening' })).toBeTruthy();
    await act(async () => { state.on!.partial('do we have any open'); });
    expect(screen.getByLabelText('Ask Eian').props.value).toBe('do we have any open');
    await fireEvent.press(screen.getByRole('button', { name: 'Stop listening' }));
    expect(state.listenStops).toBe(1);
    await act(async () => { state.on!.end({ kind: 'heard', text: 'Do we have any open invoices?' }); });
    expect(await screen.findByText('You have 1 open invoice:')).toBeTruthy();
    expect(state.spoken).toHaveLength(1);
    expect(state.spoken[0]).toMatch(/^You have 1 open invoice:/);
    expect(screen.getByRole('button', { name: 'Stop reading aloud' })).toBeTruthy();
    await act(async () => { state.done!(); });
    expect(screen.getByRole('button', { name: "Read Eian's answer aloud" })).toBeTruthy();
  });

  it('does not read a typed answer aloud until asked, and stops on request', async () => {
    const { voice, state } = fakeVoice();
    await open(voice);
    await fireEvent.press(screen.getByRole('button', { name: 'Invoices' }));
    expect(await screen.findByText('You have 1 open invoice:')).toBeTruthy();
    expect(state.spoken).toEqual([]);
    await fireEvent.press(screen.getByRole('button', { name: "Read Eian's answer aloud" }));
    expect(state.spoken).toHaveLength(1);
    const stops = state.stops;
    await fireEvent.press(screen.getByRole('button', { name: 'Stop reading aloud' }));
    expect(state.stops).toBe(stops + 1);
    expect(screen.getByRole('button', { name: "Read Eian's answer aloud" })).toBeTruthy();
  });

  it.each(['denied', 'nothing', 'unavailable'] as const)('asks nothing and says why when listening ends as %s', async kind => {
    const { voice, state } = fakeVoice();
    await open(voice);
    await fireEvent.press(screen.getByRole('button', { name: 'Ask Eian by voice' }));
    await act(async () => { state.on!.end({ kind }); });
    expect(screen.getByText(VOICE_NOTE[kind])).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Ask Eian by voice' })).toBeTruthy();
    expect(state.spoken).toEqual([]);
    expect(screen.queryByText('Earlier')).toBeNull();
  });

  it('offers reading aloud but no microphone when the phone cannot listen', async () => {
    await open(fakeVoice(false).voice);
    expect(screen.queryByRole('button', { name: 'Ask Eian by voice' })).toBeNull();
    expect(screen.getByRole('button', { name: "Read Eian's answer aloud" })).toBeTruthy();
    expect(screen.getByText("Reading aloud uses your phone's own voice.")).toBeTruthy();
  });

  it('stops listening and reading when the parent leaves Eian', async () => {
    const { voice, state } = fakeVoice();
    await open(voice);
    await fireEvent.press(screen.getByRole('button', { name: "Read Eian's answer aloud" }));
    await fireEvent.press(screen.getByRole('button', { name: 'Ask Eian by voice' }));
    const stops = state.stops;
    await fireEvent.press(screen.getByRole('tab', { name: 'Home' }));
    expect(state.cancels).toBeGreaterThanOrEqual(1);
    expect(state.stops).toBeGreaterThan(stops);
  });

  it('never reads an answer that arrives after the parent left Eian', async () => {
    const { voice, state } = fakeVoice();
    let release: (value: Awaited<ReturnType<ReturnType<typeof createSampleApi>['billing']>>) => void = () => {};
    const sample = createSampleApi(now);
    const billing = sample.billing;
    const api = { ...sample, billing: () => new Promise<Awaited<ReturnType<typeof billing>>>(resolve => { release = resolve; }) };
    await render(<ParentApp api={liveApi} session={signedOut} now={now} newKey={() => 'k'} sampleApi={() => api} voice={voice} />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Try with a sample family' }));
    await screen.findByRole('button', { name: 'Open Mia Sample journey' });
    await fireEvent.press(screen.getByRole('tab', { name: 'Eian' }));
    await screen.findByText(/next class is/);
    await fireEvent.press(screen.getByRole('button', { name: 'Ask Eian by voice' }));
    await act(async () => { state.on!.end({ kind: 'heard', text: 'Do we have any open invoices?' }); });
    expect(await screen.findByText('Checking your school records…')).toBeTruthy();
    await fireEvent.press(screen.getByRole('tab', { name: 'Home' }));
    await act(async () => { release(await billing()); });
    expect(state.spoken).toEqual([]);
    // Coming back shows the answer, still silent until the parent asks for it.
    await fireEvent.press(screen.getByRole('tab', { name: 'Eian' }));
    expect(await screen.findByText('You have 1 open invoice:')).toBeTruthy();
    expect(state.spoken).toEqual([]);
  });

  it('says in plain words that the spoken question may leave the phone', async () => {
    await open(fakeVoice().voice);
    expect(screen.getByText(/may send your spoken question off the phone to turn it into text\. HON gets only the text\./)).toBeTruthy();
  });

  it('declares why the microphone is used', () => {
    const app = require('../app.json') as { expo: { plugins: unknown[] } };
    const plugin = app.expo.plugins.find(p => Array.isArray(p) && p[0] === 'expo-speech-recognition') as [string, Record<string, string>];
    expect(plugin[1].microphonePermission).toMatch(/only while you tap/);
  });
});
