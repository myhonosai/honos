import { SIGNUP_HUMAN_COMMAND, TRIAL_HUMAN_COMMAND } from '@hon/contracts';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';

/** A closed refusal from the account API: HTTP status and its stable code only (never server text). */
export class StartError extends Error { constructor(readonly status: number, readonly code: string) { super(code); } }

export type StartCommand = Readonly<{ path: 'account/sign-up' | 'account/trial'; body: Readonly<Record<string, unknown>>; key: string }>;
const COMMANDS = { 'account/sign-up': SIGNUP_HUMAN_COMMAND, 'account/trial': TRIAL_HUMAN_COMMAND } as const;

/** Same-origin JSON call to the HON API proxy. A command always sends its own human-command header and idempotency key. */
export async function startRequest(path: StartCommand['path'], signal: AbortSignal, command?: StartCommand): Promise<unknown> {
  const response = await fetch('/api/v1/' + path, {
    method: command ? 'POST' : 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
    signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
    headers: { Accept: 'application/json', ...(command ? { 'Content-Type': 'application/json', 'X-HON-Human-Command': COMMANDS[command.path], 'Idempotency-Key': command.key } : {}) },
    ...(command ? { body: JSON.stringify(command.body) } : {}),
  });
  if (response.status === 401) reportConfirmedSessionInvalidation();
  const root: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code = root && typeof root === 'object' && 'code' in root && typeof root.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(root.code) ? root.code : 'ACCOUNT_UNAVAILABLE';
    throw new StartError(response.status, code);
  }
  if (!root || typeof root !== 'object' || Array.isArray(root) || Object.keys(root).length !== 1 || !Object.hasOwn(root, 'data')) throw new StartError(503, 'ACCOUNT_RESPONSE_INVALID');
  return (root as { data: unknown }).data;
}
