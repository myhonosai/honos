import {
  CONVERSATION_AI_CHANNELS, conversationAiHandoffWordsOk,
  type ConversationAiChannel, type ConversationAiItem, type ConversationAiMode, type ConversationAiOverview, type ConversationAiProgramStatus,
} from '@hon/contracts';

/**
 * CE1 Conversation AI easy setup (docs/architecture/CONVERSATION_AI_EASY_SETUP.md). Pure helpers: no calls, no storage.
 * The server (0420) still checks every value; these only keep the screen honest about what will be accepted.
 */
export type ModeSummary = ConversationAiMode | 'MIXED';
export type Modes = Record<ConversationAiChannel, ConversationAiMode>;

export function modeSummary(modes: Modes): ModeSummary {
  const first = modes[CONVERSATION_AI_CHANNELS[0]];
  return CONVERSATION_AI_CHANNELS.every(c => modes[c] === first) ? first : 'MIXED';
}
export function modesAll(mode: ConversationAiMode): Modes { return { SMS: mode, WEB_CHAT: mode, EMAIL: mode }; }
/** The school is on when any channel is on; there is no separate switch to forget. */
export function enabledFromModes(modes: Modes): boolean { return CONVERSATION_AI_CHANNELS.some(c => modes[c] !== 'OFF'); }

export const ANSWER_GOAL = 5;
export type SetupChecklist = { how: boolean; answers: boolean; answerCount: number; handoff: boolean; tryIt: boolean };
export function setupChecklist(overview: ConversationAiOverview): SetupChecklist {
  const answerCount = overview.items.filter(i => i.status === 'ACTIVE').length;
  return { how: enabledFromModes(overview.settings.modes), answers: answerCount >= ANSWER_GOAL, answerCount, handoff: overview.settings.handoffWords.length > 0, tryIt: false };
}

/** Common questions families ask a martial arts school; the owner only types the answer. */
export const QUICK_START_KEYS = ['trial', 'price', 'ages', 'wear', 'schedule', 'contract', 'adults', 'belts', 'makeup', 'parking'] as const;
export type QuickStartKey = (typeof QUICK_START_KEYS)[number];
const norm = (text: string) => text.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[?？!.]+$/, '');
/** Quick start questions not yet answered by a question-and-answer or coaching item (switched off still counts as answered). */
export function quickStartLeft(items: readonly ConversationAiItem[], questions: Record<QuickStartKey, string>): QuickStartKey[] {
  const asked = new Set(items.filter(i => i.question !== null && (i.kind === 'FAQ' || i.kind === 'COACHING')).map(i => norm(i.question ?? '')));
  return QUICK_START_KEYS.filter(k => !asked.has(norm(questions[k])));
}

export function handoffList(text: string): string[] { return text.split(',').map(w => w.trim().toLowerCase()).filter(Boolean); }
/** The comma text with one more word, or null when the server would refuse it (bad characters, duplicate, more than 20). */
export function addHandoffWord(text: string, raw: string): string | null {
  const next = [...handoffList(text), raw.trim().toLowerCase()];
  return raw.trim() && conversationAiHandoffWordsOk(next) ? next.join(', ') : null;
}
export function removeHandoffWord(text: string, word: string): string { return handoffList(text).filter(w => w !== word).join(', '); }

export const LENGTH_PRESETS = [{ key: 'short', chars: 160 }, { key: 'normal', chars: 320 }, { key: 'long', chars: 640 }] as const;
export type LengthKey = (typeof LENGTH_PRESETS)[number]['key'];

export type StatusTone = 'off' | 'on' | 'practice' | 'waiting';
export function statusTone(program: ConversationAiProgramStatus, summary: ModeSummary): StatusTone {
  if (summary === 'OFF') return 'off';
  if (program === 'OFF') return 'waiting';
  return program === 'TEST_MODE' ? 'practice' : 'on';
}
