import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { ParentApp } from '../src/ParentApp';
import { createParentApi, type ParentApi } from '../src/api/client';
import { createSampleApi } from '../src/sample/sample-api';
import { AI_SOURCE, askEianAi, CHECK_WITH_SCHOOL, turnOutcome } from '../src/eian/eian-ai';
import { verifyEianTurn } from '@hon/contracts/eian';
import { jsonResponse, NOW } from './fixtures';

const TURN_ID = '66666666-6666-4666-8666-666666666666';
const KEY = 'eian-key-0000000000000001';
function turn(overrides: Record<string, unknown> = {}) {
  return { id: TURN_ID, status: 'COMPLETED', question: 'Tell me a joke', reply: 'Why did the belt blush? It saw the dojo floor.', screen: null, reason: null,
    askedAt: '2026-11-17T15:00:00.000Z', ...overrides };
}
function client(fetchImpl: jest.Mock) {
  return createParentApi({ baseUrl: 'https://api.example.test', getToken: async () => 'tok', fetchImpl, timeoutMs: 1000 });
}

describe('Eian AI client', () => {
  it('reads status with no selectors and verifies the closed shape', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(200, { data: { mode: 'AI', reason: null } }));
    expect(await client(fetchImpl).eianStatus()).toEqual({ ok: true, data: { mode: 'AI', reason: null } });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.example.test/v1/parent/eian/status');
    expect(init.method).toBe('GET');
    const bad = jest.fn().mockResolvedValue(jsonResponse(200, { data: { mode: 'AI', reason: 'PAUSED' } }));
    expect(await client(bad).eianStatus()).toEqual({ ok: false, state: 'unavailable' });
  });

  it('asks as a native human command with one key and only the trimmed question', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(201, { data: turn(), meta: { replayed: false } }));
    const result = await client(fetchImpl).askEian('  Tell me a joke ', KEY);
    expect(result).toEqual({ ok: true, data: turn(), replayed: false });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.example.test/v1/parent/eian/turns');
    expect(JSON.parse(init.body)).toEqual({ question: 'Tell me a joke' });
    expect(init.headers['x-hon-human-command']).toBe('parent.eian.ask');
    expect(init.headers['Idempotency-Key']).toBe(KEY);
    expect(init.credentials).toBe('omit');
  });

  it('treats an answer to a different question as unknown, and AI-unavailable as a definite no', async () => {
    const other = jest.fn().mockResolvedValue(jsonResponse(201, { data: turn({ question: 'Something else' }), meta: { replayed: false } }));
    expect(await client(other).askEian('Tell me a joke', KEY)).toEqual({ ok: false, state: 'unknown' });
    const off = jest.fn().mockResolvedValue(jsonResponse(503, { code: 'EIAN_AI_UNAVAILABLE' }));
    expect(await client(off).askEian('Tell me a joke', KEY)).toEqual({ ok: false, state: 'refused', code: 'EIAN_AI_UNAVAILABLE' });
    const unknown = jest.fn().mockResolvedValue(jsonResponse(503, { code: 'EIAN_OUTCOME_UNKNOWN' }));
    expect(await client(unknown).askEian('Tell me a joke', KEY)).toEqual({ ok: false, state: 'unknown' });
  });

  it('re-reads a turn by id and refuses a different turn', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(200, { data: turn() }));
    expect((await client(fetchImpl).eianTurn(TURN_ID)).ok).toBe(true);
    expect(fetchImpl.mock.calls[0][0]).toBe(`https://api.example.test/v1/parent/eian/turns/${TURN_ID}`);
    const wrong = jest.fn().mockResolvedValue(jsonResponse(200, { data: turn({ id: '77777777-7777-4777-8777-777777777777' }) }));
    expect(await client(wrong).eianTurn(TURN_ID)).toEqual({ ok: false, state: 'unavailable' });
  });
});

