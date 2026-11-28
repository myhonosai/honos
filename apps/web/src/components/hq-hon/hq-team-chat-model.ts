/**
 * HQ team chat (owner ask 2026-11-28: "Set up like school CRM dashboard. Let me talk to team on dashboard."). Pure, no I/O.
 *
 * HQ HON and the six HQ executives (0263/0264) as one group chat on the HQ dashboard: "Everyone" asks every agent this
 * person may ask (the server's availableAgents), or one agent alone. Every message is an ordinary HQ Ask HON question
 * (POST /api/v1/hq/hon/turns) with its own Idempotency-Key, so the server re-checks the person, the agent, the HQ AI
 * budget and the route for each one. HQ allows at most three questions answering at once (0519
 * HQ_HON_TOO_MANY_IN_PROGRESS), so a round asks three at a time.
 */
import { HQ_HON_AGENTS, type HqHonAgentKey, type HqHonTurn, type HqHonTurnReceipt } from '@hon/contracts';
import { MarketingError } from '../hq-marketing/http';

export type HqTeamAddress = 'everyone' | HqHonAgentKey;
export const HQ_TEAM_NAMES: Readonly<Record<HqHonAgentKey, string>> = {
  hon: 'HON', chase: 'Chase', mia: 'Mia', ethan: 'Ethan', olivia: 'Olivia', ryan: 'Ryan', sophia: 'Sophia',
};
/** The HQ server allows three HQ questions answering at once (0263/0519). */
export const HQ_TEAM_PARALLEL = 3;

/** Who may talk here now, in catalog order (HON first): exactly the server's availableAgents. */
export function hqTeamTalkers(available: readonly HqHonAgentKey[] | null): HqHonAgentKey[] {
  return available ? HQ_HON_AGENTS.filter((k) => available.includes(k)) : [];
}

const ADDRESS_WORDS: Readonly<Record<string, HqTeamAddress>> = {
  everyone: 'everyone', everybody: 'everyone', team: 'everyone', all: 'everyone', todos: 'everyone', equipo: 'everyone', 모두: 'everyone', 팀: 'everyone',
  hon: 'hon', chase: 'chase', mia: 'mia', ethan: 'ethan', olivia: 'olivia', ryan: 'ryan', sophia: 'sophia',
};
const LEAD = /^\s*(?:@|(?:hey|hi|ok|okay|ask|oye|헤이)\s+)?([\p{L}]+)\s*(?:[,:;.!?-]\s*|\s+)/iu;
/** "@Mia ...", "Mia, ...", "Hey Chase ..." or "Everyone, ..." picks who the message is for (same rules as the school chat). */
export function parseHqTeamAddress(raw: string): { to: HqTeamAddress | null; text: string } {
  const text = raw.trim();
  const m = LEAD.exec(text);
  if (!m) return { to: null, text };
  const to = ADDRESS_WORDS[m[1]!.toLowerCase()];
  const explicit = /^\s*(?:@|(?:hey|hi|ok|okay|ask|oye|헤이)\s+)/iu.test(text) || /[,:;]/.test(m[0]);
  if (!to || !explicit) return { to: null, text };
  const rest = text.slice(m[0].length).trim();
  return rest ? { to, text: rest } : { to: null, text };
}
export function hqTeamTargets(to: HqTeamAddress, talkers: readonly HqHonAgentKey[]): HqHonAgentKey[] {
  if (to === 'everyone') return [...talkers];
  return talkers.includes(to) ? [to] : [];
}

/** One message on screen: your question (once, naming everyone asked) or one agent's answer. */
export type HqTeamMessage =
  | { kind: 'you'; id: string; text: string; to: HqHonAgentKey[]; createdAt: string }
  | { kind: 'agent'; id: string; key: HqHonAgentKey; turn: HqHonTurn };

/**
 * This person's recent questions as a group chat, oldest first. The same question to several agents within two minutes
 * is one "you" message with every answer under it. Other HQ people's questions are not shown here.
 */
export function hqTeamMessages(turns: readonly HqHonTurn[], viewer: string, limit = 40): HqTeamMessage[] {
  const mine = turns.filter((t) => t.askedBy.principalId === viewer).slice(0, limit).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.turnId.localeCompare(b.turnId));
  const out: HqTeamMessage[] = [];
  let lastYou: Extract<HqTeamMessage, { kind: 'you' }> | null = null;
  for (const turn of mine) {
    const near = lastYou && lastYou.text === turn.question && !lastYou.to.includes(turn.agentKey)
      && Date.parse(turn.createdAt) - Date.parse(lastYou.createdAt) <= 120_000;
    if (near) lastYou!.to.push(turn.agentKey);
    else { lastYou = { kind: 'you', id: `you-${turn.turnId}`, text: turn.question, to: [turn.agentKey], createdAt: turn.createdAt }; out.push(lastYou); }
    out.push({ kind: 'agent', id: turn.turnId, key: turn.agentKey, turn });
  }
  return out;
}

