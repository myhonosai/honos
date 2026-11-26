import { KAI_JOURNAL_LIMITS, isKaiJournalDate, kaiAddDays, kaiTopicKey, validateSaveKaiJournalEntryInput, type KaiJournalEntry, type KaiJournalSource, type SaveKaiJournalEntryInput } from '@hon/contracts';

/** The journal form, in memory only. A school change or session end drops it. */
export interface JournalDraft {
  entryId: string | null; expectedVersion: number; taughtOn: string; className: string; notes: string; topics: string[];
  source: KaiJournalSource; shared: boolean; topicInput: string;
}
export type JournalProblem = 'date' | 'className' | 'notes' | 'topics';
export const newDraft = (today: string): JournalDraft => ({ entryId: null, expectedVersion: 0, taughtOn: today, className: '', notes: '', topics: [], source: 'TYPED', shared: false, topicInput: '' });
export const draftOf = (entry: KaiJournalEntry): JournalDraft => ({ entryId: entry.entryId, expectedVersion: entry.version, taughtOn: entry.taughtOn,
  className: entry.className ?? '', notes: entry.notes ?? '', topics: [...entry.topics], source: entry.source, shared: entry.shared, topicInput: '' });

const cleanNotes = (notes: string) => notes.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').trim();
const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

/** Adds a topic (one line, single spaces) unless it is empty, too long, a repeat or the eleventh. Adding the typed topic clears the box. */
export function addTopic(draft: JournalDraft, topic?: string): JournalDraft {
  const typed = topic === undefined;
  const t = oneLine(typed ? draft.topicInput : topic);
  if (!t || t.length > KAI_JOURNAL_LIMITS.topicMax || /[<>]/.test(t) || draft.topics.length >= KAI_JOURNAL_LIMITS.topicsMax
    || draft.topics.some(x => kaiTopicKey(x) === kaiTopicKey(t))) return draft;
  return { ...draft, topics: [...draft.topics, t], topicInput: typed ? '' : draft.topicInput };
}

export function saveInput(draft: JournalDraft, remove = false): SaveKaiJournalEntryInput {
  const className = oneLine(draft.className);
  return { entryId: draft.entryId, expectedVersion: draft.expectedVersion, taughtOn: draft.taughtOn, className: className || null,
    notes: cleanNotes(draft.notes), topics: draft.topics, source: draft.source, status: remove ? 'REMOVED' : 'ACTIVE', shared: remove ? false : draft.shared };
}

/** What stops this draft from saving, checked with the same contract the API uses. */
export function draftProblems(draft: JournalDraft, today: string): JournalProblem[] {
  const out: JournalProblem[] = [];
  if (!isKaiJournalDate(draft.taughtOn) || draft.taughtOn > today || draft.taughtOn < kaiAddDays(today, -KAI_JOURNAL_LIMITS.pastDays)) out.push('date');
  const input = saveInput(draft);
  const probe = (patch: Partial<SaveKaiJournalEntryInput>) => { try { validateSaveKaiJournalEntryInput({ ...input, taughtOn: '2026-01-01', notes: 'x', className: null, topics: [], ...patch }); return true; } catch { return false; } };
  if (!probe({ className: input.className })) out.push('className');
  if (!probe({ notes: input.notes })) out.push('notes');
  if (!probe({ topics: input.topics })) out.push('topics');
  return out;
}
