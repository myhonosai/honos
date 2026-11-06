import type { CommandContext } from './index.js';

export const STAFF_ROLE_ACTION_CODES = ['iam.custom_role.create', 'iam.custom_role.update', 'iam.staff_role.grant', 'iam.staff_role.revoke'] as const;
export type StaffRoleActionCode = (typeof STAFF_ROLE_ACTION_CODES)[number];
export const STAFF_ROLE_MANAGE_PERMISSION = 'iam.staff_role.manage' as const;
/** externalSubject comes from the verified session, NEVER a request body. */
export interface StaffRoleCommandContext extends CommandContext { externalSubject: string }
export interface CreateCustomRoleInput { code: string; name: string; permissionCodes: string[] }
export interface UpdateCustomRoleInput { name: string; permissionCodes: string[]; expectedVersion: number }
/** Both known identifiers must match one registered active human; no contacts. */
export interface GrantStaffRoleInput {
  roleId: string;
  targetPrincipalId: string;
  targetExternalSubject: string;
  /** Optional end within 90 days; starts immediately. */
  effectiveUntil?: string | undefined;
}
export interface RevokeStaffRoleInput { expectedVersion: number }
export interface CustomRoleSummary { id: string; code: string; name: string; schoolId: string | null; permissionCodes: string[]; version: number }
export interface StaffRoleGrantSummary {
  id: string; roleId: string; principalId: string; schoolId: string; version: number;
  effectiveFrom: string; effectiveUntil: string | null; revokedAt: string | null;
}
export interface StaffRoleMutationResult<T = CustomRoleSummary | StaffRoleGrantSummary> { record: T; replayed: boolean }

/**
 * Reviewed "Teaching staff" role preset (owner blueprint 2026-11-06): instructors and teaching-only staff use Kai, the
 * Teaching & Curriculum assistant, plus the teaching studio and class schedule, with no CRM, people/family, billing,
 * revenue, reporting, marketing or approval permission. It is a bundle the owner may create as a custom role through
 * the existing staff-role commands (custom role codes must match CUSTOM_[A-Z][A-Z0-9_]{1,47}); it grants nothing by itself. AI-0 INV-27 creates it through StaffRoleService and grants it to a separate staff member.
 */
export const TEACHING_STAFF_ROLE_PRESET = {
  code: 'CUSTOM_TEACHING_STAFF',
  name: 'Teaching staff',
  permissionCodes: ['ai.invocation.plan', 'schedule.session.read', 'school.view', 'teaching.assistant.use', 'teaching.studio.read'],
} as const satisfies CreateCustomRoleInput;
/** Permissions the teaching-staff preset must never contain. */
export const TEACHING_STAFF_ROLE_EXCLUDED_PREFIXES = ['crm.', 'people.', 'family.', 'billing.', 'reporting.', 'marketing.', 'action.approve', 'iam.', 'communication.', 'student.enroll'] as const;
