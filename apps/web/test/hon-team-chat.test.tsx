import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { HonAnalystAgentKey, HonConversationReadiness, HonConversationThread, HonConversationTurn, HonTurnReceipt } from '@hon/contracts';
import {
  TEAM_CHAT_TITLE_PREFIX, TEAM_PLAN_QUESTION, latestTeamChat, parseTeamAddress, teamCanPlan, teamChatMessages, teamChatTitle, teamMemberState, teamPlanRequest,
  teamRoundTargets, teamSpokenParts, teamTalkers, teamTurnRequest,
} from '../src/components/hon-command/hon-team-chat-model';
import { newTeamRound, runTeamRound, type TeamRoundDeps } from '../src/components/hon-command/hon-team-chat-round';
import { HonTeamChatView, type HonTeamChatViewProps } from '../src/components/hon-command/hon-team-chat';
import { HonConversationError, prepareTurn } from '../src/components/hon-command/hon-conversation-http';
import { teamChatText } from '../src/components/hon-command/hon-team-chat-copy';
import { HON_AGENT_VOICES } from '../src/components/hon-command/hon-voice';

const id = (n: number) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const AT = '2026-11-17T01:00:00.000Z';
const SCHOOL = { organizationId: id(1), schoolId: id(2) };
const readiness = (over: Partial<HonConversationReadiness> = {}): HonConversationReadiness => ({ contract: true, providerRoute: true, entitlement: true, authorization: true,
  availableAgentKeys: ['marcus'], honReply: true, businessPerformance: true, availableAnalystKeys: ['alex', 'jordan', 'lena'] as HonAnalystAgentKey[], asOf: AT, ...over });
const turn = (n: number, role: HonConversationTurn['role'], text: string | null, over: Partial<HonConversationTurn> = {}): HonConversationTurn => ({
  turnId: id(n), role, text, createdAt: AT, status: 'COMPLETED', reason: null, references: { workItemId: null, actionRequestId: null, invocationId: null }, replyDetail: null, ...over });
const thread = (turns: HonConversationTurn[]): HonConversationThread => ({ id: id(5), title: `${TEAM_CHAT_TITLE_PREFIX}Kids program`, createdAt: AT, updatedAt: AT, turnCount: turns.length / 2, status: 'COMPLETED', turns });
const Q = 'How do we grow the kids program?';
const ROUND = thread([turn(1, 'HUMAN', Q), turn(1, 'hon', 'HON view.'), turn(2, 'HUMAN', Q), turn(2, 'claire', 'Claire view.'), turn(3, 'HUMAN', Q), turn(3, 'jordan', 'Jordan view.')]);

describe('team chat: who can talk', () => {
  it('lists HON and each analyst readiness offers, in team order', () => {
    expect(teamTalkers(readiness())).toEqual(['hon', 'claire', 'alex', 'jordan', 'lena']);
    expect(teamTalkers(readiness({ businessPerformance: false, availableAnalystKeys: ['jordan'] }))).toEqual(['hon', 'jordan']);
    expect(teamTalkers(readiness({ honReply: false }))).toEqual([]);
    expect(teamTalkers(null)).toEqual([]);
    // Maya answers about one student only, so she is never a team chat talker even when offered.
    expect(teamTalkers(readiness({ availableAnalystKeys: ['maya'] as HonAnalystAgentKey[] }))).toEqual(['hon', 'claire']);
  });
  it('shows Marcus, Chad, Maya and Kai as working through HON, and others as not available', () => {
    const talkers = teamTalkers(readiness({ businessPerformance: false, availableAnalystKeys: [] }));
    expect(['marcus', 'chad', 'maya', 'kai'].map((k) => teamMemberState(k as never, talkers))).toEqual(['THROUGH_HON', 'THROUGH_HON', 'THROUGH_HON', 'THROUGH_HON']);
    expect(teamMemberState('jordan', talkers)).toBe('NOT_AVAILABLE');
    expect(teamMemberState('hon', talkers)).toBe('TALKS');
  });
});

