import { RANK_SETUP_COMMAND, isRankSetupId, verifyRankSetupProgram, verifyStaffRankSetup, type RankRequirementKind, type RankSetupProgram, type StaffRankSetup } from '@hon/contracts';

/**
 * Rank setup calls (docs/architecture/RANK_SETUP_AND_PLAIN_CURRICULUM_PAGES.md section 4). Same-origin only; the school in the path is
 * the shell's verified school. Programs and belts go to the 0622 rank setup API; requirements and placing a student on a belt go to the
 * existing 0070 curriculum progress commands. The server re-checks permission and the school's subscription on every call.
 */
export class RankSetupRefusal extends Error { constructor(message: string, readonly code: string, readonly status: number) { super(message); } }

const MESSAGES: Record<string, string> = {
  VERSION_CONFLICT: 'Someone else changed this a moment ago. Refresh to see the latest, then try again.',
  PROGRAM_NAME_TAKEN: 'Your school already has a program with that name.',
  RANK_NAME_TAKEN: 'This program already has a belt with that name.',
  RANK_AT_END: 'That belt is already at the end of the list.',
  PROGRAM_LIMIT: 'A school can have up to 100 programs.',
  RANK_LIMIT: 'A program can have up to 60 belts.',
  VALIDATION_FAILED: 'Check the fields and try again. Names can be up to 120 characters, without < or >.',
  IDEMPOTENCY_KEY_REUSED: 'This change could not be matched to the earlier try. Refresh and make it again.',
  CURRICULUM_DUPLICATE_OR_KEY_REUSED: 'This student is already in that program, or this change was already made. Refresh to check.',
  INACTIVE_ENROLLMENT: 'This student is no longer active in the program.',
};
const UNKNOWN = 'The change could not be confirmed. It may or may not have been saved. Refresh to check before trying again.';
function invalid(): never { throw new Error('The rank setup response could not be verified. Refresh to try again.'); }

async function call(url: string, body?: object, command?: string, key?: string, signal?: AbortSignal): Promise<{ data: unknown; replayed: boolean }> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body) { headers['Content-Type'] = 'application/json'; headers['X-Hon-Human-Command'] = command!; headers['Idempotency-Key'] = key ?? ''; }
  const response = await fetch(url, { method: body ? 'POST' : 'GET', credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store',
    referrerPolicy: 'no-referrer', signal: signal ?? null, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  const json = /^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '');
  const value: unknown = json ? await response.json().catch(() => null) : null;
  const root = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  if (!response.ok) {
    if (response.status === 401) throw new RankSetupRefusal('Your session has ended. Sign in again.', 'UNAUTHENTICATED', 401);
    if (response.status === 403) throw new RankSetupRefusal('Your access does not include setting up ranks at this school.', 'FORBIDDEN', 403);
    if (response.status === 404) throw new RankSetupRefusal('That item is no longer here. Refresh to see the latest.', 'NOT_FOUND', 404);
    const code = String(root?.code ?? '');
    if (MESSAGES[code]) throw new RankSetupRefusal(MESSAGES[code]!, code, response.status);
    if (response.status === 409) throw new RankSetupRefusal(MESSAGES.VERSION_CONFLICT!, 'VERSION_CONFLICT', 409);
    if (response.status === 400) throw new RankSetupRefusal(MESSAGES.VALIDATION_FAILED!, 'VALIDATION_FAILED', 400);
    throw new Error(body ? UNKNOWN : 'Rank setup is unavailable right now. Refresh to try again.');
  }
  if (!root || !Object.hasOwn(root, 'data') || !root.meta || typeof root.meta !== 'object') invalid();
  const meta = root.meta as Record<string, unknown>;
  if (!isRankSetupId(meta.requestId) || meta.requestId !== meta.correlationId || typeof meta.replayed !== 'boolean') invalid();
  return { data: root.data, replayed: meta.replayed };
}

