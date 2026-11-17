/**
 * Team chat (owner ask 2026-11-17): the AI team as one group chat on the school Dashboard. Pure model, no I/O.
 *
 * One HON conversation is shown as a group chat. "Everyone" sends the same question to HON and then to every specialist
 * who can answer in text for this person now (readiness decides); "take turns" sends to one teammate. Every message is
 * an ordinary turn on the existing conversation API, so the server re-checks the person, school, capability and AI
 * limits for each one. "Make a plan together" asks HON (detailed) to combine the team's answers (migration 0444 lets HON
 * read the answers this person may see).
 */
import {
  HON_ANALYST_AGENTS, type HonAnalystAgentKey, type HonConversationReadiness, type HonConversationSummary, type HonConversationThread,
  type HonConversationTurn, type HonTurnRequest,
} from '@hon/contracts';
import { honAgentVoice, type HonSpokenPart } from './hon-voice';

/** Teammates who answer in text in the team chat. */
export type TeamTalker = 'hon' | Exclude<HonAnalystAgentKey, 'maya'>;
export type TeamAddress = 'everyone' | TeamTalker;
export type TeamMemberKey = TeamTalker | 'marcus' | 'chad' | 'maya' | 'kai';

/** Order on screen and in an "Everyone" round: HON first, then the analysts. */
export const TEAM_TALKERS: readonly TeamTalker[] = ['hon', 'claire', 'alex', 'jordan', 'lena'];
export const TEAM_MEMBERS: readonly TeamMemberKey[] = ['hon', 'claire', 'alex', 'jordan', 'lena', 'marcus', 'chad', 'maya', 'kai'];
export const TEAM_NAMES: Readonly<Record<TeamMemberKey, string>> = {
  hon: 'HON', claire: 'Claire', alex: 'Alex', jordan: 'Jordan', lena: 'Lena', marcus: 'Marcus', chad: 'Chad', maya: 'Maya', kai: 'Kai',
};
/** Team chat conversations are ordinary HON conversations whose title starts with this. */
export const TEAM_CHAT_TITLE_PREFIX = 'Team chat: ';
export const TEAM_PLAN_QUESTION = 'Make one plan from what the team said: numbered steps, who each point comes from, and what each teammate could look at next.';

/** Who can talk in text for this person now: HON when admitted, each analyst when readiness offers them. */
export function teamTalkers(readiness: HonConversationReadiness | null): TeamTalker[] {
  if (!readiness || readiness.honReply !== true) return [];
  const analysts = HON_ANALYST_AGENTS.filter((k): k is Exclude<HonAnalystAgentKey, 'maya'> => k !== 'maya'
    && (k === 'claire' ? readiness.businessPerformance === true : (readiness.availableAnalystKeys ?? []).includes(k)));
  return ['hon', ...TEAM_TALKERS.filter((k): k is Exclude<TeamTalker, 'hon'> => k !== 'hon' && analysts.includes(k))];
}

/** What a member can do in this chat: talk now, work through HON (drafts), or not available for this person. */
export type TeamMemberState = 'TALKS' | 'THROUGH_HON' | 'NOT_AVAILABLE';
export function teamMemberState(key: TeamMemberKey, talkers: readonly TeamTalker[]): TeamMemberState {
  if ((talkers as readonly string[]).includes(key)) return 'TALKS';
  return key === 'marcus' || key === 'chad' || key === 'maya' || key === 'kai' ? 'THROUGH_HON' : 'NOT_AVAILABLE';
}

const ADDRESS_WORDS: Readonly<Record<string, TeamAddress>> = {
  everyone: 'everyone', everybody: 'everyone', team: 'everyone', all: 'everyone', todos: 'everyone', equipo: 'everyone', 모두: 'everyone', 팀: 'everyone',
  hon: 'hon', claire: 'claire', alex: 'alex', jordan: 'jordan', lena: 'lena',
};
const LEAD = /^\s*(?:@|(?:hey|hi|ok|okay|ask|oye|헤이)\s+)?([\p{L}]+)\s*(?:[,:;.!?-]\s*|\s+)/iu;

/**
 * "@Jordan ...", "Jordan, ...", "Hey Alex ..." or "Everyone, ..." picks who the message is for. A bare word that is not a
 * teammate's name, or a name with nothing after it, leaves the message and the current choice unchanged.
 */
