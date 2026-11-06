import {
  SAAS_COMMANDS, saasUuid, validateAiSpendPauseInput, validateAiSpendPauseList, validateAiSpendPauseReceipt, validateAiUnknownAgent,
  validateAiUnknownQueue, validateAiUnknownResolutionInput, validateAiUnknownResolutionReceipt,
  type AiSpendPauseInput, type AiSpendPauseList, type AiSpendPauseReceipt, type AiUnknownAgent, type AiUnknownQueue,
  type AiUnknownResolutionInput, type AiUnknownResolutionReceipt,
} from '@hon/contracts';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';

/**
 * HQ AI safety transport (S4-c spend pauses, S4-d unknown-outcome queue). Fixed same-origin paths only; the
 * database decides every authority question: billing readers may read, only a human HQ owner may command.
 * UNKNOWN means the command may or may not have committed: retry only the exact same body and key.
 */
export type AiSafetyFailure = 'SESSION' | 'FORBIDDEN' | 'INVALID' | 'CONFLICT' | 'UNAVAILABLE' | 'UNKNOWN';
export class HqAiSafetyError extends Error {
  constructor(readonly kind: AiSafetyFailure) { super('The HQ AI safety records could not be verified.'); }
}

const READ = { method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' } as const;

function envelope(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, 'data')) throw new Error('drift');
  return (value as { data: unknown }).data;
}

async function read<T>(path: string, validate: (value: unknown) => T, signal: AbortSignal): Promise<T> {
  let response: Response;
  try { response = await fetch(path, { ...READ, headers: { Accept: 'application/json' }, signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) }); }
  catch (error) { if (signal.aborted) throw error; throw new HqAiSafetyError('UNAVAILABLE'); }
  signal.throwIfAborted();
  if (response.status === 401) { reportConfirmedSessionInvalidation(); throw new HqAiSafetyError('SESSION'); }
  if (response.status === 403) throw new HqAiSafetyError('FORBIDDEN');
  if (!response.ok) throw new HqAiSafetyError('UNAVAILABLE');
  try { return validate(envelope(await response.json())); } catch { throw new HqAiSafetyError('UNAVAILABLE'); }
}

/** One prepared command: the exact body and key are frozen so an unknown outcome is retried byte-for-byte. */
export type PreparedCommand = Readonly<{ path: string; command: string; key: string; body: string }>;

export function preparePause(input: AiSpendPauseInput): PreparedCommand {
  let checked: AiSpendPauseInput;
  try { checked = validateAiSpendPauseInput(input); } catch { throw new HqAiSafetyError('INVALID'); }
  return Object.freeze({ path: '/api/v1/hq/ai/spend-pauses', command: SAAS_COMMANDS.aiSpendPause, key: crypto.randomUUID(), body: JSON.stringify(checked) });
}

export function prepareResolution(agent: AiUnknownAgent, invocationId: string, input: AiUnknownResolutionInput): PreparedCommand {
  let path: string, checked: AiUnknownResolutionInput;
  try {
    path = `/api/v1/hq/ai/unknown-invocations/${validateAiUnknownAgent(agent)}/${saasUuid(invocationId)}/resolve`;
    checked = validateAiUnknownResolutionInput(input);
  } catch { throw new HqAiSafetyError('INVALID'); }
  return Object.freeze({ path, command: SAAS_COMMANDS.aiUnknownResolve, key: crypto.randomUUID(), body: JSON.stringify(checked) });
}

async function send<T>(prepared: PreparedCommand, validate: (value: unknown) => T): Promise<T> {
  let response: Response;
  try {
    response = await fetch(prepared.path, { method: 'POST', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-HON-Human-Command': prepared.command, 'Idempotency-Key': prepared.key },
      body: prepared.body, signal: AbortSignal.timeout(15000) });
  } catch { throw new HqAiSafetyError('UNKNOWN'); }
  if (response.status === 401) { reportConfirmedSessionInvalidation(); throw new HqAiSafetyError('SESSION'); }
  if (response.status === 403) throw new HqAiSafetyError('FORBIDDEN');
  if (response.status === 400) throw new HqAiSafetyError('INVALID');
  if (response.status === 409) throw new HqAiSafetyError('CONFLICT');
  // Any other failure may have committed: the caller keeps the exact request for an explicit retry.
  if (response.status !== 200) throw new HqAiSafetyError('UNKNOWN');
  try { return validate(envelope(await response.json())); } catch { throw new HqAiSafetyError('UNKNOWN'); }
}

export interface HqAiSafetyApi {
  pauses(signal: AbortSignal): Promise<AiSpendPauseList>;
  queue(signal: AbortSignal): Promise<AiUnknownQueue>;
  sendPause(prepared: PreparedCommand): Promise<AiSpendPauseReceipt>;
  sendResolution(prepared: PreparedCommand): Promise<AiUnknownResolutionReceipt>;
}

export const HQ_AI_SAFETY_API: HqAiSafetyApi = {
  pauses: signal => read('/api/v1/hq/ai/spend-pauses', validateAiSpendPauseList, signal),
  queue: signal => read('/api/v1/hq/ai/unknown-invocations', validateAiUnknownQueue, signal),
  sendPause: prepared => send(prepared, validateAiSpendPauseReceipt),
  sendResolution: prepared => send(prepared, validateAiUnknownResolutionReceipt),
};
