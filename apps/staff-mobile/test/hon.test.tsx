import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { StaffApp } from '../src/StaffApp';
import { createStaffApi, type StaffApi } from '../src/api/client';
import { turnNote, verifyConversation, verifyMyAgents, verifyTurnReceipt } from '../src/api/hon';
import { ORG, SCHOOL_A } from './fixtures';

const CONV = '55555555-5555-4555-8555-555555555555', TURN = '66666666-6666-4666-8666-666666666666';
const school = { organizationId: ORG, schoolId: SCHOOL_A, schoolName: 'North Test School' };
const readiness = (patch: Record<string, unknown> = {}) => ({ data: { contract: true, providerRoute: true, entitlement: true, authorization: true, availableAgentKeys: ['kai'],
  honReply: true, businessPerformance: true, availableAnalystKeys: ['claire', 'jordan'], asOf: '2026-11-22T06:00:00.000000Z', ...patch }, meta: { requestId: CONV, correlationId: CONV } });
const summary = { id: CONV, title: 'HON Staff app', createdAt: '2026-11-22T06:00:00.000Z', updatedAt: '2026-11-22T06:00:00.000Z', turnCount: 0, status: 'READY' };
const detail = (mode = 'STANDARD') => ({ mode, step: 1, maxSteps: 3, truncated: false, canContinue: false, continuesTurnId: null, suggestions: [], followUps: [], sources: [] });
const receipt = (patch: Record<string, unknown> = {}) => ({ data: { turnId: TURN, conversationId: CONV, status: 'COMPLETED', reason: null, delegatedAgentKeys: [], actionRequestIds: [], workItemIds: [],
  invocationId: null, reply: 'Three trials are booked this week.', replyDetail: detail(), ...patch } });

describe('HON response checks', () => {
  it('lists the agents the server says this person may ask, HON first; Kai stays on the web for now', () => {
    expect(verifyMyAgents(readiness())).toEqual({ askable: ['hon', 'claire', 'jordan'], webOnly: ['kai'], ready: true });
    expect(verifyMyAgents(readiness({ honReply: false, availableAgentKeys: [], availableAnalystKeys: [], businessPerformance: false }))).toEqual({ askable: [], webOnly: [], ready: true });
    expect(verifyMyAgents(readiness({ entitlement: false })).ready).toBe(false);
  });
  it('refuses extra, missing or out-of-set fields', () => {
    for (const bad of [readiness({ extra: 1 }), readiness({ availableAnalystKeys: ['claire', 'chase'] }), readiness({ availableAgentKeys: ['kai', 'kai'] }),
      readiness({ businessPerformance: false }), { data: readiness().data }, readiness({ asOf: 'today' })]) {
      expect(() => verifyMyAgents(bad)).toThrow();
    }
  });
  it('checks the conversation and that a receipt belongs to this conversation and agent', () => {
    expect(verifyConversation({ data: summary }).id).toBe(CONV);
    expect(verifyTurnReceipt(receipt(), CONV, 'hon').reply).toBe('Three trials are booked this week.');
    expect(() => verifyTurnReceipt(receipt(), TURN, 'hon')).toThrow();
    expect(() => verifyTurnReceipt(receipt(), CONV, 'claire')).toThrow();
    expect(verifyTurnReceipt(receipt({ delegatedAgentKeys: ['claire'], replyDetail: detail('DETAILED') }), CONV, 'claire').status).toBe('COMPLETED');
    expect(turnNote(verifyTurnReceipt(receipt({ status: 'UNKNOWN', reply: null }), CONV, 'hon'))).toMatch(/not sure/);
  });
});

