import {
  AI_DRAFT_WORK_AGENT_KEYS,
  AI_DRAFT_WORK_STATUSES,
  type AiDraftWorkAgentKey,
  type AiDraftWorkItem,
} from '@hon/contracts';

const FIXED_ENDPOINTS: Record<AiDraftWorkAgentKey, string> = {
  marcus: '/api/v1/marketing/assistant/mine',
  claire: '/api/v1/staff/teaching-assistant/mine',
  chad: '/api/v1/staff/leads/assistant/mine',
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function safeId(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

function problem(status: number): Error {
  if (status === 401 || status === 403) return new Error('Current direct-human access is unavailable.');
  if (status === 404) return new Error('The requested HON work item is unavailable.');
  return new Error('The AI Draft Work inbox is temporarily unavailable.');
}

export function verifyAiDraftWorkItem(value: unknown, agentKey: AiDraftWorkAgentKey): AiDraftWorkItem {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Unverified AI Draft Work item.');
  const record = value as Record<string, unknown>;
  const permitted = new Set(['id', 'agentKey', 'schoolId', 'sourceRecordId', 'workItemId', 'status', 'reason', 'actionRequestId', 'updatedAt']);
  if (Object.keys(record).some((key) => !permitted.has(key))) throw new Error('Unverified AI Draft Work item.');
  if (!safeId(record.id) || record.agentKey !== agentKey || !safeId(record.schoolId) || !safeId(record.sourceRecordId) || !safeId(record.workItemId)) throw new Error('Unverified AI Draft Work item.');
  if (typeof record.status !== 'string' || !AI_DRAFT_WORK_STATUSES.includes(record.status as (typeof AI_DRAFT_WORK_STATUSES)[number])) throw new Error('Unverified AI Draft Work item.');
  if (record.reason !== null && typeof record.reason !== 'string') throw new Error('Unverified AI Draft Work item.');
  if (record.actionRequestId !== null && !safeId(record.actionRequestId)) throw new Error('Unverified AI Draft Work item.');
  if (typeof record.updatedAt !== 'string' || Number.isNaN(Date.parse(record.updatedAt))) throw new Error('Unverified AI Draft Work item.');
  return record as unknown as AiDraftWorkItem;
}

export async function loadMyAiDraftWork(agentKey: AiDraftWorkAgentKey): Promise<AiDraftWorkItem[]> {
  const endpoint = FIXED_ENDPOINTS[agentKey];
  if (!endpoint) throw new Error('Unverified AI Draft Work agent.');
  const response = await fetch(endpoint, {
    method: 'GET',
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
    headers: { Accept: 'application/json', 'X-HON-Human-Command': 'ai-draft-work' },
  });
  if (!response.ok) throw problem(response.status);
  const body = await response.json() as { data?: unknown };
  if (!body || !Array.isArray(body.data) || Object.keys(body).some((key) => key !== 'data' && key !== 'meta')) throw new Error('Unverified AI Draft Work response.');
  if (body.data.length > 20) throw new Error('Unverified AI Draft Work response.');
  const items = body.data.map((item) => verifyAiDraftWorkItem(item, agentKey));
  const ordered = [...items].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || right.id.localeCompare(left.id));
  if (items.some((item, index) => item !== ordered[index])) throw new Error('Unverified AI Draft Work response.');
  return items;
}

export async function loadAllMyAiDraftWork(): Promise<{ items: AiDraftWorkItem[]; unavailable: AiDraftWorkAgentKey[] }> {
  const results = await Promise.all(AI_DRAFT_WORK_AGENT_KEYS.map(async (agentKey) => {
    try {
      return { agentKey, items: await loadMyAiDraftWork(agentKey), unavailable: false };
    } catch (error) {
      if (error instanceof Error && error.message === 'Current direct-human access is unavailable.') return { agentKey, items: [], unavailable: true };
      throw error;
    }
  }));
  return {
    items: results.flatMap((result) => result.items).sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || right.id.localeCompare(left.id)),
    unavailable: results.filter((result) => result.unavailable).map((result) => result.agentKey),
  };
}

export const AI_DRAFT_WORK_ENDPOINTS = Object.freeze({ ...FIXED_ENDPOINTS });