function id(value: string): string { if (!isRankSetupId(value)) invalid(); return value.toLowerCase(); }
const setup = (school: string) => `/api/v1/staff/schools/${id(school)}/rank-setup`;
const progress = (org: string, school: string, program: string) => `/api/v1/organizations/${id(org)}/schools/${id(school)}/curricula/${id(program)}`;
const program = (school: string, path: string, body: object, key: string) => call(`${setup(school)}/${path}`, body, RANK_SETUP_COMMAND, key).then((r) => verifyRankSetupProgram(r.data));
/** The 0070 commands answer with one record; the page reads the whole setup again afterwards, so only an id is checked here. */
const recorded = (url: string, body: object, key: string) => call(url, body, 'curriculum-progress', key).then((r) => {
  const data = r.data as Record<string, unknown> | null;
  if (!data || typeof data !== 'object' || !isRankSetupId(data.id)) invalid();
});

/** A requirement code from its label: FRONT_KICK for "Front kick", REQ_3 when the label has no Latin letters; unique within the belt. */
export function requirementCode(label: string, taken: readonly string[]): string {
  const base = label.normalize('NFKD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 56);
  const start = /^[A-Z]/.test(base) ? base : base ? `R_${base}`.slice(0, 56) : 'REQ';
  const used = new Set(taken);
  if (start !== 'REQ' && !used.has(start)) return start;
  for (let n = 1; n < 1000; n += 1) { const code = `${start}_${n}`; if (!used.has(code)) return code; }
  return `REQ_${Date.now() % 100000000}`;
}

export const rankSetupApi = {
  async read(school: string, signal?: AbortSignal): Promise<StaffRankSetup> { return verifyStaffRankSetup((await call(setup(school), undefined, undefined, undefined, signal)).data); },
  createProgram: (school: string, name: string, key: string): Promise<RankSetupProgram> => program(school, 'programs', { name }, key),
  renameProgram: (school: string, p: string, expectedVersion: number, name: string, key: string): Promise<RankSetupProgram> => program(school, `programs/${id(p)}/versions`, { expectedVersion, name }, key),
  addRank: (school: string, p: string, name: string, color: string | null, key: string): Promise<RankSetupProgram> => program(school, `programs/${id(p)}/ranks`, { name, color }, key),
  updateRank: (school: string, p: string, rank: string, expectedVersion: number, name: string, color: string | null, key: string): Promise<RankSetupProgram> =>
    program(school, `programs/${id(p)}/ranks/${id(rank)}/versions`, { expectedVersion, name, color }, key),
  moveRank: (school: string, p: string, rank: string, expectedVersion: number, direction: 'UP' | 'DOWN', key: string): Promise<RankSetupProgram> =>
    program(school, `programs/${id(p)}/ranks/${id(rank)}/move`, { expectedVersion, direction }, key),
  addRequirement: (org: string, school: string, p: string, rank: string, input: { code: string; kind: RankRequirementKind; label: string; description: string; required: boolean }, key: string) =>
    recorded(`${progress(org, school, p)}/ranks/${id(rank)}/requirements`, { code: input.code, kind: input.kind, required: input.required,
      definition: input.description ? { label: input.label, description: input.description } : { label: input.label } }, key),
  updateRequirement: (org: string, school: string, p: string, requirement: string, input: { code: string; kind: RankRequirementKind; label: string; description: string; required: boolean; expectedVersion: number }, key: string) =>
    recorded(`${progress(org, school, p)}/requirements/${id(requirement)}/versions`, { code: input.code, kind: input.kind, required: input.required, expectedVersion: input.expectedVersion,
      definition: input.description ? { label: input.label, description: input.description } : { label: input.label } }, key),
  placeStudent: (org: string, school: string, p: string, studentProfileId: string, currentRankId: string | null, key: string) =>
    recorded(`${progress(org, school, p)}/enrollments`, { studentProfileId: id(studentProfileId), currentRankId: currentRankId === null ? null : id(currentRankId) }, key),
  setStudentRank: (org: string, school: string, p: string, enrollment: string, currentRankId: string | null, expectedEnrollmentVersion: number, key: string) =>
    recorded(`${progress(org, school, p)}/enrollments/${id(enrollment)}/current-rank`, { currentRankId: currentRankId === null ? null : id(currentRankId), expectedEnrollmentVersion }, key),
};
