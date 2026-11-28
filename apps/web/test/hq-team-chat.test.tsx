import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { HqHonAgentKey, HqHonConversation, HqHonTurn } from '@hon/contracts';
import { MarketingError } from '../src/components/hq-marketing/http';
import {
  HQ_TEAM_PARALLEL, hqTeamMessages, hqTeamTalkers, hqTeamTargets, newHqTeamRound, parseHqTeamAddress, prepareHqTeamRetry, runHqTeamRound, type HqTeamRoundDeps,
} from '../src/components/hq-hon/hq-team-chat-model';
import { HqTeamChatView, type HqTeamChatViewProps } from '../src/components/hq-hon/hq-team-chat';
import { hqTeamChatText } from '../src/components/hq-hon/hq-team-chat-copy';

// HQ team chat (owner ask 2026-11-28): HON and the six HQ executives as one group chat on the HQ dashboard.
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ME = id(50), OTHER = id(51);
const turn = (n: number, agentKey: HqHonAgentKey, patch: Partial<HqHonTurn> = {}): HqHonTurn => ({ turnId: id(n), agentKey, replyMode: 'STANDARD', question: 'How are we doing?',
  status: 'ANSWERED', failureReason: null, reply: `${agentKey} answer`, truncated: false, concealed: false, reservedCredits: 10, chargedCredits: 2,
  askedBy: { principalId: ME, displayName: 'Synthetic Owner' }, version: 1, createdAt: `2026-11-28T00:00:${String(n).padStart(2, '0')}.000Z`, completedAt: null, ...patch });
const conv = (patch: Partial<HqHonConversation> = {}): HqHonConversation => ({ provider: 'CONNECTED', turns: [],
  budget: { periodStart: '2026-11-01', creditCap: 100, usedCredits: 0, heldCredits: 0, availableCredits: 100, inProgress: 0, version: 1, setBy: { principalId: ME, displayName: 'Synthetic Owner' }, setAt: '2026-11-01T00:00:00.000Z' },
  budgetHistory: [], underReview: [], availableAgents: ['hon', 'chase', 'mia', 'ethan', 'olivia', 'ryan', 'sophia'], limit: 50,
  viewer: { principalId: ME, displayName: 'Synthetic Owner', isOwner: true }, asOf: '2026-11-28T00:00:00.000Z', ...patch });

describe('HQ team chat model', () => {
  it('talks only to the agents the server allows, HON first; names pick who a message is for', () => {
    expect(hqTeamTalkers(['mia', 'hon'])).toEqual(['hon', 'mia']);
    expect(hqTeamTalkers(null)).toEqual([]);
    expect(hqTeamTargets('everyone', ['hon', 'mia'])).toEqual(['hon', 'mia']);
    expect(hqTeamTargets('chase', ['hon', 'mia'])).toEqual([]);
    expect(parseHqTeamAddress('Mia, how many open cases?')).toEqual({ to: 'mia', text: 'how many open cases?' });
    expect(parseHqTeamAddress('Everyone: what should we fix first?')).toEqual({ to: 'everyone', text: 'what should we fix first?' });
    expect(parseHqTeamAddress('모두, 이번 주 계획은?')).toEqual({ to: 'everyone', text: '이번 주 계획은?' });
    expect(parseHqTeamAddress('Revenue is flat')).toEqual({ to: null, text: 'Revenue is flat' });
  });
  it('shows only this person\'s questions, one "you" message per question to everyone, oldest first', () => {
    const turns = [turn(3, 'mia'), turn(2, 'chase'), turn(1, 'hon'), turn(4, 'hon', { question: 'Next?' }), turn(5, 'hon', { askedBy: { principalId: OTHER, displayName: 'Other' } })];
    const m = hqTeamMessages(turns, ME);
    expect(m.map((x) => x.kind === 'you' ? `you:${x.to.join('+')}` : x.key)).toEqual(['you:hon+chase+mia', 'hon', 'chase', 'mia', 'you:hon', 'hon']);
  });
});

