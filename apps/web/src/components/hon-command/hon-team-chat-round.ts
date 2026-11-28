/**
 * Team chat round runner (pure async, no React): create the conversation if needed, then ask every teammate at once.
 * Each teammate's command is prepared once with a fresh idempotency key and kept on the round, so a resume after a
 * refusal or an unknown outcome resends the exact same request (the server replays it; never a second answer), and
 * only to the teammates who have not answered yet.
 *
 * 2026-11-28 (owner live test): asking one teammate after another made an "Everyone" question take ~37 s (five model
 * calls in a row). HON is asked first; once HON's turn settles, the specialists (who answer independently and read no
 * history) are asked in parallel, so a round takes about two answers' time. Each answer appears as soon as it arrives.
 * HON goes first on purpose: prepare_hon_reply (0451) gives HON the six turns before its own, so if the specialists'
 * turns of the same round were created first, HON's window would hold its own question four more times and lose the
 * previous round (independent review of #683).
 */
import type { HonConversationSummary, HonTurnReceipt, HonTurnRequest } from '@hon/contracts';
import { HonConversationError, type HonConversationFailure, type PreparedHonCommand } from './hon-conversation-http';
import type { TeamTalker } from './hon-team-chat-model';

export type TeamStep = { key: TeamTalker; prepared: PreparedHonCommand; done: boolean; reply: string | null };
export type TeamRound = {
  create: PreparedHonCommand | null; conversationId: string | null; text: string; request: (key: TeamTalker) => HonTurnRequest;
  targets: readonly TeamTalker[]; steps: TeamStep[]; spoken: boolean;
};
/** Who the round is waiting on: the conversation being made, the teammates still answering, or nobody. */
export type TeamBusy = 'create' | readonly TeamTalker[] | null;
export type TeamRoundDeps = {
  create(prepared: PreparedHonCommand): Promise<HonConversationSummary>;
  sendTurn(prepared: PreparedHonCommand): Promise<HonTurnReceipt>;
  prepare(conversationId: string, request: HonTurnRequest): PreparedHonCommand;
  /** Re-reads the conversation after each answer so messages appear one by one (a failed read is ignored). */
  refresh(conversationId: string): Promise<void>;
  /** False once the school, session or component changed: stop without touching anything. */
  live(): boolean;
  onBusy(who: TeamBusy): void;
  onConversation(id: string): void;
};
export type TeamAnswer = { key: TeamTalker; reply: string | null };
export type TeamRoundOutcome =
  | { kind: 'DONE'; answers: TeamAnswer[] }
  | { kind: 'STALLED'; state: HonConversationFailure; who: TeamTalker | null }
  | { kind: 'RETIRED' };

export function newTeamRound(input: Pick<TeamRound, 'create' | 'conversationId' | 'text' | 'request' | 'targets' | 'spoken'>): TeamRound {
  return { ...input, steps: [] };
}

const failureOf = (error: unknown): HonConversationFailure => error instanceof HonConversationError ? error.kind : 'UNKNOWN';

export async function runTeamRound(round: TeamRound, deps: TeamRoundDeps): Promise<TeamRoundOutcome> {
  try {
    if (!round.conversationId) {
      if (!round.create) return { kind: 'STALLED', state: 'INVALID', who: null };
      deps.onBusy('create');
      const created = await deps.create(round.create);
      if (!deps.live()) return { kind: 'RETIRED' };
      round.conversationId = created.id; deps.onConversation(created.id);
    }
    const id = round.conversationId;
    if (round.steps.length === 0) round.steps = round.targets.map((key) => ({ key, prepared: deps.prepare(id, round.request(key)), done: false, reply: null }));
  } catch (error) {
    if (!deps.live()) return { kind: 'RETIRED' };
    deps.onBusy(null);
    return { kind: 'STALLED', state: failureOf(error), who: null };
  }
  const conversationId = round.conversationId;
  const pending = round.steps.filter((step) => !step.done);
  const waiting = new Set(pending.map((step) => step.key));
  const busyNow = () => round.steps.filter((step) => waiting.has(step.key)).map((step) => step.key);
  deps.onBusy(busyNow());
  // Reads run one after another so an older read never replaces a newer one on screen.
  let reads: Promise<void> = Promise.resolve();
  const failures = new Map<TeamTalker, HonConversationFailure>();
  let retired = false;
  const ask = async (step: TeamStep) => {
    try {
      const receipt = await deps.sendTurn(step.prepared);
      step.done = true; step.reply = receipt.reply;
    } catch (error) {
      failures.set(step.key, failureOf(error));
    }
    waiting.delete(step.key);
    if (!deps.live()) { retired = true; return; }
    deps.onBusy(waiting.size > 0 ? busyNow() : null);
    if (step.done) reads = reads.then(() => (deps.live() ? deps.refresh(conversationId).catch(() => undefined) : undefined));
  };
  const first = pending.filter((step) => step.key === 'hon'), rest = pending.filter((step) => step.key !== 'hon');
  await Promise.all(first.map(ask));
  if (!retired && deps.live()) await Promise.all(rest.map(ask));
  await reads;
  if (retired || !deps.live()) return { kind: 'RETIRED' };
  deps.onBusy(null);
  if (failures.size > 0) {
    // An unknown outcome wins (it locks sending until retried); otherwise the first teammate in order who was refused.
    const order = round.steps.filter((step) => failures.has(step.key));
    const unknown = order.find((step) => failures.get(step.key) === 'UNKNOWN');
    const who = (unknown ?? order[0]!).key;
    return { kind: 'STALLED', state: failures.get(who)!, who };
  }
  return { kind: 'DONE', answers: round.steps.map((step) => ({ key: step.key, reply: step.reply })) };
}
