import { HON_AGENT_VOICE_CHOICES, HON_VOICE_AGENT_KEYS, type HonAgentVoiceChoice, type HonAgentVoiceChoices, type HonVoiceAgentKey } from '@hon/contracts';

/**
 * 0460: the signed-in person's own voice choice (1-3) for each AI teammate in this school. Presentation only: the
 * server stores a number, the browser maps it to one of its own free voices. Scope must come from the verified
 * school, never from form input.
 */
export type AgentVoiceScope = { organizationId: string; schoolId: string };
export type AgentVoiceApi = {
  load(scope: AgentVoiceScope, signal?: AbortSignal): Promise<HonAgentVoiceChoices>;
  save(scope: AgentVoiceScope, agentKey: HonVoiceAgentKey, voiceChoice: HonAgentVoiceChoice, idempotencyKey: string): Promise<HonAgentVoiceChoices>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export class AgentVoicePreferenceError extends Error { constructor(message: string, readonly status: number) { super(message); } }
const invalid = (): never => { throw new AgentVoicePreferenceError('Voice choices were not verified for this person and school.', 0); };

export const AGENT_VOICE_DEFAULTS: HonAgentVoiceChoices = Object.freeze(
  Object.fromEntries(HON_VOICE_AGENT_KEYS.map((k) => [k, 1])) as HonAgentVoiceChoices);

export function agentVoicePath(scope: AgentVoiceScope): string {
  const org = scope.organizationId.trim().toLowerCase(), school = scope.schoolId.trim().toLowerCase();
  if (!UUID.test(org) || !UUID.test(school)) throw new Error('A verified organization and school are required for voice choices.');
  return `/api/v1/organizations/${org}/schools/${school}/agent-voices`;
}

/** Exactly the nine teammates, each 1, 2 or 3; anything else is refused (nothing is assumed). */
export function verifyAgentVoiceChoices(body: unknown): HonAgentVoiceChoices {
  if (!body || typeof body !== 'object' || Array.isArray(body)) invalid();
  const data = (body as { data?: unknown }).data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) invalid();
  const choices = (data as { choices?: unknown }).choices;
  if (!choices || typeof choices !== 'object' || Array.isArray(choices)) invalid();
  const row = choices as Record<string, unknown>;
  const keys = Object.keys(row);
  if (keys.length !== HON_VOICE_AGENT_KEYS.length || !HON_VOICE_AGENT_KEYS.every((k) => keys.includes(k))) invalid();
  for (const k of HON_VOICE_AGENT_KEYS) if (!(HON_AGENT_VOICE_CHOICES as readonly unknown[]).includes(row[k])) invalid();
  return Object.fromEntries(HON_VOICE_AGENT_KEYS.map((k) => [k, row[k]])) as HonAgentVoiceChoices;
}

async function call(path: string, init: RequestInit): Promise<HonAgentVoiceChoices> {
  const response = await fetch(path, { ...init, credentials: 'same-origin', cache: 'no-store', referrerPolicy: 'no-referrer' });
  if (!response.ok) throw new AgentVoicePreferenceError(`Voice choices unavailable (${response.status}).`, response.status);
  let body: unknown;
  try { body = await response.json(); } catch { return invalid(); }
  return verifyAgentVoiceChoices(body);
}

export const AGENT_VOICE_API: AgentVoiceApi = {
  load: (scope, signal) => call(agentVoicePath(scope), { method: 'GET', headers: { Accept: 'application/json' }, ...(signal ? { signal } : {}) }),
  save: (scope, agentKey, voiceChoice, idempotencyKey) => {
    if (!HON_VOICE_AGENT_KEYS.includes(agentKey) || !HON_AGENT_VOICE_CHOICES.includes(voiceChoice)) throw new Error('Choose voice 1, 2 or 3 for a teammate.');
    if (!UUID.test(idempotencyKey)) throw new Error('A generated retry key is required.');
    return call(agentVoicePath(scope), {
      method: 'PUT', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({ agentKey, voiceChoice }),
    });
  },
};
