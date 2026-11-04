export const AI_DRAFT_WORK_AGENT_KEYS = ['marcus', 'claire', 'chad'] as const;
export type AiDraftWorkAgentKey = (typeof AI_DRAFT_WORK_AGENT_KEYS)[number];

/** Union of durable statuses emitted by the three implemented drafting slices. */
export const AI_DRAFT_WORK_STATUSES = [
  'PENDING',
  'CONFIGURATION_REQUIRED',
  'BLOCKED',
  'SENDING',
  'UNKNOWN',
  'FAILED',
  'RESULT_RECORDED',
  'RESULT_HELD',
  'AWAITING_APPROVAL',
  'SAVED',
  'APPROVED',
  'REJECTED',
] as const;
export type AiDraftWorkStatus = (typeof AI_DRAFT_WORK_STATUSES)[number];

/**
 * A redacted, durable work pointer for the current requester only. It is not a
 * prompt, draft, provider record, usage ledger, delivery receipt, or authority
 * grant. `sourceRecordId` is an already-known campaign, curriculum, or lead
 * reference and is only returned after that assistant's existing authorization.
 */
export interface AiDraftWorkItem {
  id: string;
  agentKey: AiDraftWorkAgentKey;
  schoolId: string;
  sourceRecordId: string;
  workItemId: string;
  status: AiDraftWorkStatus;
  reason: string | null;
  actionRequestId: string | null;
  updatedAt: string;
}

export interface MyAiDraftWork {
  items: ReadonlyArray<AiDraftWorkItem>;
}