/** One round: the exact attempts (one Idempotency-Key per agent), kept for Retry until each has a definitive answer. */
export type HqTeamStep = { key: HqHonAgentKey; idempotencyKey: string; done: boolean; reply: string | null; failure: MarketingError | null };
export type HqTeamRound = { text: string; steps: HqTeamStep[]; spoken: boolean };
export function newHqTeamRound(text: string, targets: readonly HqHonAgentKey[], spoken: boolean, uuid: () => string): HqTeamRound {
  return { text, spoken, steps: targets.map((key) => ({ key, idempotencyKey: uuid(), done: false, reply: null, failure: null })) };
}
export type HqTeamRoundDeps = {
  ask(step: HqTeamStep, text: string): Promise<HqTeamTurnResult>;
  refresh(): Promise<void>;
  live(): boolean;
  onBusy(who: readonly HqHonAgentKey[] | null): void;
};
export type HqTeamTurnResult = Pick<HqHonTurnReceipt, 'turn'>;
export type HqTeamRoundOutcome =
  | { kind: 'DONE'; answers: { key: HqHonAgentKey; reply: string | null }[] }
  | { kind: 'STALLED'; error: MarketingError; who: HqHonAgentKey }
  | { kind: 'RETIRED' };

/**
 * Asks every unanswered agent, three at a time; each answer appears as it arrives (reads run one after another). An
 * UNKNOWN outcome keeps that agent's key for Retry (the server replays it, never a second question); a definitive
 * refusal gets a new key next time. Retry asks only the agents who have no answer.
 */
export async function runHqTeamRound(round: HqTeamRound, deps: HqTeamRoundDeps, parallel = HQ_TEAM_PARALLEL): Promise<HqTeamRoundOutcome> {
  const queue = round.steps.filter((s) => !s.done);
  const waiting = new Set(queue.map((s) => s.key));
  const busy = () => round.steps.filter((s) => waiting.has(s.key)).map((s) => s.key);
  for (const s of queue) s.failure = null;
  deps.onBusy(busy());
  let reads: Promise<void> = Promise.resolve();
  let retired = false, next = 0;
  const worker = async () => {
    while (next < queue.length && !retired) {
      const step = queue[next++]!;
      try {
        const r = await deps.ask(step, round.text);
        step.done = true; step.reply = r.turn.status === 'ANSWERED' && !r.turn.concealed ? r.turn.reply : null;
      } catch (error) {
        step.failure = error instanceof MarketingError ? error : new MarketingError('UNKNOWN');
      }
      waiting.delete(step.key);
      if (!deps.live()) { retired = true; return; }
      deps.onBusy(waiting.size > 0 ? busy() : null);
      reads = reads.then(() => (deps.live() ? deps.refresh().catch(() => undefined) : undefined));
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(parallel, queue.length)) }, worker));
  await reads;
  if (retired || !deps.live()) return { kind: 'RETIRED' };
  deps.onBusy(null);
  const failed = round.steps.filter((s) => s.failure);
  // UNKNOWN (maybe asked) and CHANGED (that exact attempt is still answering) keep their key so Retry replays it.
  for (const s of failed) if (!keepsKey(s.failure!)) s.idempotencyKey = '';
  if (failed.length > 0) {
    const first = failed.find((s) => s.failure!.kind === 'UNKNOWN') ?? failed[0]!;
    return { kind: 'STALLED', error: first.failure!, who: first.key };
  }
  return { kind: 'DONE', answers: round.steps.map((s) => ({ key: s.key, reply: s.reply })) };
}
const keepsKey = (e: MarketingError) => e.kind === 'UNKNOWN' || e.kind === 'CHANGED';
/** Before a retry: a refused attempt asks again with a new key; an unknown one keeps its key. */
export function prepareHqTeamRetry(round: HqTeamRound, uuid: () => string): HqTeamRound {
  for (const s of round.steps) if (!s.done && !s.idempotencyKey) s.idempotencyKey = uuid();
  return round;
}
/** Which school-team voice each HQ executive borrows when answers are read aloud (HON keeps its own). */
export const HQ_TEAM_VOICE: Readonly<Record<HqHonAgentKey, string>> = {
  hon: 'hon', chase: 'chad', mia: 'maya', ethan: 'alex', olivia: 'claire', ryan: 'jordan', sophia: 'lena',
};