describe('team chat: addressing', () => {
  it('picks one teammate or everyone from the start of a message', () => {
    expect(parseTeamAddress('@Jordan how full is Tuesday?')).toEqual({ to: 'jordan', text: 'how full is Tuesday?' });
    expect(parseTeamAddress('Lena, any campaign ideas?')).toEqual({ to: 'lena', text: 'any campaign ideas?' });
    expect(parseTeamAddress('Hey Alex what should I focus on')).toEqual({ to: 'alex', text: 'what should I focus on' });
    expect(parseTeamAddress('Everyone: plan the open house')).toEqual({ to: 'everyone', text: 'plan the open house' });
    expect(parseTeamAddress('Todos, ¿qué hacemos?')).toEqual({ to: 'everyone', text: '¿qué hacemos?' });
    expect(parseTeamAddress('ask claire about revenue')).toEqual({ to: 'claire', text: 'about revenue' });
  });
  it('leaves ordinary sentences, unknown names and bare names alone', () => {
    expect(parseTeamAddress('Jordan said classes are full')).toEqual({ to: null, text: 'Jordan said classes are full' });
    expect(parseTeamAddress('Marcus, write a campaign')).toEqual({ to: null, text: 'Marcus, write a campaign' });
    expect(parseTeamAddress('@Jordan')).toEqual({ to: null, text: '@Jordan' });
    expect(parseTeamAddress('  What is new?  ')).toEqual({ to: null, text: 'What is new?' });
  });
  it('sends everyone to every talker in order and one teammate only when they can talk', () => {
    const talkers = teamTalkers(readiness({ availableAnalystKeys: ['jordan'] }));
    expect(teamRoundTargets('everyone', talkers)).toEqual(['hon', 'claire', 'jordan']);
    expect(teamRoundTargets('jordan', talkers)).toEqual(['jordan']);
    expect(teamRoundTargets('lena', talkers)).toEqual([]);
  });
  it('builds the exact ordinary turns: HON a standard question, analysts a bare delegation, the plan a detailed HON question', () => {
    expect(teamTurnRequest('hon', 'Hi')).toEqual({ text: 'Hi', delegation: null, replyMode: 'STANDARD' });
    expect(teamTurnRequest('lena', 'Hi')).toEqual({ text: 'Hi', delegation: { agentKey: 'lena' } });
    expect(teamPlanRequest()).toEqual({ text: TEAM_PLAN_QUESTION, delegation: null, replyMode: 'DETAILED' });
    expect(() => prepareTurn(SCHOOL, id(5), teamPlanRequest())).not.toThrow();
    for (const k of ['claire', 'alex', 'jordan', 'lena'] as const) expect(() => prepareTurn(SCHOOL, id(5), teamTurnRequest(k, Q))).not.toThrow();
  });
  it('titles and finds team chats', () => {
    expect(teamChatTitle('  What   should we do  ')).toBe(`${TEAM_CHAT_TITLE_PREFIX}What should we do`);
    expect(teamChatTitle('x'.repeat(200)).length).toBeLessThanOrEqual(TEAM_CHAT_TITLE_PREFIX.length + 60);
    const items = [{ id: id(3), title: 'Question', createdAt: AT, updatedAt: AT, turnCount: 1, status: 'COMPLETED' as const }, { id: id(4), title: `${TEAM_CHAT_TITLE_PREFIX}A`, createdAt: AT, updatedAt: AT, turnCount: 1, status: 'COMPLETED' as const }];
    expect(latestTeamChat(items)?.id).toBe(id(4));
    expect(latestTeamChat(items.slice(0, 1))).toBeNull();
  });
});