describe('HON client', () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const reply = (status: number, body: unknown) => async (url: string, init: RequestInit) => { calls.push({ url, init }); return { status, json: async () => body } as Response; };
  const client = (status: number, body: unknown) => createStaffApi({ baseUrl: 'https://api.example.test/api', getToken: async () => 't', fetchImpl: reply(status, body) as unknown as typeof fetch });
  beforeEach(() => { calls.length = 0; });
  it('asks as a native HON command with the key, and HON questions carry no delegation', async () => {
    const r = await client(200, receipt()).ask(school, CONV, 'hon', '  How many trials this week? ', 'k-1');
    expect(r.ok).toBe(true);
    const { url, init } = calls[0]!;
    expect(url).toBe(`https://api.example.test/api/v1/organizations/${ORG}/schools/${SCHOOL_A}/hon/conversations/${CONV}/turns`);
    expect(init.headers).toMatchObject({ Authorization: 'Bearer t', 'X-HON-Human-Command': 'hon-conversation', 'Idempotency-Key': 'k-1', 'Content-Type': 'application/json' });
    expect(init.headers).not.toHaveProperty('Origin');
    expect(JSON.parse(String(init.body))).toEqual({ text: 'How many trials this week?', delegation: null });
    await client(200, receipt({ delegatedAgentKeys: ['jordan'], replyDetail: detail('DETAILED') })).ask(school, CONV, 'jordan', 'Busiest class?', 'k-2');
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({ text: 'Busiest class?', delegation: { agentKey: 'jordan' } });
  });
  it('maps refusals: agent switched off, AI paused, conversation full, unknown', async () => {
    expect(await client(403, { code: 'HON_AGENT_OFF' }).ask(school, CONV, 'hon', 'x', 'k')).toEqual({ ok: false, state: 'agent-off' });
    expect(await client(403, { code: 'HON_AI_SPEND_REFUSED' }).ask(school, CONV, 'hon', 'x', 'k')).toEqual({ ok: false, state: 'paused' });
    expect(await client(403, { code: 'HON_CONVERSATION_FORBIDDEN' }).ask(school, CONV, 'hon', 'x', 'k')).toEqual({ ok: false, state: 'no-staff-access' });
    expect(await client(409, { code: 'HON_CONVERSATION_FULL' }).ask(school, CONV, 'hon', 'x', 'k')).toEqual({ ok: false, state: 'full' });
    expect(await client(503, { code: 'HON_CONVERSATION_TIMEOUT' }).ask(school, CONV, 'hon', 'x', 'k')).toEqual({ ok: false, state: 'unknown' });
    expect(await client(200, receipt({ conversationId: TURN })).ask(school, CONV, 'hon', 'x', 'k')).toEqual({ ok: false, state: 'unknown' });
    expect(await client(200, receipt()).ask(school, CONV, 'hon', '   ', 'k')).toEqual({ ok: false, state: 'rejected' });
    expect(calls.length).toBe(6);
  });
});

