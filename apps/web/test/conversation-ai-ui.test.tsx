import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TrainAi, itemInput, settingsInput } from '../src/components/conversation-ai/train-ai';
import { HqConversationAiProgram } from '../src/components/conversation-ai/hq-program';
import { trainAiCopy } from '../src/components/conversation-ai/copy';
import {
  TRAIN_AI_REFUSALS, TrainAiRefusal, TrainAiUnknown, loadKnowledge, loadProgram, loadTrainAi, loadTrainingFile, mediaTypeFor, saveSettings, saveTrainingItem,
  setProgram, setTrainingItemStatus, toBase64, uploadTrainingFile,
} from '../src/components/conversation-ai/http';
import { NO_SCHOOL_SHELL, SchoolShellProvider } from '../src/components/school-shell/context';
import { SCHOOL_SHELL_NAV } from '../src/components/school-shell/catalog';
import { HQ_AI } from '../src/components/hq-modern/catalog';

// 0420 Train AI: fixed same-origin calls with the shell scope, verified answers, definite refusals vs unknown outcomes. No AI is called.
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222', C = '33333333-3333-4333-8333-333333333333';
const T = '2026-11-20T17:00:00.000Z';
const scope = { organizationId: A, schoolId: B };
const stored = { enabled: false, modes: { SMS: 'OFF', WEB_CHAT: 'OFF', EMAIL: 'OFF' }, handoffWords: ['human'], afterHoursText: null, smsMaxChars: 320, chatMaxChars: 800,
  languages: ['en'], enabledAt: null, enabledBy: null, version: 0 };
const item = (patch = {}) => ({ itemId: C, kind: 'FAQ', title: 'Parking', question: 'Where do I park?', body: 'Behind the school.', staffNote: null, summary: null,
  status: 'ACTIVE', version: 1, updatedAt: T, updatedBy: 'Sam', file: null, ...patch });
const settingsIn = { expectedVersion: 0, enabled: true, modes: { SMS: 'ASSIST', WEB_CHAT: 'OFF', EMAIL: 'OFF' }, handoffWords: ['human'], afterHoursText: null,
  smsMaxChars: 320, chatMaxChars: 800, languages: ['en', 'ko'] } as const;
afterEach(() => vi.restoreAllMocks());