describe('team chat: messages', () => {
  it('shows one question asked of several teammates once, then each answer', () => {
    const m = teamChatMessages(ROUND);
    expect(m.map((x) => x.kind === 'you' ? `you:${x.to.join(',')}` : x.key)).toEqual(['you:hon,claire,jordan', 'hon', 'claire', 'jordan']);
    expect(teamCanPlan(m)).toBe(true);
  });
  it('keeps separate questions separate and marks HON’s team plan', () => {
    const m = teamChatMessages(thread([...ROUND.turns, turn(4, 'HUMAN', TEAM_PLAN_QUESTION), turn(4, 'hon', '1. Do this.'), turn(6, 'HUMAN', 'Jordan only?'), turn(6, 'jordan', null, { status: 'FAILED', reason: 'RESULT_CONCEALED' })]));
    expect(m.map((x) => x.kind === 'you' ? `you:${x.to.join(',')}` : `${x.key}${x.kind === 'agent' && x.plan ? ':plan' : ''}`))
      .toEqual(['you:hon,claire,jordan', 'hon', 'claire', 'jordan', 'you:hon', 'hon:plan', 'you:jordan', 'jordan']);
    // Only a teammate answer since the last plan offers another plan; a hidden answer does not count.
    expect(teamCanPlan(m)).toBe(false);
    expect(teamCanPlan(teamChatMessages(thread([turn(1, 'HUMAN', 'Hi'), turn(1, 'hon', 'Hello.')])))).toBe(false);
    expect(teamChatMessages(null)).toEqual([]);
  });
  it('reads each answer aloud with the teammate’s name first and in their own voice', () => {
    const parts = teamSpokenParts([{ key: 'hon', reply: 'Focus on trials.' }, { key: 'jordan', reply: null }, { key: 'lena', reply: ' Run a buddy week. ' }], (name) => teamChatText('en', 'said', { name }));
    expect(parts).toEqual([{ text: 'HON says: Focus on trials.', profile: HON_AGENT_VOICES.hon }, { text: 'Lena says: Run a buddy week.', profile: HON_AGENT_VOICES.lena }]);
    expect(teamChatText('ko', 'said', { name: 'Lena' })).toBe('Lena:');
  });
});

describe('team chat: one round', () => {
  const receipt = (n: number, reply: string | null): HonTurnReceipt => ({ turnId: id(n), conversationId: id(5), status: 'COMPLETED', reason: null, delegatedAgentKeys: [], actionRequestIds: [], workItemIds: [], invocationId: null, reply, replyDetail: null });
  const harness = (fail: (key: string, attempt: number) => Error | null = () => null) => {
    const sent: { key: string; body: string }[] = []; const busy: unknown[] = []; let live = true; let refreshes = 0; const attempts = new Map<string, number>();
    const deps: TeamRoundDeps = {
      create: async () => ({ id: id(5), title: `${TEAM_CHAT_TITLE_PREFIX}Q`, createdAt: AT, updatedAt: AT, turnCount: 0, status: 'COMPLETED' }),
      sendTurn: async (prepared) => {
        const body = JSON.parse(prepared.body) as { delegation: { agentKey: string } | null };
        const who = body.delegation?.agentKey ?? 'hon'; const n = (attempts.get(prepared.key) ?? 0) + 1; attempts.set(prepared.key, n);
        sent.push({ key: prepared.key, body: prepared.body });
        const error = fail(who, n); if (error) throw error;
        return receipt(sent.length, `${who} answer`);
      },
      prepare: (conversationId, request) => prepareTurn(SCHOOL, conversationId, request),
      refresh: async () => { refreshes++; }, live: () => live, onBusy: (who) => busy.push(who), onConversation: () => {},
    };
    return { deps, sent, busy, retire: () => { live = false; }, get refreshes() { return refreshes; } };
  };
  const round = () => newTeamRound({ create: { path: '/x', key: id(7), body: '{}' }, conversationId: null, text: Q, request: (k) => teamTurnRequest(k, Q), targets: ['hon', 'claire', 'jordan'], spoken: false });

  it('creates the chat, then asks each teammate once, in order', async () => {
    const h = harness();
    const out = await runTeamRound(round(), h.deps);
    expect(out).toEqual({ kind: 'DONE', answers: [{ key: 'hon', reply: 'hon answer' }, { key: 'claire', reply: 'claire answer' }, { key: 'jordan', reply: 'jordan answer' }] });
    expect(h.sent.map((s) => (JSON.parse(s.body) as { delegation: { agentKey: string } | null }).delegation?.agentKey ?? 'hon')).toEqual(['hon', 'claire', 'jordan']);
    expect(new Set(h.sent.map((s) => s.key)).size).toBe(3);
    expect(h.busy).toEqual(['create', 'hon', 'claire', 'jordan', null]);
    expect(h.refreshes).toBe(3);
  });
  it('stops at an unknown outcome and resumes with the exact same request, never re-asking who already answered', async () => {
    const h = harness((who, attempt) => who === 'claire' && attempt === 1 ? new HonConversationError('UNKNOWN') : null);
    const r = round();
    expect(await runTeamRound(r, h.deps)).toEqual({ kind: 'STALLED', state: 'UNKNOWN', who: 'claire' });
    const claireKey = h.sent[1]!.key;
    const out = await runTeamRound(r, h.deps);
    expect(out.kind).toBe('DONE');
    expect(h.sent.map((s) => s.key)).toEqual([h.sent[0]!.key, claireKey, claireKey, h.sent[3]!.key]);
  });
  it('reports a definitive refusal by name and does nothing once retired', async () => {
    const h = harness((who) => who === 'hon' ? new HonConversationError('FORBIDDEN', 'HON_AI_SPEND_REFUSED') : null);
    expect(await runTeamRound(round(), h.deps)).toEqual({ kind: 'STALLED', state: 'FORBIDDEN', who: 'hon' });
    const g = harness();
    const r = round(); const send = g.deps.sendTurn;
    g.deps.sendTurn = async (p) => { const x = await send(p); g.retire(); return x; };
    expect(await runTeamRound(r, g.deps)).toEqual({ kind: 'RETIRED' });
    expect(g.sent).toHaveLength(1);
  });
});