describe('HQ team chat round', () => {
  const harness = (fail: (key: string, attempt: number) => Error | null = () => null, delay: (key: string) => number = () => 1) => {
    const asked: { key: string; idem: string }[] = []; const busy: unknown[] = []; let inFlight = 0, most = 0, live = true, reads = 0; const tries = new Map<string, number>();
    const deps: HqTeamRoundDeps = {
      ask: async (step, text) => {
        inFlight++; most = Math.max(most, inFlight); asked.push({ key: step.key, idem: step.idempotencyKey });
        const n = (tries.get(step.key) ?? 0) + 1; tries.set(step.key, n);
        await new Promise((r) => setTimeout(r, delay(step.key)));
        inFlight--;
        const e = fail(step.key, n); if (e) throw e;
        return { turn: turn(asked.length, step.key, { question: text }) };
      },
      refresh: async () => { reads++; }, live: () => live, onBusy: (who) => busy.push(who),
    };
    return { deps, asked, busy, get most() { return most; }, get reads() { return reads; }, retire: () => { live = false; } };
  };
  let n = 100; const uuid = () => id(++n);
  const all: HqHonAgentKey[] = ['hon', 'chase', 'mia', 'ethan', 'olivia', 'ryan', 'sophia'];

  it('asks everyone, never more than three at once (the HQ limit), each once with its own key', async () => {
    const h = harness();
    const out = await runHqTeamRound(newHqTeamRound('How are we doing?', all, false, uuid), h.deps);
    expect(out.kind).toBe('DONE');
    expect(out.kind === 'DONE' && out.answers.map((a) => a.key)).toEqual(all);
    expect(h.most).toBe(HQ_TEAM_PARALLEL);
    expect(new Set(h.asked.map((a) => a.idem)).size).toBe(7);
    expect(h.reads).toBe(7);
    expect(h.busy[0]).toEqual(all);
    expect(h.busy.at(-1)).toBeNull();
  });
  it('an unknown outcome keeps its key for Retry; a refusal asks again with a new key; Retry asks only who has no answer', async () => {
    const h = harness((key, attempt) => attempt > 1 ? null : key === 'mia' ? new MarketingError('UNKNOWN') : key === 'ryan' ? new MarketingError('REFUSED', 'HQ_HON_TOO_MANY_IN_PROGRESS') : null);
    const round = newHqTeamRound('Q', all, false, uuid);
    const out = await runHqTeamRound(round, h.deps);
    expect(out).toMatchObject({ kind: 'STALLED', who: 'mia', error: { kind: 'UNKNOWN' } });
    const miaKey = h.asked.find((a) => a.key === 'mia')!.idem, ryanKey = h.asked.find((a) => a.key === 'ryan')!.idem;
    expect((await runHqTeamRound(prepareHqTeamRetry(round, uuid), h.deps)).kind).toBe('DONE');
    const retried = h.asked.slice(7);
    expect(retried.map((a) => a.key).sort()).toEqual(['mia', 'ryan']);
    expect(retried.find((a) => a.key === 'mia')!.idem).toBe(miaKey);
    expect(retried.find((a) => a.key === 'ryan')!.idem).not.toBe(ryanKey);
  });
  it('does nothing more once retired', async () => {
    const h = harness();
    const ask = h.deps.ask; h.deps.ask = async (s, t) => { const r = await ask(s, t); h.retire(); return r; };
    expect(await runHqTeamRound(newHqTeamRound('Q', all, false, uuid), h.deps)).toEqual({ kind: 'RETIRED' });
    expect(h.asked.length).toBeLessThanOrEqual(HQ_TEAM_PARALLEL);
    expect(h.reads).toBe(0);
  });
});

describe('HQ team chat view', () => {
  const noop = () => {};
  const props = (over: Partial<HqTeamChatViewProps> = {}): HqTeamChatViewProps => {
    const view = over.view === undefined ? conv({ turns: [turn(2, 'mia'), turn(1, 'hon', { status: 'ANSWERING', reply: null })] }) : over.view;
    return { language: 'en', art: 'chibi', phase: 'READY', view, talkers: hqTeamTalkers(view?.availableAgents ?? null),
      messages: view ? hqTeamMessages(view.turns, ME) : [], to: 'everyone', draft: '', busy: null, stalled: null,
      onTo: noop, onDraft: noop, onSend: noop, onRetry: noop, onDismiss: noop, onRefresh: noop, ...over };
  };
  const render = (over: Partial<HqTeamChatViewProps> = {}) => renderToStaticMarkup(<HqTeamChatView {...props(over)}/>);

  it('renders the whole HQ team, the messages and a composer', () => {
    const html = render({ voice: <div data-voice-slot=""/> });
    expect(html).toContain('id="hq-team-chat"');
    for (const k of ['everyone', 'hon', 'chase', 'mia', 'ethan', 'olivia', 'ryan', 'sophia']) expect(html).toContain(`data-member="${k}"`);
    expect(html).toContain('mia answer');
    expect(html).toContain('Answering…');
    expect(html).toContain('to everyone');
    expect(html).toContain('<textarea');
    expect(html).toContain('data-voice-slot');
    expect(html).toContain('/hq-assets/chibi/mia.webp');
  });
  it('only offers the agents this person may ask', () => {
    const html = render({ view: conv({ availableAgents: ['hon', 'mia'] }) });
    expect(html).toMatch(/data-member="chase"[^>]*disabled=""/);
    expect(html).not.toMatch(/data-member="mia"[^>]*disabled=""/);
  });
  it('says plainly when no provider is connected; a budget read never blocks the chat', () => {
    expect(render({ view: conv({ provider: 'NOT_CONNECTED' as never }) })).toContain("No AI text provider is connected");
    const noBudget = conv(); noBudget.budget = { ...noBudget.budget, creditCap: null, version: null, setBy: null as never, setAt: null as never, availableCredits: 0 };
    // No monthly limit on HQ (owner 2026-11-24): the chat never blocks on the budget read; the server's refusal decides.
    const html = render({ view: noBudget });
    expect(html).not.toContain('No HQ AI text budget is set');
    expect(html).toContain('<textarea');
    expect(render({ phase: 'LOADING', view: null })).toContain('Loading the team chat…');
    expect(render({ phase: 'LOADING', view: null })).not.toContain('data-hon-private');
  });
  it('locks sending while answering or after an unknown outcome, and explains a busy server', () => {
    expect(render({ busy: ['chase', 'mia'] })).toContain('Asking Chase, Mia…');
    expect(render({ busy: ['chase'] })).toMatch(/<textarea[^>]*disabled=""/);
    const round = newHqTeamRound('Q', ['mia'], false, () => id(9));
    expect(render({ stalled: { round, error: new MarketingError('UNKNOWN'), who: 'mia' } })).toContain('It is not known whether Mia received this');
    expect(render({ stalled: { round, error: new MarketingError('REFUSED', 'HQ_HON_TOO_MANY_IN_PROGRESS'), who: 'mia' } })).toContain('three HQ questions are already answering');
  });
  it('speaks Korean and Spanish', () => {
    expect(render({ language: 'ko' })).toContain('팀과 대화');
    expect(render({ language: 'es' })).toContain('Habla con tu equipo');
    expect(hqTeamChatText('es', 'said', { name: 'Mia' })).toBe('Mia dice:');
  });
});
