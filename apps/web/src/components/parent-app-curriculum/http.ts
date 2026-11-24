import { PARENT_APP_CURRICULUM_COMMAND, isCurriculumLibraryId, verifyCurriculumAppChild, verifyCurriculumAppState, verifyCurriculumResourceRecord, verifyStaffParentAppCurriculum,
  type CurriculumAppChild, type CurriculumAppSettingsInput, type CurriculumAppState, type CurriculumResourceArchiveInput, type CurriculumResourceCreateInput,
  type CurriculumResourceRecord, type CurriculumResourceUpdateInput, type StaffParentAppCurriculum } from '@hon/contracts';

/**
 * Staff Parent app > Curriculum calls (docs/architecture/PARENT_APP_CURRICULUM.md section 7). Same-origin only; the school in the
 * path is the shell's verified school and the API re-checks curriculum.manage under locks on every read and command.
 */
export class ParentAppCurriculumRefusal extends Error { constructor(message: string, readonly code: string, readonly status: number) { super(message); } }

const MESSAGES: Record<string, string> = {
  VERSION_CONFLICT: 'Someone else changed this a moment ago. Refresh to see the latest, then try again.',
  CYCLE_IS_CURRENT: 'This is the cycle families see now. Switch to another cycle first, then archive it.',
  SETTINGS_REQUIRED: 'Save the setup for this curriculum first, then switch the cycle.',
  CYCLE_NAME_TAKEN: 'Another cycle in this curriculum already has that name.',
  CYCLE_LIMIT: 'A curriculum can have up to 100 active cycles.',
  VALIDATION_FAILED: 'Check the fields and try again.',
  IDEMPOTENCY_KEY_REUSED: 'This change could not be matched to the earlier try. Refresh and make it again.',
};
const UNKNOWN = 'The change could not be confirmed. It may or may not have been saved. Refresh to check before trying again.';
function invalid(): never { throw new Error('The curriculum response could not be verified. Refresh to try again.'); }

async function call(url: string, body?: object, command?: string, key?: string, signal?: AbortSignal): Promise<{ data: unknown; replayed: boolean }> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body) { headers['Content-Type'] = 'application/json'; headers['X-Hon-Human-Command'] = command!; headers['Idempotency-Key'] = key ?? ''; }
  const response = await fetch(url, { method: body ? 'POST' : 'GET', credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store',
    referrerPolicy: 'no-referrer', signal: signal ?? null, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  const json = /^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '');
  const value: unknown = json ? await response.json().catch(() => null) : null;
  const root = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  if (!response.ok) {
    if (response.status === 401) throw new ParentAppCurriculumRefusal('Your session has ended. Sign in again.', 'UNAUTHENTICATED', 401);
    if (response.status === 403) throw new ParentAppCurriculumRefusal('Your access does not include managing curriculum at this school.', 'FORBIDDEN', 403);
    if (response.status === 404) throw new ParentAppCurriculumRefusal('That item is no longer here. Refresh to see the latest.', 'NOT_FOUND', 404);
    const code = String(root?.code ?? '');
    if (MESSAGES[code]) throw new ParentAppCurriculumRefusal(MESSAGES[code]!, code, response.status);
    if (response.status === 409) throw new ParentAppCurriculumRefusal(MESSAGES.VERSION_CONFLICT!, 'VERSION_CONFLICT', 409);
    if (response.status === 400) throw new ParentAppCurriculumRefusal(MESSAGES.VALIDATION_FAILED!, 'VALIDATION_FAILED', 400);
    throw new Error(body ? UNKNOWN : 'Curriculum is unavailable right now. Refresh to try again.');
  }
  if (!root || !Object.hasOwn(root, 'data') || !root.meta || typeof root.meta !== 'object') invalid();
  const meta = root.meta as Record<string, unknown>;
  if (!isCurriculumLibraryId(meta.requestId) || meta.requestId !== meta.correlationId || typeof meta.replayed !== 'boolean') invalid();
  return { data: root.data, replayed: meta.replayed };
}

function base(school: string): string { if (!isCurriculumLibraryId(school)) invalid(); return `/api/v1/staff/schools/${school.toLowerCase()}`; }
function id(value: string): string { if (!isCurriculumLibraryId(value)) invalid(); return value.toLowerCase(); }
const app = (school: string) => `${base(school)}/parent-app/curriculum`;
const library = (school: string) => `${base(school)}/curriculum-library`;
const command = (school: string, path: string, body: object, key: string) => call(`${app(school)}/${path}`, body, PARENT_APP_CURRICULUM_COMMAND, key)
  .then((r) => verifyCurriculumAppState(r.data));

export const parentAppCurriculumApi = {
  async read(school: string, signal?: AbortSignal): Promise<StaffParentAppCurriculum> { return verifyStaffParentAppCurriculum((await call(app(school), undefined, undefined, undefined, signal)).data); },
  async preview(school: string, student: string, signal?: AbortSignal): Promise<CurriculumAppChild> { return verifyCurriculumAppChild((await call(`${app(school)}/preview/${id(student)}`, undefined, undefined, undefined, signal)).data); },
  async saveSettings(school: string, curriculum: string, input: CurriculumAppSettingsInput, key: string): Promise<CurriculumAppState> { return command(school, `${id(curriculum)}/settings`, input, key); },
  async createCycle(school: string, curriculum: string, name: string, key: string): Promise<CurriculumAppState> { return command(school, `${id(curriculum)}/cycles`, { name }, key); },
  async renameCycle(school: string, curriculum: string, cycle: string, expectedVersion: number, name: string, key: string): Promise<CurriculumAppState> { return command(school, `${id(curriculum)}/cycles/${id(cycle)}/versions`, { expectedVersion, name }, key); },
  async archiveCycle(school: string, curriculum: string, cycle: string, expectedVersion: number, key: string): Promise<CurriculumAppState> { return command(school, `${id(curriculum)}/cycles/${id(cycle)}/archive`, { expectedVersion }, key); },
  /** expectedVersion is the curriculum's settings version: switching rewrites the settings row. */
  async switchCycle(school: string, curriculum: string, cycle: string, expectedVersion: number, key: string): Promise<CurriculumAppState> { return command(school, `${id(curriculum)}/cycles/${id(cycle)}/switch`, { expectedVersion }, key); },
  async orderCycles(school: string, curriculum: string, cycleIds: string[], key: string): Promise<CurriculumAppState> { return command(school, `${id(curriculum)}/cycle-order`, { cycleIds: cycleIds.map(id) }, key); },
  async addMaterial(school: string, input: CurriculumResourceCreateInput, key: string): Promise<CurriculumResourceRecord> { return verifyCurriculumResourceRecord((await call(library(school), input, 'curriculum-library', key)).data); },
  async editMaterial(school: string, resource: string, input: CurriculumResourceUpdateInput, key: string): Promise<CurriculumResourceRecord> { return verifyCurriculumResourceRecord((await call(`${library(school)}/${id(resource)}/versions`, input, 'curriculum-library', key)).data); },
  async archiveMaterial(school: string, resource: string, input: CurriculumResourceArchiveInput, key: string): Promise<CurriculumResourceRecord> { return verifyCurriculumResourceRecord((await call(`${library(school)}/${id(resource)}/archive`, input, 'curriculum-library', key)).data); },
};
