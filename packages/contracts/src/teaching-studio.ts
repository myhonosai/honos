import { communityUuid, communityVersion } from './community.js';

export const TEACHING_STUDIO_PERMISSIONS = ['teaching.studio.read', 'teaching.lesson.manage', 'teaching.resource.manage', 'teaching.assessment.record'] as const;
export const TEACHING_RESOURCE_TYPES = ['DRILL', 'HANDOUT', 'EQUIPMENT', 'SAFETY_GUIDE', 'REFERENCE'] as const;
export const TEACHING_ASSESSED_SKILL_STATUSES = ['OBSERVED', 'NEEDS_PRACTICE', 'NOT_OBSERVED'] as const;
export type TeachingStudioPermission = typeof TEACHING_STUDIO_PERMISSIONS[number];
export type TeachingResourceType = typeof TEACHING_RESOURCE_TYPES[number];
export type TeachingAssessedSkillStatus = typeof TEACHING_ASSESSED_SKILL_STATUSES[number];
export const TEACHING_STUDIO_HELP = 'Human-authored instructional planning only. Lesson plans, resource metadata, and instructor assessments do not update student curriculum progress, testing, promotion, rank, attendance, membership, billing, parent access, or Action Engine state. Assessments are private instructional observations, not grades, completion, readiness, test results, or student-facing claims. No AI, automation, provider, attachment, URL, script, or external fetch is used.';

export interface TeachingStudioContext {
  organizationId: string; schoolId: string; principalId: string; externalSubject: string;
  principalType: string; source: string; requestId: string; correlationId: string;
  idempotencyKey?: string; actionRequestId?: string; delegatedByPrincipalId?: string;
}
export interface TeachingLessonSection { heading: string; content: string }
export interface TeachingLessonInput {
  expectedVersion: number; title: string; instructionalObjective: string; sections: TeachingLessonSection[];
  durationMinutes: number; status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED'; targetCurriculumId: string | null; targetRankId: string | null;
}
export interface TeachingLesson extends Omit<TeachingLessonInput, 'expectedVersion'> {
  id: string; version: number; recordedAt: string; humanAuthoredOnly: true;
}
export interface TeachingResourceInput { expectedVersion: number; title: string; resourceType: TeachingResourceType; description: string; status: 'ACTIVE' | 'ARCHIVED' }
export interface TeachingResource extends Omit<TeachingResourceInput, 'expectedVersion'> {
  id: string; version: number; recordedAt: string; metadataOnly: true;
}
export interface TeachingAssessedSkill { skill: string; status: TeachingAssessedSkillStatus }
export interface TeachingAssessmentInput {
  expectedVersion: number; observation: string; assessedSkills: TeachingAssessedSkill[]; instructorNote: string | null;
  assessedOn: string; status: 'RECORDED' | 'VOIDED'; targetCurriculumId: string | null; targetRankId: string | null;
}
export interface TeachingAssessment extends Omit<TeachingAssessmentInput, 'expectedVersion'> {
  id: string; version: number; studentProfileId: string; recordedAt: string; instructionalOnly: true;
}
export interface TeachingStudioAccess { canRead: true; canManageLessons: boolean; canManageResources: boolean; canRecordAssessments: boolean }
export interface TeachingStudioPage<T> { items: T[]; nextAfter: null }
export interface TeachingStudioHistory<T> { id: string; items: T[]; nextBefore: number | null }