describe('train AI http', () => {
  it('reads as plain same-origin GETs with no command marker or key', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json(200, { data: { program: 'OFF', settings: stored, items: [item()], canConfigure: true }, meta: {} }))
      .mockResolvedValueOnce(json(200, { data: { school: { name: 'Sunrise' }, tone: '', languages: ['en'], instructions: [], faqs: [], documents: [], articles: [], plans: [], bookingTypes: [] } }))
      .mockResolvedValueOnce(json(200, { data: { fileId: C, fileName: 'a.txt', mediaType: 'text/plain', byteSize: 3, contentBase64: 'YWJj' } }));
    expect((await loadTrainAi(scope)).items).toHaveLength(1);
    await loadKnowledge(scope);
    expect((await loadTrainingFile(scope, C)).contentBase64).toBe('YWJj');
    expect(fetcher.mock.calls.map(c => c[0])).toEqual([`/api/v1/organizations/${A}/schools/${B}/conversation-ai`,
      `/api/v1/organizations/${A}/schools/${B}/conversation-ai/knowledge`, `/api/v1/organizations/${A}/schools/${B}/conversation-ai/files/${C}`]);
    for (const [, init] of fetcher.mock.calls) {
      expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error' });
      expect((init as RequestInit).headers).not.toHaveProperty('Idempotency-Key');
      expect((init as RequestInit).headers).not.toHaveProperty('X-HON-Human-Command');
    }
    await expect(loadTrainAi({ organizationId: '../x', schoolId: B })).rejects.toBeInstanceOf(TrainAiUnknown);
    await expect(loadTrainingFile(scope, 'nope')).rejects.toBeInstanceOf(TrainAiUnknown);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('refuses a file answer for another file', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(200, { data: { fileId: A, fileName: 'a.txt', mediaType: 'text/plain', byteSize: 3, contentBase64: 'YWJj' } }));
    await expect(loadTrainingFile(scope, C)).rejects.toBeInstanceOf(TrainAiUnknown);
  });
  it('sends each change as its own human command with a key, and checks the receipt', async () => {
    const settingsReceipt = { ...settingsIn } as Record<string, unknown>;
    delete settingsReceipt.expectedVersion;
    const fetcher = vi.spyOn(globalThis, 'fetch');
    fetcher.mockResolvedValueOnce(json(200, { data: { settings: { ...settingsReceipt, enabledAt: T, enabledBy: 'Ada', version: 1 } }, meta: { replayed: false } }))
      .mockResolvedValueOnce(json(201, { data: { file: { fileId: C, fileName: 'schedule.txt', mediaType: 'text/plain', byteSize: 3 }, extractedText: 'abc' }, meta: { replayed: false } }))
      .mockResolvedValueOnce(json(200, { data: { item: item() }, meta: { replayed: true } }))
      .mockResolvedValueOnce(json(200, { data: { item: { itemId: C, status: 'DELETED', version: 2 } }, meta: { replayed: false } }));
    expect((await saveSettings(scope, settingsIn as never, 'k1')).receipt.settings.version).toBe(1);
    expect((await uploadTrainingFile(scope, { fileName: 'schedule.txt', mediaType: 'text/plain', contentBase64: 'YWJj' }, 'k2')).receipt.extractedText).toBe('abc');
    expect((await saveTrainingItem(scope, { kind: 'FAQ', title: 'Parking', question: 'Where do I park?', body: 'Behind the school.' }, 'k3')).replayed).toBe(true);
    expect((await setTrainingItemStatus(scope, { itemId: C, expectedVersion: 1, status: 'DELETED' }, 'k4')).receipt.item.status).toBe('DELETED');
    const commands = fetcher.mock.calls.map(([url, init]) => [String(url).split('/conversation-ai')[1], (init as RequestInit).headers]);
    expect(commands).toEqual([
      ['/settings', expect.objectContaining({ 'X-HON-Human-Command': 'conversation.ai.settings', 'Idempotency-Key': 'k1' })],
      ['/files', expect.objectContaining({ 'X-HON-Human-Command': 'conversation.ai.upload', 'Idempotency-Key': 'k2' })],
      ['/items', expect.objectContaining({ 'X-HON-Human-Command': 'conversation.ai.item.save', 'Idempotency-Key': 'k3' })],
      ['/items/status', expect.objectContaining({ 'X-HON-Human-Command': 'conversation.ai.item.status', 'Idempotency-Key': 'k4' })],
    ]);
    // Wrong item back, wrong file back, or bad input: refused, and bad input never reaches the network.
    fetcher.mockReset();
    fetcher.mockResolvedValueOnce(json(200, { data: { item: item({ title: 'Other' }) }, meta: { replayed: false } }))
      .mockResolvedValueOnce(json(201, { data: { file: { fileId: C, fileName: 'other.txt', mediaType: 'text/plain', byteSize: 4 }, extractedText: null }, meta: { replayed: false } }))
      .mockResolvedValueOnce(json(200, { data: { file: { fileId: C, fileName: 'first-name.txt', mediaType: 'text/plain', byteSize: 3 }, extractedText: 'abc' }, meta: { replayed: false } }));
    await expect(saveTrainingItem(scope, { kind: 'FAQ', title: 'Parking', question: 'q', body: 'b' }, 'k')).rejects.toBeInstanceOf(TrainAiUnknown);
    await expect(uploadTrainingFile(scope, { fileName: 'schedule.txt', mediaType: 'text/plain', contentBase64: 'YWJj' }, 'k')).rejects.toBeInstanceOf(TrainAiUnknown);
    // The same bytes uploaded again under a new name come back under their first name: accepted.
    expect((await uploadTrainingFile(scope, { fileName: 'schedule.txt', mediaType: 'text/plain', contentBase64: 'YWJj' }, 'k')).receipt.file.fileName).toBe('first-name.txt');
    await expect(saveTrainingItem(scope, { kind: 'FAQ', title: 'No question', body: 'b' }, 'k')).rejects.toThrow();
    await expect(uploadTrainingFile(scope, { fileName: '../x.txt', mediaType: 'text/plain', contentBase64: 'YWJj' }, 'k')).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('tells definite refusals from unknown outcomes', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json(422, { code: 'CONVERSATION_AI_LIBRARY_FULL' })).mockResolvedValueOnce(json(503, { code: 'CONVERSATION_AI_UNAVAILABLE' }))
      .mockRejectedValueOnce(new TypeError('offline')).mockResolvedValueOnce(new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }))
      .mockResolvedValueOnce(json(401, {}));
    const input = { kind: 'INSTRUCTION', title: 'T', body: 'x' } as const;
    const refusal = await saveTrainingItem(scope, input, 'k').catch(e => e);
    expect(refusal).toBeInstanceOf(TrainAiRefusal); expect(refusal.code).toBe('CONVERSATION_AI_LIBRARY_FULL');
    await expect(saveTrainingItem(scope, input, 'k')).rejects.toBeInstanceOf(TrainAiUnknown);
    await expect(saveTrainingItem(scope, input, 'k')).rejects.toBeInstanceOf(TrainAiUnknown);
    await expect(loadTrainAi(scope)).rejects.toBeInstanceOf(TrainAiUnknown);
    expect((await loadTrainAi(scope).catch(e => e)).reason).toBe('SESSION');
  });
  it('drives the HQ switch with a UUID key and the SaaS command marker', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json(200, { data: { status: 'OFF', version: 1, updatedAt: T, updatedBy: null, schoolsEnabled: 0, recentChanges: [] } }))
      .mockResolvedValueOnce(json(200, { data: { status: 'TEST_MODE', version: 2, changedAt: T, replayed: false } }))
      .mockResolvedValueOnce(json(200, { data: { status: 'OFF', version: 3, changedAt: T, replayed: false } }));
    expect((await loadProgram()).status).toBe('OFF');
    expect((await setProgram({ status: 'TEST_MODE', expectedVersion: 1, reason: 'Start a staff test.' }, A)).version).toBe(2);
    expect(fetcher.mock.calls[1]![0]).toBe('/api/v1/hq/conversation-ai/program');
    expect((fetcher.mock.calls[1]![1] as RequestInit).headers).toMatchObject({ 'X-HON-Human-Command': 'conversation-ai-program', 'Idempotency-Key': A });
    await expect(setProgram({ status: 'LIVE', expectedVersion: 2, reason: 'Go live now please.' }, A)).rejects.toBeInstanceOf(TrainAiUnknown);
    await expect(setProgram({ status: 'LIVE', expectedVersion: 2, reason: 'Go live now please.' }, 'not-a-uuid')).rejects.toThrow();
    await expect(setProgram({ status: 'LIVE', expectedVersion: 2, reason: 'short' }, A)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('maps file names to allowed types and encodes bytes', () => {
    expect(mediaTypeFor('Schedule.PDF')).toBe('application/pdf'); expect(mediaTypeFor('photo.jpeg')).toBe('image/jpeg'); expect(mediaTypeFor('page.html')).toBeNull();
    expect(toBase64(new TextEncoder().encode('abc'))).toBe('YWJj');
  });
});

