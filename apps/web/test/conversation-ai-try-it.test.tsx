import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONVERSATION_AI_TEST_REASONS, CONVERSATION_AI_TEST_UNAVAILABLE, type ConversationAiOverview } from '@hon/contracts';
import { TrainAiAccessError, TrainAiRefusal, TrainAiUnknown, askTestQuestion, loadTestChat } from '../src/components/conversation-ai/http';
import { TryIt } from '../src/components/conversation-ai/try-it';
import { tryItCopy } from '../src/components/conversation-ai/try-it-copy';
import { setupCopy } from '../src/components/conversation-ai/setup-copy';
import { setupChecklist } from '../src/components/conversation-ai/setup-model';
import { Checklist } from '../src/components/conversation-ai/setup-parts';

// CE2 "Try it" (0687): the test chat's browser calls, strings and checklist step.
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const ORG = '11111111-1111-4111-8111-111111111111', SCHOOL = '22222222-2222-4222-8222-222222222222', KEY = '33333333-3333-4333-8333-333333333333', ID = '44444444-4444-4444-8444-444444444444';
const scope = { organizationId: ORG, schoolId: SCHOOL };
const view = (patch = {}) => ({ id: ID, status: 'ANSWERED', reason: null, question: 'How much is a trial?', reply: 'The first class is free.', needsStaff: false, askedAt: '2026-11-19T00:00:00.000Z', ...patch });
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const base = `/api/v1/organizations/${ORG}/schools/${SCHOOL}/conversation-ai/test`;

describe('Try it browser calls', () => {
  it('reads with a plain GET (no command marker, no key) and verifies the state', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => { calls.push({ url, init }); return json(200, { data: { mode: 'AI', reason: null, tests: [view()] } }); }));
    const state = await loadTestChat(scope);
    expect(state.tests[0]!.reply).toBe('The first class is free.');
    const h = calls[0]!.init.headers as Record<string, string>;
    expect([calls[0]!.url, calls[0]!.init.method, calls[0]!.init.credentials, h['X-HON-Human-Command'], h['Idempotency-Key']]).toEqual([base, 'GET', 'same-origin', undefined, undefined]);
  });
  it('asks with one same-origin POST, its own human command and key, and only the question', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => { calls.push({ url, init }); return json(200, { data: view() }); }));
    expect((await askTestQuestion(scope, '  How much is a trial?  ', KEY)).status).toBe('ANSWERED');
    const h = calls[0]!.init.headers as Record<string, string>;
    expect([calls[0]!.url, calls[0]!.init.method, calls[0]!.init.redirect, h['X-HON-Human-Command'], h['Idempotency-Key']]).toEqual([base, 'POST', 'error', 'conversation.ai.test.ask', KEY]);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ question: 'How much is a trial?' });
    // Nothing is sent for a bad question or key.
    await expect(askTestQuestion(scope, '', KEY)).rejects.toThrow();
    await expect(askTestQuestion(scope, 'x'.repeat(501), KEY)).rejects.toThrow();
    await expect(askTestQuestion(scope, 'Hi', 'not-a-key')).rejects.toBeInstanceOf(TrainAiUnknown);
    expect(calls).toHaveLength(1);
  });
  it('an answer for another question, or one that leaks a reply while working, is an unknown outcome, never shown', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(200, { data: view({ question: 'Something else' }) })));
    await expect(askTestQuestion(scope, 'How much is a trial?', KEY)).rejects.toBeInstanceOf(TrainAiUnknown);
    vi.stubGlobal('fetch', vi.fn(async () => json(200, { data: view({ status: 'WORKING' }) })));
    await expect(askTestQuestion(scope, 'How much is a trial?', KEY)).rejects.toBeInstanceOf(TrainAiUnknown);
  });
  it('maps refusals: busy and invalid are definite; 403 keeps its code; a 503 is unknown', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(409, { code: 'CONVERSATION_AI_TEST_BUSY' })));
    await expect(askTestQuestion(scope, 'Hi', KEY)).rejects.toEqual(new TrainAiRefusal('CONVERSATION_AI_TEST_BUSY'));
    vi.stubGlobal('fetch', vi.fn(async () => json(403, { code: 'CONVERSATION_AI_TEST_SPEND_STOPPED', reason: 'AI_PAUSED_BY_HQ' })));
    await expect(askTestQuestion(scope, 'Hi', KEY)).rejects.toMatchObject({ reason: 'FORBIDDEN', code: 'CONVERSATION_AI_TEST_SPEND_STOPPED' });
    vi.stubGlobal('fetch', vi.fn(async () => json(403, { code: '<b>x</b>' })));
    await expect(askTestQuestion(scope, 'Hi', KEY)).rejects.toMatchObject({ code: '' });
    vi.stubGlobal('fetch', vi.fn(async () => json(503, { code: 'CONVERSATION_AI_TEST_UNAVAILABLE_NOW' })));
    await expect(askTestQuestion(scope, 'Hi', KEY)).rejects.toBeInstanceOf(TrainAiUnknown);
    expect(new TrainAiAccessError('FORBIDDEN', 403).code).toBe('');
  });
});

describe('Try it screen', () => {
  it('has every string in English, Korean and Spanish', () => {
    const en = tryItCopy('en');
    for (const language of ['en', 'ko', 'es'] as const) {
      const copy = tryItCopy(language);
      expect(Object.keys(copy).sort()).toEqual(Object.keys(en).sort());
      for (const r of CONVERSATION_AI_TEST_REASONS) expect(copy.reason[r], `${language} ${r}`).toBeTruthy();
      for (const r of CONVERSATION_AI_TEST_UNAVAILABLE) expect(copy.unavailable[r], `${language} ${r}`).toBeTruthy();
      expect(setupCopy(language).tabs.tryIt).toBeTruthy();
    }
  });
  it('says nothing is sent, and a read-only staff member sees no question box', () => {
    const html = renderToStaticMarkup(<TryIt scope={scope} copy={tryItCopy('en')} samples={['Do you offer a free trial class?']} canConfigure onAnswered={() => {}} onCoach={async () => true} />);
    expect(html).toContain('Nothing is sent to anyone'); expect(html).toContain('id="ca-try-q"');
    const ro = renderToStaticMarkup(<TryIt scope={scope} copy={tryItCopy('en')} samples={[]} canConfigure={false} onAnswered={() => {}} onCoach={async () => true} />);
    expect(ro).toContain(tryItCopy('en').readOnly); expect(ro).not.toContain('ca-try-q');
  });
  it('ticks the last checklist step only after an answered test, and offers Go instead of "Coming next"', () => {
    const o = { program: 'OFF', canConfigure: true, items: [], settings: { enabled: false, modes: { SMS: 'OFF', WEB_CHAT: 'OFF', EMAIL: 'OFF' }, handoffWords: ['human'],
      afterHoursText: null, smsMaxChars: 320, chatMaxChars: 800, languages: ['en'], enabledAt: null, enabledBy: null, version: 0 } } as unknown as ConversationAiOverview;
    expect(setupChecklist(o).tryIt).toBe(false); expect(setupChecklist(o, true).tryIt).toBe(true);
    const html = renderToStaticMarkup(<Checklist copy={setupCopy('en')} state={setupChecklist(o)} onGo={() => {}} />);
    expect(html).not.toContain('Coming next'); expect((html.match(/>Go</g) ?? []).length).toBe(3);
  });
});
