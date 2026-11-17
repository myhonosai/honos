import React, { type ReactElement } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ values: [] as any[], cursor: 0, effects: [] as (() => void)[] }));
vi.mock('react', async () => { const actual = await vi.importActual<typeof import('react')>('react'); return { ...actual,
  useState: (initial: any) => { const i = h.cursor++; if (!(i in h.values)) h.values[i] = typeof initial === 'function' ? initial() : initial; return [h.values[i], (v: any) => { h.values[i] = typeof v === 'function' ? v(h.values[i]) : v; }]; },
  useRef: (initial: any) => { const i = h.cursor++; if (!(i in h.values)) h.values[i] = { current: initial }; return h.values[i]; },
  useEffect: (fn: () => any, deps: unknown[]) => { const i = h.cursor++, old = h.values[i]; if (!old || deps.some((v, j) => v !== old.deps[j])) { old?.cleanup?.(); h.values[i] = { deps }; h.effects.push(() => { h.values[i].cleanup = fn(); }); } },
}; });
import { HonConversationError, type HonConversationApi, type PreparedHonCommand } from '../src/components/hon-command/hon-conversation-http';
import { SpecialistAsk, specialistStarters } from '../src/components/specialist-workspace/ask';
import type { SpecialistKey } from '../src/components/specialist-workspace/model';
import { id } from './account-status-fixtures';

// Ask one analysis specialist from their workspace: one conversation, one turn { text, delegation: { agentKey } }; nothing is sent or changed.
type E = ReactElement<Record<string, any>>;
const nodes = (n: unknown): E[] => Array.isArray(n) ? n.flatMap(nodes) : React.isValidElement(n) ? [n as E, ...nodes((n as E).props.children)] : [];
const text = (n: unknown): string => Array.isArray(n) ? n.map(text).join('') : React.isValidElement(n) ? text((n as E).props.children) : typeof n === 'string' || typeof n === 'number' ? String(n) : '';
const org = id(1), school = id(2), conversationId = id(40);
let api: HonConversationApi & { create: ReturnType<typeof vi.fn>; sendTurn: ReturnType<typeof vi.fn> };
let agent: SpecialistKey = 'jordan', name = 'Jordan';
function render() { h.cursor = 0; const tree = SpecialistAsk({ agent, name, language: 'en', school: { organizationId: org, schoolId: school }, api }); h.effects.splice(0).forEach((run) => run()); return tree; }
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); return render(); };
const find = (pred: (n: E) => boolean) => nodes(render()).find(pred)!;
const byTest = (testId: string) => find((n) => n.props['data-testid'] === testId);
const type = (value: string) => byTest('specialist-question').props.onChange({ target: { value } });
const submit = () => find((n) => n.type === 'form').props.onSubmit({ preventDefault() {} });
const receipt = (over: Record<string, unknown> = {}) => ({ turnId: id(50), conversationId, status: 'COMPLETED', reason: null, delegatedAgentKeys: [agent], actionRequestIds: [], workItemIds: [],
  invocationId: id(52), reply: 'Recorded facts: 12 classes this week.\nJordan’s view: Saturday is busiest.', replyDetail: null, ...over });

