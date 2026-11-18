import type { EianScreen as AiScreen, EianTurn } from '@hon/contracts/eian';
import type { ParentApi } from '../api/client';
import { classify, type EianAnswer, type EianTab } from './eian-engine';

/**
 * Eian AI mode (E-AI1). Only a question the guided engine does not recognize goes to HON's AI. The answer is text plus
 * at most one screen from a closed list; the app opens that screen and the parent acts there. No provider or model
 * name is ever shown, and a billing or testing answer always says to check with the school.
 */
export const AI_SOURCE = "Eian (AI), using your school's records";
export const CHECK_WITH_SCHOOL = 'Please check with your school before you rely on this.';

const SCREEN_ACTION: Record<AiScreen, { label: string; tab: EianTab }> = {
  SCHEDULE: { label: 'Open schedule', tab: 'Schedule' },
  BOOK_CLASS: { label: 'Book a class', tab: 'Schedule' },
  REPORT_ABSENCE: { label: 'Report an absence', tab: 'Schedule' },
  MESSAGES: { label: 'Open messages', tab: 'Messages' },
  BILLING: { label: 'Open billing', tab: 'More' },
  TESTING: { label: 'Open belt testing', tab: 'More' },
};
/** Reasons that mean AI is off for now, so Eian goes back to guided answers. */
const AI_OFF = new Set(['BUDGET_REACHED', 'NOT_INCLUDED', 'NOT_CONFIGURED', 'PAUSED']);

export type EianAiOutcome =
  | { kind: 'answer'; answer: EianAnswer; reuseKey: boolean }
  | { kind: 'guided'; aiOff: boolean };

const say = (lines: string[], action?: EianAnswer['action']): EianAnswer => ({ intent: 'help', lines, source: null, ...(action ? { action } : {}) });

/** What one turn means for the parent. `reuseKey` is true when the same question must be re-asked with the same key. */
export function turnOutcome(turn: EianTurn): EianAiOutcome {
  switch (turn.status) {
    case 'COMPLETED': {
      if (!turn.reply) return { kind: 'answer', reuseKey: false, answer: say(["I can't show this answer right now."]) };
      const lines = turn.reply.split(/\n+/).map(l => l.trim()).filter(Boolean);
      const intent = classify(turn.question);
      if (turn.screen === 'BILLING' || turn.screen === 'TESTING' || intent === 'billing' || intent === 'testing') lines.push(CHECK_WITH_SCHOOL);
      return { kind: 'answer', reuseKey: false,
        answer: { intent: 'help', lines, source: AI_SOURCE, ...(turn.screen ? { action: SCREEN_ACTION[turn.screen] } : {}) } };
    }
    case 'RESULT_HELD':
      return { kind: 'answer', reuseKey: false, answer: say(["Your school access changed while I was answering, so I can't show this answer."]) };
    case 'UNKNOWN':
      return { kind: 'answer', reuseKey: false,
        answer: say(["I couldn't confirm an answer to this question, so I won't ask it again. Your school can look into it."], SCREEN_ACTION.MESSAGES) };
    case 'PENDING':
    case 'SENDING':
      return { kind: 'answer', reuseKey: true, answer: say(['I am still working on this. Ask the same question again in a moment.']) };
    default:
      if (turn.reason && AI_OFF.has(turn.reason)) return { kind: 'guided', aiOff: true };
      return { kind: 'answer', reuseKey: false,
        answer: say(["I couldn't answer that one. Try asking another way, or message your school."], SCREEN_ACTION.MESSAGES) };
  }
}

/**
 * Asks once with `key`. An unknown outcome is asked again with the same key and the exact same question (HON replays
 * that turn, never a second call); a turn still in flight is re-read by id once.
 */
export async function askEianAi(api: ParentApi, question: string, key: string): Promise<EianAiOutcome> {
  let result = await api.askEian(question, key);
  if (!result.ok && result.state === 'unknown') result = await api.askEian(question, key);
  if (!result.ok) {
    if (result.state === 'unknown') return { kind: 'answer', reuseKey: true, answer: say(["I couldn't confirm an answer just now. Ask the same question again in a moment."]) };
    if (result.state === 'refused' && result.code === 'EIAN_BUSY') {
      return { kind: 'answer', reuseKey: false, answer: say(["You've asked a lot of questions in the last few minutes. Please try again shortly."]) };
    }
    return { kind: 'guided', aiOff: result.state === 'refused' && result.code === 'EIAN_AI_UNAVAILABLE' };
  }
  let turn = result.data;
  if (turn.status === 'PENDING' || turn.status === 'SENDING') {
    const again = await api.eianTurn(turn.id);
    if (again.ok) turn = again.data;
  }
  return turnOutcome(turn);
}