export function parseTeamAddress(raw: string): { to: TeamAddress | null; text: string } {
  const text = raw.trim();
  const m = LEAD.exec(text);
  if (!m) return { to: null, text };
  const word = m[1]!.toLowerCase();
  const to = ADDRESS_WORDS[word];
  const explicit = /^\s*(?:@|(?:hey|hi|ok|okay|ask|oye|헤이)\s+)/iu.test(text) || /[,:;]/.test(m[0]);
  if (!to || !explicit) return { to: null, text };
  const rest = text.slice(m[0].length).trim();
  return rest ? { to, text: rest } : { to: null, text };
}

/** Who one message goes to, in order. A teammate who cannot talk now is never asked. */
export function teamRoundTargets(to: TeamAddress, talkers: readonly TeamTalker[]): TeamTalker[] {
  if (to === 'everyone') return TEAM_TALKERS.filter((k) => talkers.includes(k));
  return talkers.includes(to) ? [to] : [];
}

/** The exact turn for one teammate: a question to HON, or a bare analyst delegation (the server fixes it to one answer). */
export function teamTurnRequest(key: TeamTalker, text: string): HonTurnRequest {
  return key === 'hon' ? { text, delegation: null, replyMode: 'STANDARD' } : { text, delegation: { agentKey: key } };
}
export function teamPlanRequest(): HonTurnRequest { return { text: TEAM_PLAN_QUESTION, delegation: null, replyMode: 'DETAILED' }; }

export function teamChatTitle(text: string): string {
  const room = 120 - TEAM_CHAT_TITLE_PREFIX.length;
  const flat = text.replace(/\s+/g, ' ').trim();
  return TEAM_CHAT_TITLE_PREFIX + (flat.length > Math.min(room, 60) ? `${flat.slice(0, Math.min(room, 60) - 3).trimEnd()}…` : flat);
}
/** The newest team chat in the person's conversation list (the list is newest first). */
export function latestTeamChat(items: readonly HonConversationSummary[]): HonConversationSummary | null {
  return items.find((item) => item.title.startsWith(TEAM_CHAT_TITLE_PREFIX)) ?? null;
}

/** One message on screen: what you said (once, even when several teammates were asked) or one teammate's answer. */
export type TeamChatMessage =
  | { kind: 'you'; id: string; text: string; to: TeamMemberKey[]; createdAt: string }
  | { kind: 'agent'; id: string; key: TeamMemberKey; text: string | null; status: HonConversationTurn['status']; reason: string | null; createdAt: string; plan: boolean };

const memberKey = (role: string): TeamMemberKey => ((TEAM_MEMBERS as readonly string[]).includes(role) ? role : 'hon') as TeamMemberKey;

/** Collapses the same question sent to several teammates in a row into one "you" message naming all of them. */
export function teamChatMessages(thread: HonConversationThread | null): TeamChatMessage[] {
  if (!thread) return [];
  const out: TeamChatMessage[] = [];
  let lastYou: Extract<TeamChatMessage, { kind: 'you' }> | null = null;
  let answersSinceYou = 0;
  for (let i = 0; i < thread.turns.length; i++) {
    const turn = thread.turns[i]!;
    if (turn.role === 'HUMAN') {
      const next = thread.turns[i + 1];
      const to = next && next.turnId === turn.turnId && next.role !== 'HUMAN' ? memberKey(next.role) : 'hon';
      const text = turn.text ?? '';
      if (lastYou && lastYou.text === text && answersSinceYou > 0 && !lastYou.to.includes(to)) { lastYou.to.push(to); answersSinceYou = 0; continue; }
      lastYou = { kind: 'you', id: turn.turnId, text, to: [to], createdAt: turn.createdAt }; answersSinceYou = 0;
      out.push(lastYou);
      continue;
    }
    answersSinceYou++;
    out.push({ kind: 'agent', id: `${turn.turnId}-${turn.role}`, key: memberKey(turn.role), text: turn.text, status: turn.status, reason: turn.reason, createdAt: turn.createdAt,
      plan: turn.role === 'hon' && lastYou?.text === TEAM_PLAN_QUESTION });
  }
  return out;
}

/** "Make a plan together" is offered once at least one teammate other than HON answered since the last plan. */
export function teamCanPlan(messages: readonly TeamChatMessage[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.kind === 'agent' && m.plan) return false;
    if (m.kind === 'agent' && m.key !== 'hon' && m.status === 'COMPLETED' && m.text) return true;
  }
  return false;
}

/** What is read aloud after a round: each answer with the teammate's name first, in their own voice. */
export function teamSpokenParts(answers: readonly { key: TeamTalker; reply: string | null }[], said: (name: string) => string): HonSpokenPart[] {
  return answers.filter((a) => a.reply && a.reply.trim()).map((a) => ({ text: `${said(TEAM_NAMES[a.key])} ${a.reply!.trim()}`, profile: honAgentVoice(a.key) }));
}
