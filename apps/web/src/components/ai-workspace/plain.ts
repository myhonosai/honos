/**
 * Plain words for the AI workspaces (owner, 2026-11-14: no developer or legal text on school screens).
 * Every status a draft can have maps to one short line a school owner understands. Nothing here decides anything.
 */
export type DraftStatus = 'PENDING' | 'CONFIGURATION_REQUIRED' | 'BLOCKED' | 'SENDING' | 'UNKNOWN' | 'FAILED' | 'RESULT_RECORDED' | 'RESULT_HELD'
  | 'AWAITING_APPROVAL' | 'APPROVED' | 'SAVED' | 'REJECTED';

const STATUS: Record<DraftStatus, { title: string; detail: string; tone: 'working' | 'waiting' | 'done' | 'stopped' }> = {
  PENDING: { title: 'Getting started', detail: 'Your request is saved. Check back in a moment.', tone: 'working' },
  SENDING: { title: 'Writing your draft', detail: 'This usually takes under a minute.', tone: 'working' },
  CONFIGURATION_REQUIRED: { title: 'AI is not switched on for your school yet', detail: 'Your request is saved. Try again once AI is on.', tone: 'stopped' },
  BLOCKED: { title: 'Paused', detail: 'Your request is saved but could not start.', tone: 'stopped' },
  UNKNOWN: { title: 'We could not confirm this draft finished', detail: 'It will not be retried, so nothing is written or counted twice. HON support can check it for you.', tone: 'stopped' },
  FAILED: { title: 'The draft could not be written', detail: 'Nothing was sent. You can start a new request.', tone: 'stopped' },
  RESULT_RECORDED: { title: 'Draft ready', detail: 'It is waiting for a check before anyone can approve it.', tone: 'waiting' },
  RESULT_HELD: { title: 'Draft ready, held for a check', detail: 'It needs a review before it can be approved.', tone: 'waiting' },
  AWAITING_APPROVAL: { title: 'Waiting for approval', detail: 'Another staff member with approval rights reviews it in Action Center. You cannot approve your own draft.', tone: 'waiting' },
  APPROVED: { title: 'Approved', detail: 'Approved as a draft only. Nothing was sent; you decide when and how to use it.', tone: 'done' },
  SAVED: { title: 'Saved', detail: 'Saved inside HON for your team. Nothing was published or sent.', tone: 'done' },
  REJECTED: { title: 'Not approved', detail: 'Nothing was saved or sent.', tone: 'stopped' },
};

export function draftStatus(status: string): { title: string; detail: string; tone: 'working' | 'waiting' | 'done' | 'stopped' } {
  return STATUS[status as DraftStatus] ?? { title: 'Status unknown', detail: 'Refresh to check again.', tone: 'stopped' };
}

/** Internal refusal codes in plain words; an unrecognised code is never shown raw. */
const REASONS: Record<string, string> = {
  CUSTOMER_BUDGET_EXCEEDED: 'Your included AI for this month is used up. Nothing is charged.',
  ORGANIZATION_AI_BUDGET_REACHED: 'Your included AI for this month is used up. Nothing is charged.',
  CONFIGURATION_REQUIRED: 'AI is not switched on for your school yet.',
  PROVIDER_RUNTIME_NOT_CONFIGURED: 'AI is not switched on for your school yet.',
  AI_PAUSED_BY_HQ: 'AI is paused for your school. Contact HON support.',
  NOT_AUTHORIZED: 'Your role does not include this. Ask a school owner.',
  NO_ELIGIBLE_ROUTE: 'AI is not set up for your school yet.',
};
export function plainReason(reason: string | null): string | null {
  if (!reason) return null;
  if (REASONS[reason]) return REASONS[reason]!;
  if (reason.startsWith('AI_ACCESS_') || reason.startsWith('AI_TRIAL_') || reason === 'AI_EXCEPTION_NO_AI') return 'AI is not included for your school right now. Check HON subscription in Settings.';
  return 'Something stopped this draft. Refresh, or ask HON support.';
}

export const DRAFT_PURPOSE_LABELS: Record<string, string> = {
  INTRODUCTION: 'First hello to a new lead', CHECK_IN: 'Friendly check-in', TRIAL_REMINDER: 'Reminder about their trial class', REENGAGEMENT: 'Reconnect after a quiet spell',
};
export function purposeLabel(purpose: string): string {
  return DRAFT_PURPOSE_LABELS[purpose] ?? purpose.toLowerCase().replaceAll('_', ' ').replace(/^./, c => c.toUpperCase());
}

/**
 * "Try again" is offered only before anything reached a provider. A SENDING, UNKNOWN or FAILED draft is never resent,
 * so nothing is written or counted twice.
 */
export function canTryAgain(status: string): boolean { return status === 'CONFIGURATION_REQUIRED' || status === 'BLOCKED' || status === 'PENDING'; }
