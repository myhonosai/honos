import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HonVoiceControls, type HonVoiceControlsProps } from '../src/components/hon-command/hon-voice-controls';
import type { HonVoiceSnapshot } from '../src/components/hon-command/hon-voice';

const noop = () => {};
const snap = (over: Partial<HonVoiceSnapshot> = {}): HonVoiceSnapshot => ({ state: 'IDLE', handsFree: false, onDevice: false, heard: '', message: null, ...over });
const props = (over: Partial<HonVoiceControlsProps> = {}): HonVoiceControlsProps => ({
  support: { checked: true, recognition: true, synthesis: true }, enabled: true, canAsk: true, onDeviceStatus: 'unavailable', snapshot: snap(),
  onEnable: noop, onDisable: noop, onTalk: noop, onCancelListening: noop, onHandsFree: noop, onStopSpeaking: noop, onInstall: noop, ...over });
const render = (over: Partial<HonVoiceControlsProps> = {}) => renderToStaticMarkup(<HonVoiceControls {...props(over)} />);

describe('HonVoiceControls', () => {
  it('renders nothing until the browser was checked (no server/client mismatch)', () => {
    expect(render({ support: { checked: false, recognition: false, synthesis: false } })).toBe('');
  });

  it('says plainly when this browser cannot listen', () => {
    const html = render({ support: { checked: true, recognition: false, synthesis: true } });
    expect(html).toContain('Voice isn’t supported in this browser. Try Chrome, Edge or Safari, or type your question.');
    expect(html).not.toContain('<button');
  });

  it('is off until the person turns it on, with a privacy notice', () => {
    const html = render({ enabled: false });
    expect(html).toContain('Turn on voice');
    expect(html).toContain('Your browser turns your speech into text');
    expect(html).toContain('on the browser maker’s servers');
    expect(html).toContain('No audio is recorded or saved by HON');
    expect(html).not.toContain('data-voice="talk"');
  });

  it('offers Talk, and disables it while HON cannot take a question', () => {
    expect(render()).toMatch(/<button[^>]*data-voice="talk"[^>]*>Talk to HON<\/button>/);
    expect(render({ canAsk: false })).toMatch(/<button[^>]*disabled=""[^>]*data-voice="talk"|<button[^>]*data-voice="talk"[^>]*disabled=""/);
    expect(render({ snapshot: snap({ state: 'SENDING', heard: 'how many trials' }) })).toContain('HON is thinking…');
  });

  it('shows what was heard while listening and offers Stop listening', () => {
    const html = render({ snapshot: snap({ state: 'LISTENING', heard: 'how many trials' }) });
    expect(html).toContain('Listening…');
    expect(html).toContain('“how many trials”');
    expect(html).toContain('Stop listening');
  });

  it('offers Stop talking while HON speaks', () => {
    expect(render({ snapshot: snap({ state: 'SPEAKING' }) })).toContain('Stop talking');
  });

  it('offers Hey HON hands-free only with on-device recognition', () => {
    expect(render({ onDeviceStatus: 'unavailable' })).toContain('Hands-free “Hey HON” needs speech recognition on this device');
    expect(render({ onDeviceStatus: 'unavailable' })).not.toContain('type="checkbox"');
    expect(render({ onDeviceStatus: 'downloadable' })).toContain('Set up private hands-free listening');
    const on = render({ onDeviceStatus: 'available', snapshot: snap({ onDevice: true, handsFree: true, state: 'WAITING_WAKE' }) });
    expect(on).toContain('type="checkbox"');
    expect(on).toContain('checked=""');
    expect(on).toContain('Say “Hey HON” and your question.');
  });

  it('shows the controller message and a read-aloud note when the browser has no voices', () => {
    expect(render({ snapshot: snap({ message: 'I didn’t hear anything.' }) })).toContain('I didn’t hear anything.');
    expect(render({ support: { checked: true, recognition: true, synthesis: false } })).toContain('This browser can’t read answers aloud');
  });

  it('can be turned off again', () => {
    expect(render()).toContain('Turn off voice');
  });
});

describe('Ask HON with voice', () => {
  it('takes a spoken question only when a typed one would be taken', async () => {
    const { voiceCanAsk } = await import('../src/components/hon-command/hon-conversation-panel');
    const ready = { contract: true as const, providerRoute: true, entitlement: true, authorization: true, availableAgentKeys: [], honReply: true, businessPerformance: false, availableAnalystKeys: [], asOf: '2026-11-15T18:00:00Z' };
    expect(voiceCanAsk('READY', ready, null)).toBe(true);
    expect(voiceCanAsk('READY', { ...ready, honReply: false }, null)).toBe(false);
    expect(voiceCanAsk('READY', null, null)).toBe(false);
    expect(voiceCanAsk('CONCEALED', ready, null)).toBe(false);
    expect(voiceCanAsk('READY', ready, { state: 'SENDING' })).toBe(false);
    expect(voiceCanAsk('READY', ready, { state: 'UNKNOWN' })).toBe(false);
    expect(voiceCanAsk('READY', ready, { state: 'FORBIDDEN' })).toBe(true);
  });

  it('shows the voice controls inside the composer, and nothing when not offered', async () => {
    const { HonConversationView } = await import('../src/components/hon-command/hon-conversation-panel');
    const base = {
      presentation: 'full' as const, phase: 'READY' as const, conversations: [], thread: null, threadPhase: 'NONE' as const, pending: null, draft: '', mode: 'STANDARD' as const, ask: 'hon' as const,
      readiness: { contract: true as const, providerRoute: true, entitlement: true, authorization: true, availableAgentKeys: [], honReply: true, businessPerformance: false, availableAnalystKeys: [], asOf: '2026-11-15T18:00:00Z' },
      groups: new Map(), groupPhase: 'READY' as const, confirm: null, onAsk: noop, onSuggest: noop, onConfirmChange: noop, onConfirmSend: noop, onConfirmCancel: noop,
      onDraft: noop, onMode: noop, onSend: noop, onOpen: noop, onNew: noop, onContinue: noop, onRetry: noop, onDismiss: noop, onRefresh: noop,
    };
    const withVoice = renderToStaticMarkup(<HonConversationView {...base} voice={<HonVoiceControls {...props()} />} />);
    expect(withVoice).toMatch(/<form[^>]*>[\s\S]*data-voice="talk"[\s\S]*<\/form>/);
    expect(renderToStaticMarkup(<HonConversationView {...base} />)).not.toContain('data-voice');
  });
});

describe('review fixes (controls)', () => {
  it('hands-free can always be switched off, even when HON cannot take a question', () => {
    const html = render({ canAsk: false, onDeviceStatus: 'available', snapshot: snap({ onDevice: true, handsFree: true, state: 'WAITING_WAKE' }) });
    expect(html).toMatch(/<input type="checkbox" checked=""\/?>/);
  });
  it('Talk stays tappable after the microphone was blocked, so a person can try again', () => {
    expect(render({ snapshot: snap({ state: 'BLOCKED', message: 'blocked' }) })).toMatch(/<button type="button" data-voice="talk">Talk to HON<\/button>/);
  });
});