describe('team chat view', () => {
  const noop = () => {};
  const props = (over: Partial<HonTeamChatViewProps> = {}): HonTeamChatViewProps => ({ language: 'en', mode: 'modern', artStyle: 'realistic', phase: 'READY',
    talkers: teamTalkers(readiness()), messages: teamChatMessages(ROUND), to: 'everyone', draft: '', busy: null, stalled: null,
    onTo: noop, onDraft: noop, onSend: noop, onPlan: noop, onNew: noop, onRetry: noop, onDismiss: noop, onRefresh: noop, ...over });
  const render = (over: Partial<HonTeamChatViewProps> = {}) => renderToStaticMarkup(<HonTeamChatView {...props(over)} />);

  it('renders the group chat with every member, who can chat, and the messages by teammate', () => {
    const html = render();
    expect(html).toContain('id="team-chat"');
    for (const k of ['everyone', 'hon', 'claire', 'alex', 'jordan', 'lena', 'marcus', 'chad', 'maya', 'kai']) expect(html).toContain(`data-member="${k}"`);
    expect(html).toMatch(/data-member="jordan" data-member-state="TALKS"/);
    expect(html).toMatch(/data-member="marcus" data-member-state="THROUGH_HON"[^>]*disabled=""/);
    expect(html).toContain('to everyone');
    expect(html).toContain('Claire view.');
    expect(html).toMatch(/<button type="button" class="[^"]*planButton[^"]*"[^>]*>Make a plan together/);
    expect(html).not.toMatch(/planButton[^"]*" disabled=""/);
    expect(html).toContain('data-hon-private');
  });
  it('fits every mode', () => {
    for (const mode of ['modern', 'classic', 'big-button'] as const) {
      const html = render({ mode, artStyle: mode === 'big-button' ? 'chibi' : mode === 'classic' ? 'illustrated' : 'realistic' });
      expect(html).toContain(`data-mode="${mode}"`);
      expect(html).toContain(mode === 'big-button' ? 'rows="3"' : 'rows="2"');
    }
    expect(render({ artStyle: 'chibi' })).toContain('/ai/jordan');
  });
  it('locks sending while a teammate is answering or after an unknown outcome, and offers the exact retry', () => {
    expect(render({ busy: 'jordan' })).toContain('Asking Jordan…');
    expect(render({ busy: 'jordan' })).toMatch(/<textarea[^>]*disabled=""/);
    const r = newTeamRound({ create: null, conversationId: id(5), text: Q, request: (k) => teamTurnRequest(k, Q), targets: ['claire'], spoken: false });
    const html = render({ stalled: { round: r, state: 'UNKNOWN', who: 'claire' } });
    expect(html).toContain('It is not known whether Claire received this. Retry sends the exact same message');
    expect(html).toMatch(/<textarea[^>]*disabled=""/);
  });
  it('says plainly when the team cannot answer, and shows nothing private before it is ready', () => {
    expect(render({ talkers: [] })).toContain('The AI team cannot answer right now');
    expect(render({ talkers: [] })).not.toContain('<textarea');
    const loading = render({ phase: 'LOADING', messages: [] });
    expect(loading).toContain('Loading the team chat…');
    expect(loading).not.toContain('data-hon-private');
    expect(render({ phase: 'SESSION', messages: [] })).toContain('Your session ended.');
  });
  it('speaks Korean and Spanish', () => {
    expect(render({ language: 'ko' })).toContain('팀 채팅');
    expect(render({ language: 'es' })).toContain('Hacer un plan juntos');
  });
});
