import type { CommandContext } from './index.js';
export const CURRICULUM_REQUIREMENT_KINDS = ['TECHNIQUE','KNOWLEDGE','CHARACTER','ATTENDANCE','PRACTICE','INSTRUCTOR_JUDGMENT','CUSTOM'] as const;
export type CurriculumRequirementKind = (typeof CURRICULUM_REQUIREMENT_KINDS)[number];
export const CURRICULUM_PROGRESS_STATUSES = ['NOT_STARTED','PRACTICING','DEMONSTRATED','MET','NOT_MET'] as const;
export type CurriculumProgressStatus = (typeof CURRICULUM_PROGRESS_STATUSES)[number];
/** Actor/tenant/source are server derived. Never accepted in a command body. */
export interface CurriculumProgressContext extends CommandContext { externalSubject: string }
export interface CreateCurriculumRequirementInput {
 code: string; kind: CurriculumRequirementKind; definition: { label: string; description?: string }; required: boolean;
}
export interface UpdateCurriculumRequirementInput extends CreateCurriculumRequirementInput { expectedVersion: number }
export interface CurriculumRequirementSummary extends CreateCurriculumRequirementInput { id: string; rankId: string; version: number }
/** Explicit placement is not a promotion; null is a deliberate unranked placement. */
export interface EnrollStudentCurriculumInput { studentProfileId: string; currentRankId: string | null }
export interface SetStudentCurriculumRankInput { currentRankId: string | null; expectedEnrollmentVersion: number }
export interface StudentCurriculumEnrollmentSummary extends EnrollStudentCurriculumInput {
 id: string; curriculumId: string; version: number; status: 'ACTIVE'|'SUSPENDED'|'ARCHIVED'; enrolledAt: string;
}
export interface RecordCurriculumProgressInput {
 requirementId: string; expectedRequirementVersion: number; expectedEnrollmentVersion: number;
 /** 0 only for a requirement with no observation history; revisions do not reset this sequence. */
 expectedProgressVersion: number; status: CurriculumProgressStatus; instructorNote?: string;
}
export interface CurriculumProgressObservationSummary {
 id: string; enrollmentId: string; requirementId: string; requirementVersion: number; enrollmentVersion: number;
 status: CurriculumProgressStatus; version: number; recordedAt: string;
}
/** Whitelist projection: no definition description, instructor, notes or evidence. */
export interface ParentCurriculumRequirementProgress {
 enrollmentId: string; requirementId: string; label: string; kind: CurriculumRequirementKind; required: boolean;
 /** null is unrecorded for the current requirement/enrollment revision, not an inferred status. */
 status: CurriculumProgressStatus | null; recordedAt: string | null;
}
export interface CurriculumCommandResult<T> { record: T; replayed: boolean }

/** Latest historical sequence is retained even when a revision invalidates status. */
export interface StaffCurriculumRequirementProgress extends CurriculumRequirementSummary {
 progressVersion: number; status: CurriculumProgressStatus | null; recordedAt: string | null;
}
export interface StaffCurriculumEnrollmentDetails {
 enrollment: StudentCurriculumEnrollmentSummary; requirements: StaffCurriculumRequirementProgress[];
}
export interface CurriculumApiResponse<T> {
 data: T; meta: { requestId: string; correlationId: string; replayed: boolean };
}