beforeEach(() => {
  h.values = []; h.cursor = 0; h.effects = []; agent = 'jordan'; name = 'Jordan';
  vi.stubGlobal('crypto', { randomUUID: () => id(99) });
  api = { create: vi.fn(async () => ({ id: conversationId })), sendTurn: vi.fn(async () => receipt()) } as any;
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('offers three starter questions that only fill the box and send nothing', () => {
  expect(specialistStarters('claire', 'en')).toHaveLength(3);
  const starters = nodes(render()).filter((n) => n.props['data-testid'] === 'specialist-starter');
  expect(starters.map(text)).toEqual(specialistStarters('jordan', 'en'));
  expect(byTest('specialist-send').props.disabled).toBe(true);
  starters[1]!.props.onClick();
  expect(byTest('specialist-question').props.value).toBe(specialistStarters('jordan', 'en')[1]);
  expect(byTest('specialist-send').props.disabled).toBe(false);
  expect(api.create).not.toHaveBeenCalled();
});

it('asks one turn delegated to the specialist and shows the answer as a suggestion only', async () => {
  for (const [key, label] of [['alex', 'Alex'], ['jordan', 'Jordan'], ['claire', 'Claire'], ['lena', 'Lena']] as const) {
    h.values = []; agent = key; name = label; api.create.mockClear(); api.sendTurn.mockClear();
    type('  How busy is Saturday?  ');
    submit();
    expect(text(render())).toMatch(new RegExp(`${label} is reading`));
    const tree = await settle();
    const created = api.create.mock.calls[0]![0] as PreparedHonCommand, turn = api.sendTurn.mock.calls[0]![0] as PreparedHonCommand;
    expect(created.path).toBe(`/api/v1/organizations/${org}/schools/${school}/hon/conversations`);
    expect(JSON.parse(created.body)).toEqual({ title: `${label}: workspace questions` });
    expect(turn.path).toBe(`/api/v1/organizations/${org}/schools/${school}/hon/conversations/${conversationId}/turns`);
    expect(JSON.parse(turn.body)).toEqual({ text: 'How busy is Saturday?', delegation: { agentKey: key } });
    const answer = nodes(tree).find((n) => n.props['data-testid'] === 'specialist-answer')!;
    expect(text(answer)).toMatch(/nothing was sent or changed/);
    expect(text(answer)).toMatch(/Saturday is busiest/);
  }
});

it('a blank question is never sent', () => {
  type('   ');
  submit();
  expect(api.create).not.toHaveBeenCalled();
});

it('a turn that was not answered shows no text and says nothing was sent', async () => {
  api.sendTurn.mockResolvedValueOnce(receipt({ status: 'FAILED', reason: 'AI_PAUSED_BY_HQ', reply: null, invocationId: null }));
  type('Anything?'); submit();
  const blocked = nodes(await settle()).find((n) => n.props['data-testid'] === 'specialist-ask-blocked')!;
  expect(text(blocked)).toMatch(/AI_PAUSED_BY_HQ.*Nothing was sent or changed/);
  expect(nodes(await settle()).some((n) => n.props['data-testid'] === 'specialist-answer')).toBe(false);
});

it('an unknown outcome retries the exact same request, never a second conversation or turn', async () => {
  api.sendTurn.mockRejectedValueOnce(new HonConversationError('UNKNOWN'));
  type('Anything?'); submit();
  const failed = nodes(await settle()).find((n) => n.props['data-testid'] === 'specialist-ask-failed')!;
  expect(text(failed)).toMatch(/did not answer\. Nothing was sent\./);
  const first = api.sendTurn.mock.calls[0]![0] as PreparedHonCommand;
  nodes(render()).find((n) => n.type === 'button' && /Try again/.test(text(n)))!.props.onClick();
  await settle();
  expect(api.create).toHaveBeenCalledTimes(1);
  expect(api.sendTurn.mock.calls[1]![0]).toBe(first);
});

it('a refusal says the role or AI access does not allow it, and offers no retry', async () => {
  api.create.mockRejectedValueOnce(new HonConversationError('FORBIDDEN'));
  type('Anything?'); submit();
  const tree = await settle();
  expect(text(nodes(tree).find((n) => n.props['data-testid'] === 'specialist-ask-failed'))).toMatch(/does not allow asking Jordan/);
  expect(nodes(tree).some((n) => n.type === 'button' && /Try again/.test(text(n)))).toBe(false);
  expect(api.sendTurn).not.toHaveBeenCalled();
});

it('keeps one ongoing conversation: a second question continues it instead of starting a new one', async () => {
  type('First question?'); submit(); await settle();
  nodes(render()).find((n) => n.type === 'button' && /Ask another question/.test(text(n)))!.props.onClick();
  type('Second question?'); submit(); await settle();
  expect(api.create).toHaveBeenCalledTimes(1);
  expect(api.sendTurn).toHaveBeenCalledTimes(2);
  const second = api.sendTurn.mock.calls[1]![0] as PreparedHonCommand;
  expect(second.path).toBe(`/api/v1/organizations/${org}/schools/${school}/hon/conversations/${conversationId}/turns`);
  expect(JSON.parse(second.body)).toEqual({ text: 'Second question?', delegation: { agentKey: 'jordan' } });
});

it('a definitive conflict (such as a full conversation) starts a new conversation on the next question', async () => {
  type('First?'); submit(); await settle();
  nodes(render()).find((n) => n.type === 'button' && /Ask another question/.test(text(n)))!.props.onClick();
  api.sendTurn.mockRejectedValueOnce(new HonConversationError('CONFLICT', 'HON_CONVERSATION_FULL'));
  type('Second?'); submit(); await settle();
  nodes(render()).find((n) => n.type === 'button' && /Try again/.test(text(n)))!.props.onClick();
  await settle();
  expect(api.create).toHaveBeenCalledTimes(2);
});
