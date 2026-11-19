/**
 * Team chat round runner (pure async, no React): create the conversation if needed, then ask each teammate in order.
 * Each teammate's command is prepared once with a fresh idempotency key and kept on the round, so a resume after a
 * refusal or an unknown outcome resends the exact same request (the server replays it; never a second answer).
 */
import type { HonConversationSummary, HonTurnReceipt, HonTurnRequest } from '@hon/contracts';
import { HonConversationError, type HonConversationFailure, type PreparedHonCommand } from './hon-conversation-http';
import type { TeamTalker } from './hon-team-chat-model';

export type TeamStep = Readonly<{ key: TeamTalker; prepared: PreparedHonCommand }>;
export type TeamRound = {
  create: PreparedHonCommand | null; conversationId: string | null; text: string; request: (key: TeamTalker) => HonTurnRequest;
  targets: readonly TeamTalker[]; steps: TeamStep[]; index: number; answers: { key: TeamTalker; reply: string | null }[]; spoken: boolean;
};
export type TeamRoundDeps = {
  create(prepared: PreparedHonCommand): Promise<HonConversationSummary>;
  sendTurn(prepared: PreparedHonCommand): Promise<HonTurnReceipt>;
  prepare(conversationId: string, request: HonTurnRequest): PreparedHonCommand;
  /** Re-reads the conversation after each answer so messages appear one by one (a failed read is ignored). */
  refresh(conversationId: string): Promise<void>;
  /** False once the school, session or component changed: stop without touching anything. */
  live(): boolean;
  onBusy(who: TeamTalker | 'create' | null): void;
  onConversation(id: string): void;
};
export type TeamRoundOutcome =
  | { kind: 'DONE'; answers: TeamRound['answers'] }
  | { kind: 'STALLED'; state: HonConversationFailure; who: TeamTalker | null }
  | { kind: 'RETIRED' };

export function newTeamRound(input: Pick<TeamRound, 'create' | 'conversationId' | 'text' | 'request' | 'targets' | 'spoken'>): TeamRound {
  return { ...input, steps: [], index: 0, answers: [] };
}

export async function runTeamRound(round: TeamRound, deps: TeamRoundDeps): Promise<TeamRoundOutcome> {
  try {
    if (!round.conversationId) {
      if (!round.create) return { kind: 'STALLED', state: 'INVALID', who: null };
      deps.onBusy('create');
      const created = await deps.create(round.create);
      if (!deps.live()) return { kind: 'RETIRED' };
      round.conversationId = created.id; deps.onConversation(created.id);
    }
    if (round.steps.length === 0) round.steps = round.targets.map((key) => ({ key, prepared: deps.prepare(round.conversationId!, round.request(key)) }));
    for (; round.index < round.steps.length; round.index++) {
      const step = round.steps[round.index]!;
      deps.onBusy(step.key);
      const receipt = await deps.sendTurn(step.prepared);
      if (!deps.live()) return { kind: 'RETIRED' };
      round.answers.push({ key: step.key, reply: receipt.reply });
      await deps.refresh(round.conversationId!).catch(() => undefined);
      if (!deps.live()) return { kind: 'RETIRED' };
    }
    deps.onBusy(null);
    return { kind: 'DONE', answers: round.answers };
  } catch (error) {
    if (!deps.live()) return { kind: 'RETIRED' };
    deps.onBusy(null);
    return { kind: 'STALLED', state: error instanceof HonConversationError ? error.kind : 'UNKNOWN', who: round.steps[round.index]?.key ?? null };
  }
}
