import { communityUuid, validateTeachingAssessment, validateTeachingLesson, validateTeachingResource, verifyTeachingAccess, verifyTeachingAssessment, verifyTeachingHistory, verifyTeachingLesson, verifyTeachingPage, verifyTeachingResource, type TeachingAssessment, type TeachingAssessmentInput, type TeachingLesson, type TeachingLessonInput, type TeachingResource, type TeachingResourceInput, type TeachingStudioAccess, type TeachingStudioHistory, type TeachingStudioPage } from '@hon/contracts';

const base = '/api/v1/staff/teaching-studio';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export class TeachingStudioUiError extends Error { constructor(message: string, readonly status: number) { super(message); } }
function id(value: unknown): asserts value is string { try { communityUuid(value); } catch { throw new Error('Use an already-known school, student, plan, resource, or assessment UUID.'); } }
function schoolQuery(school: string) { id(school); return `schoolId=${encodeURIComponent(school)}`; }
function endpoint(path: string) {
  const parsed = new URL(path, 'http://hon.invalid');
  if (!path.startsWith(`${base}/`) || parsed.origin !== 'http://hon.invalid' || parsed.hash) throw new Error('Only fixed same-origin Teaching Studio endpoints are allowed.');
  return path;
}
async function request<T>(path: string, verify: (value: unknown) => T, body?: unknown, key?: string): Promise<T> {
  endpoint(path); if (body !== undefined && !key) throw new Error('A retained idempotency key is required for human Teaching Studio changes.');
  const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', referrerPolicy: 'no-referrer', headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'X-HON-Human-Command': 'teaching-studio', 'Idempotency-Key': key! }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!response.ok) throw new TeachingStudioUiError(response.status === 401 ? 'Sign in with a verified human staff session.' : response.status === 403 ? 'Current exact school permission or active entitlement is unavailable.' : response.status === 409 ? 'A version or retry conflict occurred. Refresh before changing the record.' : 'No verified result. Check the bounded fields and retry only the unchanged saved request.', response.status);
  const envelope = await response.json() as { data?: unknown }; return verify(envelope.data);
}
export const teachingStudioPath = {
  access: (school: string) => `${base}/access?${schoolQuery(school)}`,
  lessons: (school: string) => `${base}/lessons?${schoolQuery(school)}`,
  lessonHistory: (school: string, lesson: string, before?: number) => { id(lesson); return `${base}/lessons/${lesson}/history?${schoolQuery(school)}${before ? `&before=${before}` : ''}`; },
  resources: (school: string) => `${base}/resources?${schoolQuery(school)}`,
  resourceHistory: (school: string, resource: string, before?: number) => { id(resource); return `${base}/resources/${resource}/history?${schoolQuery(school)}${before ? `&before=${before}` : ''}`; },
  assessments: (school: string, student: string) => { id(student); return `${base}/students/${student}/assessments?${schoolQuery(school)}`; },
  assessmentHistory: (school: string, student: string, assessment: string, before?: number) => { id(student); id(assessment); return `${base}/students/${student}/assessments/${assessment}/history?${schoolQuery(school)}${before ? `&before=${before}` : ''}`; },
};
export function loadTeachingAccess(school: string): Promise<TeachingStudioAccess> { return request(teachingStudioPath.access(school), verifyTeachingAccess); }
export function loadTeachingLessons(school: string): Promise<TeachingStudioPage<TeachingLesson>> { return request(teachingStudioPath.lessons(school), value => verifyTeachingPage(value, verifyTeachingLesson)); }
export function loadTeachingResources(school: string): Promise<TeachingStudioPage<TeachingResource>> { return request(teachingStudioPath.resources(school), value => verifyTeachingPage(value, verifyTeachingResource)); }
export function loadTeachingAssessments(school: string, student: string): Promise<TeachingStudioPage<TeachingAssessment>> { return request(teachingStudioPath.assessments(school, student), value => { const page = verifyTeachingPage(value, verifyTeachingAssessment); if (page.items.some(item => item.studentProfileId !== student)) throw new Error('Unverified student scope'); return page; }); }
export function loadTeachingHistory(kind: 'LESSON' | 'RESOURCE' | 'ASSESSMENT', school: string, idValue: string, student: string | null = null, before?: number): Promise<TeachingStudioHistory<TeachingLesson | TeachingResource | TeachingAssessment>> {
  if ((kind === 'ASSESSMENT') !== (student !== null)) throw new Error('A known student selector is required only for assessment history.');
  if (kind === 'LESSON') return request(teachingStudioPath.lessonHistory(school, idValue, before), value => verifyTeachingHistory(value, verifyTeachingLesson));
  if (kind === 'RESOURCE') return request(teachingStudioPath.resourceHistory(school, idValue, before), value => verifyTeachingHistory(value, verifyTeachingResource));
  return request(teachingStudioPath.assessmentHistory(school, student!, idValue, before), value => verifyTeachingHistory(value, verifyTeachingAssessment));
}
export type TeachingMutation =
 | { op: 'LESSON'; id: string | null; input: TeachingLessonInput }
 | { op: 'RESOURCE'; id: string | null; input: TeachingResourceInput }
 | { op: 'ASSESSMENT'; id: string | null; student: string; input: TeachingAssessmentInput };
export function teachingFingerprint(mutation: TeachingMutation) { return JSON.stringify(mutation); }
export async function saveTeaching(school: string, mutation: TeachingMutation, key: string): Promise<TeachingLesson | TeachingResource | TeachingAssessment> {
  id(school); if (!key || key.trim() !== key) throw new Error('A retained retry key is required.');
  let path: string; let verify: (value: unknown) => TeachingLesson | TeachingResource | TeachingAssessment;
  if (mutation.op === 'LESSON') { validateTeachingLesson(mutation.input); if (mutation.id !== null) id(mutation.id); path = `${base}/lessons${mutation.id ? `/${mutation.id}/revisions` : ''}?${schoolQuery(school)}`; verify = verifyTeachingLesson; }
  else if (mutation.op === 'RESOURCE') { validateTeachingResource(mutation.input); if (mutation.id !== null) id(mutation.id); path = `${base}/resources${mutation.id ? `/${mutation.id}/revisions` : ''}?${schoolQuery(school)}`; verify = verifyTeachingResource; }
  else { validateTeachingAssessment(mutation.input); id(mutation.student); if (mutation.id !== null) id(mutation.id); path = `${base}/students/${mutation.student}/assessments${mutation.id ? `/${mutation.id}/revisions` : ''}?${schoolQuery(school)}`; verify = verifyTeachingAssessment; }
  const saved = await request(path, verify, mutation.input, key);
  if (saved.version !== mutation.input.expectedVersion + 1 || (mutation.id !== null && saved.id !== mutation.id) || (mutation.op === 'ASSESSMENT' && (!('studentProfileId' in saved) || saved.studentProfileId !== mutation.student))) throw new Error('Unverified Teaching Studio save binding.');
  return saved;
}