describe('Eian AI outcomes', () => {
  it('labels an answer as AI from the school records and maps the screen to a tab', () => {
    const out = turnOutcome(verify(turn({ reply: 'Mia has class on Wednesday.\nBring water.', screen: 'BOOK_CLASS' })));
    expect(out).toEqual({ kind: 'answer', reuseKey: false, answer: { intent: 'help', lines: ['Mia has class on Wednesday.', 'Bring water.'], source: AI_SOURCE,
      action: { label: 'Book a class', tab: 'Schedule' } } });
  });

  it('adds the check-with-your-school line to billing and testing answers', () => {
    const billing = turnOutcome(verify(turn({ reply: 'One invoice is open.', screen: 'BILLING' })));
    expect(billing.kind === 'answer' && billing.answer.lines).toEqual(['One invoice is open.', CHECK_WITH_SCHOOL]);
    expect(billing.kind === 'answer' && billing.answer.action).toEqual({ label: 'Open billing', tab: 'More' });
    const testing = turnOutcome(verify(turn({ question: 'is the belt test soon', reply: 'Yes.', screen: null })));
    expect(testing.kind === 'answer' && testing.answer.lines).toEqual(['Yes.', CHECK_WITH_SCHOOL]);
  });

  it('goes back to guided answers when AI is off, and never shows a held or unknown answer', () => {
    expect(turnOutcome(verify(turn({ status: 'BLOCKED', reply: null, reason: 'BUDGET_REACHED' })))).toEqual({ kind: 'guided', aiOff: true });
    expect(turnOutcome(verify(turn({ status: 'CONFIGURATION_REQUIRED', reply: null, reason: 'NOT_CONFIGURED' })))).toEqual({ kind: 'guided', aiOff: true });
    const held = turnOutcome(verify(turn({ status: 'RESULT_HELD', reply: null })));
    expect(held.kind === 'answer' && held.answer.source).toBeNull();
    const unknown = turnOutcome(verify(turn({ status: 'UNKNOWN', reply: null, reason: 'OUTCOME_UNKNOWN' })));
    expect(unknown.kind === 'answer' && unknown.answer.lines[0]).toMatch(/won't ask it again/);
    expect(unknown.kind === 'answer' && unknown.reuseKey).toBe(false);
  });

  it('re-asks an unknown outcome once with the same key and the same question', async () => {
    const askEian = jest.fn().mockResolvedValueOnce({ ok: false, state: 'unknown' }).mockResolvedValueOnce({ ok: true, data: verify(turn()), replayed: true });
    const out = await askEianAi({ askEian } as unknown as ParentApi, 'Tell me a joke', KEY);
    expect(askEian.mock.calls).toEqual([['Tell me a joke', KEY], ['Tell me a joke', KEY]]);
    expect(out.kind === 'answer' && out.answer.source).toBe(AI_SOURCE);
  });

  it('keeps the key when the outcome is still unknown, and re-reads a turn still in flight', async () => {
    const lost = jest.fn().mockResolvedValue({ ok: false, state: 'unknown' });
    expect(await askEianAi({ askEian: lost } as unknown as ParentApi, 'Tell me a joke', KEY)).toMatchObject({ kind: 'answer', reuseKey: true });
    const eianTurn = jest.fn().mockResolvedValue({ ok: true, data: verify(turn()) });
    const sending = jest.fn().mockResolvedValue({ ok: true, data: verify(turn({ status: 'SENDING', reply: null })), replayed: false });
    const out = await askEianAi({ askEian: sending, eianTurn } as unknown as ParentApi, 'Tell me a joke', KEY);
    expect(eianTurn).toHaveBeenCalledWith(TURN_ID);
    expect(out.kind === 'answer' && out.answer.source).toBe(AI_SOURCE);
  });
});

// Reuse the shared verifier so test turns have exactly the server's shape.
function verify(value: unknown) { return verifyEianTurn(value); }

describe('Eian screen in AI mode', () => {
  const signedOut = { token: async () => null, clear: async () => {}, subscribe: () => () => {} };
  const now = () => new Date(NOW);
  let n = 0;
  const newKey = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  const liveApi = createParentApi({ baseUrl: 'https://api.example.test', getToken: async () => null, fetchImpl: jest.fn() });

  async function open(overrides: Partial<ParentApi>) {
    const api = { ...createSampleApi(now), ...overrides } as ParentApi;
    await render(<ParentApp api={liveApi} session={signedOut} now={now} newKey={newKey} sampleApi={() => api} />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Try with a sample family' }));
    await screen.findByRole('button', { name: 'Open Mia Sample journey' });
    await fireEvent.press(screen.getByRole('tab', { name: 'Eian' }));
    await screen.findByText(/next class is/);
  }
  async function ask(question: string) {
    await fireEvent.changeText(screen.getByLabelText('Ask Eian'), question);
    await fireEvent.press(screen.getByRole('button', { name: 'Send question to Eian' }));
  }

  it('sends only an unrecognized question to the AI, and shows it labelled as AI', async () => {
    const askEian = jest.fn().mockResolvedValue({ ok: true, data: verify(turn()), replayed: false });
    await open({ eianStatus: async () => ({ ok: true, data: { mode: 'AI', reason: null } }), askEian });
    expect(await screen.findByText(/answered by AI from your school's records/)).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Invoices' }));
    expect(await screen.findByText('You have 1 open invoice:')).toBeTruthy();
    expect(askEian).not.toHaveBeenCalled();
    await ask('Tell me a joke');
    expect(await screen.findByText('Why did the belt blush? It saw the dojo floor.')).toBeTruthy();
    expect(screen.getByText(`From: ${AI_SOURCE}`)).toBeTruthy();
    expect(askEian).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/OpenRouter|openai|anthropic|gpt|claude/i)).toBeNull();
  });

  it('re-asks the same question with the same key after an unknown outcome', async () => {
    const askEian = jest.fn().mockResolvedValue({ ok: false, state: 'unknown' });
    await open({ eianStatus: async () => ({ ok: true, data: { mode: 'AI', reason: null } }), askEian });
    await ask('Tell me a joke');
    expect(await screen.findByText(/Ask the same question again/)).toBeTruthy();
    await ask('Tell me a joke');
    await screen.findAllByText(/Ask the same question again/);
    const keys = askEian.mock.calls.map(c => c[1]);
    expect(keys).toHaveLength(4);
    expect(new Set(keys).size).toBe(1);
  });

  it('falls back to the guided answer when the school has no AI', async () => {
    const askEian = jest.fn().mockResolvedValue({ ok: false, state: 'refused', code: 'EIAN_AI_UNAVAILABLE' });
    await open({ eianStatus: async () => ({ ok: true, data: { mode: 'AI', reason: null } }), askEian });
    await ask('Tell me a joke');
    expect(await screen.findByText(/answers only from your school's records/)).toBeTruthy();
    expect(screen.queryByText(`From: ${AI_SOURCE}`)).toBeNull();
  });

  it('the sample family stays guided and never asks the AI', async () => {
    const askEian = jest.fn();
    await open({ askEian });
    await ask('Tell me a joke');
    expect(await screen.findByText(/answers only from your school's records/)).toBeTruthy();
    expect(askEian).not.toHaveBeenCalled();
  });
});