describe('HON tab', () => {
  let n = 0;
  const newKey = jest.fn(() => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`);
  const session = { token: async () => 't', save: async () => {}, clear: jest.fn(async () => {}), subscribe: () => () => {} };
  const fakeApi = (patch: Partial<StaffApi> = {}): StaffApi => ({
    whereIWork: async () => ({ ok: true, data: { kind: 'one', school } }),
    todayClasses: jest.fn(async () => ({ ok: false as const, state: 'no-staff-access' as const })), roster: jest.fn(), mark: jest.fn(), findStudents: jest.fn(),
    clock: jest.fn(async () => ({ ok: false as const, state: 'no-staff-access' as const })), punch: jest.fn(),
    myAgents: jest.fn(async () => ({ ok: true as const, data: verifyMyAgents(readiness()) })),
    startConversation: jest.fn(async () => ({ ok: true as const, data: verifyConversation({ data: summary }) })),
    ask: jest.fn(async () => ({ ok: true as const, data: verifyTurnReceipt(receipt(), CONV, 'hon') })),
    findContacts: jest.fn(), contactCard: jest.fn(), inbox: jest.fn(), conversation: jest.fn(), markRead: jest.fn(), reply: jest.fn(),
    ...patch,
  });
  const open = async (api: StaffApi) => {
    await render(<StaffApp api={api} session={session} version="0.1.0" newKey={newKey} />);
    await fireEvent.press(await screen.findByRole('tab', { name: 'HON' }));
  };
  it('shows only the agents the server allows, asks HON and shows the answer', async () => {
    const api = fakeApi();
    await open(api);
    expect(await screen.findByRole('button', { name: 'Ask HON, Your school assistant', selected: true })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Ask Claire, Business performance' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Ask Marcus/ })).toBeNull();
    expect(screen.getByText('Kai: on the web for now.')).toBeTruthy();
    await fireEvent.changeText(screen.getByLabelText('Question for HON'), 'How many trials this week?');
    await fireEvent.press(screen.getByRole('button', { name: 'Ask' }));
    expect(await screen.findByText('Three trials are booked this week.')).toBeTruthy();
    expect(api.startConversation).toHaveBeenCalledTimes(1);
    expect(api.ask).toHaveBeenCalledWith(school, CONV, 'hon', 'How many trials this week?', expect.any(String));
  });
  it('asks the chosen analysis agent', async () => {
    const ask = jest.fn(async () => ({ ok: true as const, data: verifyTurnReceipt(receipt({ delegatedAgentKeys: ['jordan'], replyDetail: detail('DETAILED'), reply: 'Tuesday 5 PM is fullest.' }), CONV, 'jordan') }));
    await open(fakeApi({ ask }));
    await fireEvent.press(await screen.findByRole('button', { name: 'Ask Jordan, Classes and operations' }));
    await fireEvent.changeText(screen.getByLabelText('Question for Jordan'), 'Busiest class?');
    await fireEvent.press(screen.getByRole('button', { name: 'Ask' }));
    expect(await screen.findByText('Tuesday 5 PM is fullest.')).toBeTruthy();
    expect(ask).toHaveBeenCalledWith(school, CONV, 'jordan', 'Busiest class?', expect.any(String));
  });
  it('an unknown outcome keeps the same key for the retry; a new question gets a new key', async () => {
    const ask = jest.fn(async () => ({ ok: false as const, state: 'unknown' as const }));
    await open(fakeApi({ ask }));
    await fireEvent.changeText(await screen.findByLabelText('Question for HON'), 'Same question');
    await fireEvent.press(screen.getByRole('button', { name: 'Ask' }));
    expect(await screen.findByText('Not sure it went through. Tap Ask again to retry safely.')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Ask' }));
    await fireEvent.changeText(screen.getByLabelText('Question for HON'), 'Different question');
    await fireEvent.press(screen.getByRole('button', { name: 'Ask' }));
    const keys = (ask.mock.calls as unknown[][]).map(c => c[4]);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
  });
  it('a switched-off agent says so plainly and the list is read again', async () => {
    const api = fakeApi({ ask: jest.fn(async () => ({ ok: false as const, state: 'agent-off' as const })) });
    await open(api);
    await fireEvent.changeText(await screen.findByLabelText('Question for HON'), 'Hello');
    await fireEvent.press(screen.getByRole('button', { name: 'Ask' }));
    expect(await screen.findByText('Your owner has not turned this agent on for you. Nothing was sent.')).toBeTruthy();
    expect(api.myAgents).toHaveBeenCalledTimes(2);
  });
  it('no agents switched on: tells the person who can turn them on', async () => {
    await open(fakeApi({ myAgents: async () => ({ ok: true, data: verifyMyAgents(readiness({ honReply: false, availableAgentKeys: [], availableAnalystKeys: [], businessPerformance: false })) }) }));
    expect(await screen.findByText('No AI agents yet')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Ask' })).toBeNull();
  });
  it('a signed-out answer ends the session', async () => {
    await open(fakeApi({ myAgents: async () => ({ ok: false, state: 'signed-out' }) }));
    expect(await screen.findByText('Your session ended. Please sign in again.')).toBeTruthy();
    expect(session.clear).toHaveBeenCalled();
  });
});
