import {
  validateSelectParentFamilyInput, verifyParentFamilyChoices, verifyParentFamilySelection,
  type ParentFamilyChoices, type SelectParentFamilyInput,
} from '@hon/contracts';

/** 0456 parent family picker: same-origin browser calls only; the body names one of the families the server listed. */
export class ParentFamilyPickerAccessError extends Error { constructor(message: string, readonly status: number) { super(message); } }
function invalid(): never { throw new Error('The family list could not be checked. Nothing was changed. Refresh to try again.'); }

async function call(method: 'GET' | 'POST', path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(`/api/v1/parent/families${path}`, {
    method, credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer',
    headers: method === 'POST' ? { Accept: 'application/json', 'Content-Type': 'application/json', 'X-HON-Human-Command': 'parent.family.select' } : { Accept: 'application/json' },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
    signal: signal ?? null,
  });
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) invalid();
  const value: unknown = await response.json().catch(() => invalid());
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const root = value as Record<string, unknown>;
  if (!response.ok) {
    if (response.status === 401) throw new ParentFamilyPickerAccessError('Your session has ended. Sign in again.', 401);
    if (response.status === 404) throw new Error('That family is not linked to your account any more. Refresh to see your families.');
    if (response.status === 403) throw new ParentFamilyPickerAccessError('Family access is not available on this account right now.', 403);
    throw new Error('Your family list is unavailable right now. Nothing was changed. Refresh and try again.');
  }
  if (Object.keys(root).length !== 1 || !Object.hasOwn(root, 'data')) invalid();
  return root.data;
}

export async function loadParentFamilyChoices(signal?: AbortSignal): Promise<ParentFamilyChoices> {
  const data = await call('GET', '', undefined, signal);
  try { return verifyParentFamilyChoices(data); } catch { invalid(); }
}

export async function chooseParentFamily(input: SelectParentFamilyInput): Promise<ParentFamilyChoices> {
  const body = validateSelectParentFamilyInput(input);
  const data = await call('POST', '/current', body);
  try { return verifyParentFamilySelection(data, body); } catch { invalid(); }
}
