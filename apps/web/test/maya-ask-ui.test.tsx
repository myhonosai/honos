import React, { type ReactElement } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ values: [] as any[], cursor: 0, effects: [] as (() => void)[] }));
vi.mock('react', async () => { const actual = await vi.importActual<typeof import('react')>('react'); return { ...actual,
  useState: (initial: any) => { const i = h.cursor++; if (!(i in h.values)) h.values[i] = typeof initial === 'function' ? initial() : initial; return [h.values[i], (v: any) => { h.values[i] = typeof v === 'function' ? v(h.values[i]) : v; }]; },
  useRef: (initial: any) => { const i = h.cursor++; if (!(i in h.values)) h.values[i] = { current: initial }; return h.values[i]; },
  useEffect: (fn: () => any, deps: unknown[]) => { const i = h.cursor++, old = h.values[i]; if (!old || deps.some((v, j) => v !== old.deps[j])) { old?.cleanup?.(); h.values[i] = { deps }; h.effects.push(() => { h.values[i].cleanup = fn(); }); } },
}; });
import { HonConversationError, type HonConversationApi, type PreparedHonCommand } from '../src/components/hon-command/hon-conversation-http';
import { MAYA_ASK_QUESTION, MayaAsk, personalize } from '../src/components/maya-at-risk/maya-ask';
import { id } from './account-status-fixtures';

// 0284: staff ask Maya about one at-risk student. One conversation, one turn naming only the membership; the name stays in the browser.
type E = ReactElement<Record<string, any>>;
const nodes = (n: unknown): E[] => Array.isArray(n) ? n.flatMap(nodes) : React.isValidElement(n) ? [n as E, ...nodes((n as E).props.children)] : [];
const text = (n: unknown): string => Array.isArray(n) ? n.map(text).join('') : React.isValidElement(n) ? text((n as E).props.children) : typeof n === 'string' || typeof n === 'number' ? String(n) : '';
const org = id(1), school = id(2), membershipId = id(30), conversationId = id(40);
let api: HonConversationApi & { create: ReturnType<typeof vi.fn>; sendTurn: ReturnType<typeof vi.fn> };
function render() { h.cursor = 0; const tree = MayaAsk({ school: { organizationId: org, schoolId: school }, membershipId, givenName: 'Sam', api }); h.effects.splice(0).forEach((run) => run()); return tree; }
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); return render(); };
const button = (label: RegExp) => nodes(render()).find((n) => n.type === 'button' && label.test(text(n)))!;
const receipt = (over: Record<string, unknown> = {}) => ({ turnId: id(50), conversationId, status: 'COMPLETED', reason: null, delegatedAgentKeys: ['maya'], actionRequestIds: [], workItemIds: [id(51)],
  invocationId: id(52), reply: 'Why: no class in 20 days.\nSuggested check-in message: Hi [First name], we miss you on the mat.', replyDetail: null, ...over });

beforeEach(() => {
  h.values = []; h.cursor = 0; h.effects = [];
  vi.stubGlobal('crypto', { randomUUID: () => id(99) });
  api = { create: vi.fn(async () => ({ id: conversationId })), sendTurn: vi.fn(async () => receipt()) } as any;
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('fills only the [First name] placeholder, in the browser', () => {
  expect(personalize('Hi [First name], see you, [First name]!', 'Sam')).toBe('Hi Sam, see you, Sam!');
  expect(personalize('Hi there', 'Sam')).toBe('Hi there');
});

it('asks one turn naming only the membership, never the student name, and shows the answer as a suggestion', async () => {
  expect(text(render())).toMatch(/Ask Maya/);
  button(/Ask Maya/).props.onClick();
  expect(nodes(render()).some((n) => n.props.role === 'status')).toBe(true);
  const tree = await settle();
  const created = api.create.mock.calls[0]![0] as PreparedHonCommand, turn = api.sendTurn.mock.calls[0]![0] as PreparedHonCommand;
  expect(created.path).toBe(`/api/v1/organizations/${org}/schools/${school}/hon/conversations`);
  expect(JSON.parse(created.body)).toEqual({ title: 'Maya: student check-in' });
  expect(turn.path).toBe(`/api/v1/organizations/${org}/schools/${school}/hon/conversations/${conversationId}/turns`);
  expect(JSON.parse(turn.body)).toEqual({ text: MAYA_ASK_QUESTION, delegation: { agentKey: 'maya', membershipId } });
  expect(created.body + turn.body).not.toMatch(/Sam/);
  const answer = nodes(tree).find((n) => n.props['data-testid'] === 'maya-answer')!;
  expect(text(answer)).toMatch(/nothing was sent/);
  expect(text(answer)).toMatch(/Hi Sam, we miss you on the mat\./);
  expect(text(answer)).not.toMatch(/\[First name\]/);
});

it('a turn that was not answered says nothing was sent', async () => {
  api.sendTurn.mockResolvedValueOnce(receipt({ status: 'FAILED', reason: 'AI_PAUSED_BY_HQ', reply: null, invocationId: null }));
  button(/Ask Maya/).props.onClick();
  const blocked = nodes(await settle()).find((n) => n.props['data-testid'] === 'maya-ask-blocked')!;
  expect(text(blocked)).toMatch(/AI_PAUSED_BY_HQ.*Nothing was sent or changed/);
});

it('an unknown outcome retries the exact same prepared commands; a refusal offers no retry', async () => {
  api.sendTurn.mockRejectedValueOnce(new HonConversationError('UNKNOWN'));
  button(/Ask Maya/).props.onClick();
  await settle();
  const first = api.sendTurn.mock.calls[0]![0] as PreparedHonCommand;
  button(/Try again/).props.onClick();
  const tree = await settle();
  expect(api.create).toHaveBeenCalledTimes(1);
  expect(api.sendTurn.mock.calls[1]![0]).toBe(first);
  expect(nodes(tree).some((n) => n.props['data-testid'] === 'maya-answer')).toBe(true);

  h.values = [];
  api.sendTurn.mockRejectedValueOnce(new HonConversationError('FORBIDDEN'));
  button(/Ask Maya/).props.onClick();
  const denied = nodes(await settle()).find((n) => n.props['data-testid'] === 'maya-ask-failed')!;
  expect(text(denied)).toMatch(/retention review permission/);
  expect(nodes(denied).some((n) => n.type === 'button')).toBe(false);
});