const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff<>\[\]{}=`$]|https?:|www\.|\b(?:javascript|eval|function|script|attachment|upload|iframe)\b/i;
const ASSESSMENT_UNSAFE = /\b(?:attendance|present|absent|late|makeup|grade|graded|pass|passed|fail|failed|promotion|promoted|testing result|test result|ready|readiness|complete|completed|automatic|auto)\b/i;
function object(v: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length !== keys.length || keys.some(k => !Object.hasOwn(v, k))) throw new Error('Closed Teaching Studio fields required');
  return v as Record<string, unknown>;
}
export function teachingText(v: unknown, max: number, empty = false, assessment = false): asserts v is string {
  if (typeof v !== 'string' || [...v].length > max || (!empty && !v) || v.trim() !== v || UNSAFE.test(v) || (assessment && ASSESSMENT_UNSAFE.test(v))) throw new Error('Bounded safe human instructional text required');
}
export function teachingDate(v: unknown): asserts v is string {
  if (typeof v !== 'string' || !/^20\d{2}-\d{2}-\d{2}$/.test(v) || !Number.isFinite(Date.parse(`${v}T00:00:00.000Z`)) || new Date(`${v}T00:00:00.000Z`).toISOString().slice(0, 10) !== v) throw new Error('Canonical assessment date required');
}
function references(curriculum: unknown, rank: unknown) {
  if ((curriculum === null) !== (rank === null)) throw new Error('Curriculum and rank references are paired when known');
  if (curriculum !== null) { communityUuid(curriculum); communityUuid(rank); }
}
export function validateTeachingLesson(v: unknown): asserts v is TeachingLessonInput {
  const r = object(v, ['expectedVersion', 'title', 'instructionalObjective', 'sections', 'durationMinutes', 'status', 'targetCurriculumId', 'targetRankId']);
  communityVersion(r.expectedVersion, 0); if (Number(r.expectedVersion) > 999999997) throw new Error('Version limit');
  teachingText(r.title, 140); teachingText(r.instructionalObjective, 700); references(r.targetCurriculumId, r.targetRankId);
  if (!Array.isArray(r.sections) || r.sections.length < 1 || r.sections.length > 12 || !Number.isSafeInteger(r.durationMinutes) || Number(r.durationMinutes) < 5 || Number(r.durationMinutes) > 480 || !['DRAFT', 'PUBLISHED', 'ARCHIVED'].includes(String(r.status))) throw new Error('Bounded plan required');
  r.sections.forEach(section => { const s = object(section, ['heading', 'content']); teachingText(s.heading, 120); teachingText(s.content, 1200); });
}
export function validateTeachingResource(v: unknown): asserts v is TeachingResourceInput {
  const r = object(v, ['expectedVersion', 'title', 'resourceType', 'description', 'status']); communityVersion(r.expectedVersion, 0); if (Number(r.expectedVersion) > 999999997) throw new Error('Version limit');
  teachingText(r.title, 140); teachingText(r.description, 900, true);
  if (!(TEACHING_RESOURCE_TYPES as readonly unknown[]).includes(r.resourceType) || !['ACTIVE', 'ARCHIVED'].includes(String(r.status))) throw new Error('Bounded metadata required');
}
export function validateTeachingAssessment(v: unknown): asserts v is TeachingAssessmentInput {
  const r = object(v, ['expectedVersion', 'observation', 'assessedSkills', 'instructorNote', 'assessedOn', 'status', 'targetCurriculumId', 'targetRankId']); communityVersion(r.expectedVersion, 0); if (Number(r.expectedVersion) > 999999997) throw new Error('Version limit');
  teachingText(r.observation, 700, false, true); if (r.instructorNote !== null) teachingText(r.instructorNote, 1000, true, true); teachingDate(r.assessedOn); references(r.targetCurriculumId, r.targetRankId);
  if (!Array.isArray(r.assessedSkills) || r.assessedSkills.length > 20 || !['RECORDED', 'VOIDED'].includes(String(r.status)) || (r.expectedVersion === 0 && r.status !== 'RECORDED')) throw new Error('Explicit instructional assessment required');
  r.assessedSkills.forEach(item => { const s = object(item, ['skill', 'status']); teachingText(s.skill, 120, false, true); if (!(TEACHING_ASSESSED_SKILL_STATUSES as readonly unknown[]).includes(s.status)) throw new Error('Closed assessed skill status required'); });
}
function timestamp(v: unknown): asserts v is string { if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(v) || !Number.isFinite(Date.parse(v))) throw new Error('Human timestamp required'); }
export function verifyTeachingLesson(v: unknown): TeachingLesson {
  const r = object(v, ['id','version','title','instructionalObjective','sections','durationMinutes','status','targetCurriculumId','targetRankId','recordedAt','humanAuthoredOnly']);
  communityUuid(r.id); communityVersion(r.version, 1); timestamp(r.recordedAt); if (r.humanAuthoredOnly !== true) throw new Error('Human-only plan required');
  const { id: ignored, version, recordedAt, humanAuthoredOnly, ...input } = r; void ignored; void recordedAt; void humanAuthoredOnly; validateTeachingLesson({ expectedVersion: Number(version) - 1, ...input }); return v as TeachingLesson;
}
export function verifyTeachingResource(v: unknown): TeachingResource {
  const r = object(v, ['id','version','title','resourceType','description','status','recordedAt','metadataOnly']);
  communityUuid(r.id); communityVersion(r.version, 1); timestamp(r.recordedAt); if (r.metadataOnly !== true) throw new Error('Metadata-only resource required');
  const { id: ignored, version, recordedAt, metadataOnly, ...input } = r; void ignored; void recordedAt; void metadataOnly; validateTeachingResource({ expectedVersion: Number(version) - 1, ...input }); return v as TeachingResource;
}
export function verifyTeachingAssessment(v: unknown): TeachingAssessment {
  const r = object(v, ['id','version','studentProfileId','observation','assessedSkills','instructorNote','assessedOn','status','targetCurriculumId','targetRankId','recordedAt','instructionalOnly']);
  communityUuid(r.id); communityUuid(r.studentProfileId); communityVersion(r.version, 1); timestamp(r.recordedAt); if (r.instructionalOnly !== true) throw new Error('Instructional-only assessment required');
  const { id: ignored, version, studentProfileId: student, recordedAt, instructionalOnly, ...input } = r; void ignored; void student; void recordedAt; void instructionalOnly; validateTeachingAssessment({ expectedVersion: Number(version) - 1, ...input }); return v as TeachingAssessment;
}
export function verifyTeachingAccess(v: unknown): TeachingStudioAccess { const r = object(v, ['canRead','canManageLessons','canManageResources','canRecordAssessments']); if (r.canRead !== true || [r.canManageLessons,r.canManageResources,r.canRecordAssessments].some(x => typeof x !== 'boolean')) throw new Error('Verified Teaching Studio access required'); return v as TeachingStudioAccess; }
export function verifyTeachingPage<T>(v: unknown, verify: (item: unknown) => T): TeachingStudioPage<T> { const r = object(v, ['items','nextAfter']); if (!Array.isArray(r.items) || r.items.length > 30 || r.nextAfter !== null) throw new Error('Bounded Teaching Studio page required'); return { items: r.items.map(verify), nextAfter: null }; }
export function verifyTeachingHistory<T extends { id: string; version: number }>(v: unknown, verify: (item: unknown) => T): TeachingStudioHistory<T> { const r = object(v, ['id','items','nextBefore']); communityUuid(r.id); if (!Array.isArray(r.items) || r.items.length > 30 || (r.nextBefore !== null && (!Number.isSafeInteger(r.nextBefore) || Number(r.nextBefore) < 1))) throw new Error('Bounded Teaching Studio history required'); const items=r.items.map(verify); if (items.some((x,i)=>x.id!==r.id || (i>0 && x.version>=items[i-1]!.version)) || (r.nextBefore!==null && (items.length!==30 || r.nextBefore!==items.at(-1)?.version))) throw new Error('Invalid Teaching Studio revision history'); return { id:r.id as string, items, nextBefore:r.nextBefore as number|null }; }