describe('train AI screen', () => {
  it('builds only inputs the server accepts', () => {
    const draft = { enabled: true, modes: { SMS: 'ASSIST', WEB_CHAT: 'OFF', EMAIL: 'OFF' } as const, handoffText: 'Human, refund', afterHoursText: '', smsMaxChars: 320, chatMaxChars: 800, languages: ['en'] as ('en' | 'ko' | 'es')[] };
    expect(settingsInput(draft, 0)).toMatchObject({ expectedVersion: 0, handoffWords: ['human', 'refund'], afterHoursText: null });
    expect(settingsInput({ ...draft, handoffText: 'a, a' }, 0)).toBeNull();
    expect(settingsInput({ ...draft, smsMaxChars: 100 }, 0)).toBeNull();
    expect(settingsInput({ ...draft, languages: [] }, 0)).toBeNull();
    const faq = { kind: 'FAQ', title: 'Parking', question: 'Where?', body: 'Behind.', staffNote: 'ignored', summary: '' } as const;
    expect(itemInput(faq)).toEqual({ kind: 'FAQ', title: 'Parking', question: 'Where?', body: 'Behind.' });
    expect(itemInput({ ...faq, question: '' })).toBeNull();
    expect(itemInput({ ...faq, kind: 'COACHING' })).toMatchObject({ staffNote: 'ignored' });
    expect(itemInput({ ...faq, kind: 'INSTRUCTION', fileId: C })).toEqual({ kind: 'INSTRUCTION', title: 'Parking', body: 'Behind.' });
    expect(itemInput({ ...faq, kind: 'DOCUMENT', fileId: C })).toMatchObject({ fileId: C });
  });
  it('asks for a school, then renders the screen shell without data or IDs', () => {
    expect(renderToStaticMarkup(<TrainAi />)).toContain('Choose a school to train its conversation AI.');
    const html = renderToStaticMarkup(<SchoolShellProvider value={{ ...NO_SCHOOL_SHELL, phase: 'READY', selection: scope, schoolName: 'Sunrise' }}><TrainAi /></SchoolShellProvider>);
    expect(html).toContain('<h1>Train AI</h1>'); expect(html).toContain('aria-live="polite"'); expect(html).toContain('Nothing here calls an AI yet.');
    expect(html).not.toContain(A); expect(html).not.toContain(B);
    expect(renderToStaticMarkup(<HqConversationAiProgram />)).toContain('<h1>Conversation AI program</h1>');
  });
  it('has every string and refusal in English, Korean and Spanish', () => {
    const en = trainAiCopy('en');
    for (const language of ['en', 'ko', 'es'] as const) {
      const copy = trainAiCopy(language);
      expect(Object.keys(copy).sort()).toEqual(Object.keys(en).sort());
      for (const code of TRAIN_AI_REFUSALS) expect(copy.refusal[code], `${language} ${code}`).toBeTruthy();
      for (const group of ['program', 'channel', 'mode', 'language', 'kind'] as const) expect(Object.keys(copy[group]).sort()).toEqual(Object.keys(en[group]).sort());
    }
    expect(trainAiCopy('ko').title).toBe('AI 학습'); expect(trainAiCopy('es').title).toBe('Entrenar la IA');
  });
  it('is reachable next to Conversations, and the HQ switch is in the HQ AI group', () => {
    const routes = SCHOOL_SHELL_NAV.flatMap(i => i.routes.map(r => r.href));
    expect(routes).toContain('/staff/conversations/train-ai');
    expect(HQ_AI.map(x => x.path)).toContain('/hq/conversation-ai');
    const manifest = readFileSync(resolve('public/manus-routes.json'), 'utf8');
    expect(manifest).toContain('"/staff/conversations/train-ai"'); expect(manifest).toContain('"/hq/conversation-ai"');
  });
  it('never stores, injects HTML or calls a provider from the browser', () => {
    for (const file of ['train-ai.tsx', 'hq-program.tsx', 'http.ts']) {
      const source = readFileSync(resolve('src/components/conversation-ai', file), 'utf8');
      expect(source).not.toMatch(/localStorage|sessionStorage|dangerouslySetInnerHTML|innerHTML|twilio|openrouter|openai|anthropic|apiKey/i);
    }
  });
});
