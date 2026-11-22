/**
 * Rank setup (0622). Spec: docs/architecture/RANK_SETUP_AND_PLAIN_CURRICULUM_PAGES.md.
 * A school's programs (curricula) and their belt ladders. Strict, closed verifiers only.
 */
export const RANK_SETUP_COMMAND = 'rank-setup';
export type RankSetupOperation = 'PROGRAM_CREATE' | 'PROGRAM_SETUP' | 'PROGRAM_RENAME' | 'RANK_ADD' | 'RANK_UPDATE' | 'RANK_MOVE' | 'RANK_REMOVE';
export const RANK_REQUIREMENT_KINDS = ['TECHNIQUE', 'KNOWLEDGE', 'CHARACTER', 'ATTENDANCE', 'PRACTICE', 'INSTRUCTOR_JUDGMENT', 'CUSTOM'] as const;
export type RankRequirementKind = (typeof RANK_REQUIREMENT_KINDS)[number];
export const RANK_SETUP_LIMITS = { programs: 100, ranks: 60, requirements: 100, students: 1000, name: 120, classes: 2000, days: 3650 } as const;

export interface RankSetupRequirement { id: string; code: string; kind: RankRequirementKind; label: string; description: string; required: boolean; version: number }
export interface RankSetupRank { id: string; name: string; color: string | null; order: number; version: number; classes: number; days: number; students: number; requirements: RankSetupRequirement[] }
export interface RankSetupProgram { id: string; name: string; version: number; ranks: RankSetupRank[] }
export interface RankSetupStudent { enrollmentId: string; programId: string; studentProfileId: string; givenName: string; familyName: string; currentRankId: string | null; version: number }
/** students is null when the signed-in person may set up belts but not record student progress. */
export interface StaffRankSetup { programs: RankSetupProgram[]; students: RankSetupStudent[] | null }

export interface RankSetupProgramInput { name: string }
export interface RankSetupProgramRenameInput { expectedVersion: number; name: string }
/** classes and days are what a student needs at this belt before the next one; 0 means no rule. */
export interface RankSetupRankInput { name: string; color: string | null; classes: number; days: number }
export interface RankSetupQuickInput { name: string; ranks: RankSetupRankInput[] }
export interface RankSetupRankRemoveInput { expectedVersion: number }
export interface RankSetupRankUpdateInput extends RankSetupRankInput { expectedVersion: number }
export interface RankSetupRankMoveInput { expectedVersion: number; direction: 'UP' | 'DOWN' }

function bad(): never { throw new Error('Rank setup response could not be verified.'); }
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isRankSetupId = (v: unknown): v is string => typeof v === 'string' && ID.test(v);
const COLOR = /^#[0-9A-Fa-f]{6}$/;
export const isRankSetupColor = (v: unknown): v is string | null => v === null || (typeof v === 'string' && COLOR.test(v));
/** The same rule the database applies to new names: 1 to 120 characters, trimmed, no control characters or angle brackets. */
export function isValidRankSetupName(v: unknown): v is string {
  return typeof v === 'string' && v.length >= 1 && v.length <= RANK_SETUP_LIMITS.name && v.trim() === v && !/[\u0000-\u001f\u007f-\u009f<>]/.test(v);
}
const int = (v: unknown, min: number, max: number) => Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max;
const version = (v: unknown) => int(v, 1, 999999999);
function closed(v: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).sort().join(',') !== [...keys].sort().join(',')) bad();
  return v as Record<string, unknown>;
}
/** Read-side text: what the database projects (no control characters or angle brackets, bounded). */
function shown(v: unknown, max: number, empty = false): string {
  if (typeof v !== 'string' || v.length > max || (!empty && !v.length) || /[\u0000-\u001f\u007f<>]/.test(v)) bad();
  return v;
}
function unique<T>(items: T[], key: (item: T) => string): T[] { if (new Set(items.map(key)).size !== items.length) bad(); return items; }

export function verifyRankSetupRequirement(v: unknown): RankSetupRequirement {
  const r = closed(v, ['id', 'code', 'kind', 'label', 'description', 'required', 'version']);
  if (!isRankSetupId(r.id) || typeof r.code !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(r.code) || !RANK_REQUIREMENT_KINDS.includes(r.kind as RankRequirementKind)
    || typeof r.required !== 'boolean' || !version(r.version)) bad();
  shown(r.label, 160); shown(r.description, 2000, true);
  return Object.freeze(r as unknown as RankSetupRequirement);
}
export function verifyRankSetupProgram(v: unknown): RankSetupProgram {
  const p = closed(v, ['id', 'name', 'version', 'ranks']);
  if (!isRankSetupId(p.id) || !version(p.version) || !Array.isArray(p.ranks) || p.ranks.length > RANK_SETUP_LIMITS.ranks) bad();
  shown(p.name, 160);
  const ranks = unique(p.ranks.map((x) => {
    const k = closed(x, ['id', 'name', 'color', 'order', 'version', 'classes', 'days', 'students', 'requirements']);
    if (!isRankSetupId(k.id) || !isRankSetupColor(k.color) || !int(k.order, 1, 2147483647) || !version(k.version) || !int(k.students, 0, 10000000) || !int(k.classes, 0, RANK_SETUP_LIMITS.classes) || !int(k.days, 0, RANK_SETUP_LIMITS.days)
      || !Array.isArray(k.requirements) || k.requirements.length > RANK_SETUP_LIMITS.requirements) bad();
    shown(k.name, 160);
    return Object.freeze({ ...k, requirements: unique(k.requirements.map(verifyRankSetupRequirement), (r) => r.id) } as unknown as RankSetupRank);
  }), (k) => k.id);
  for (let i = 1; i < ranks.length; i += 1) if (ranks[i]!.order <= ranks[i - 1]!.order) bad();
  return Object.freeze({ ...p, ranks } as unknown as RankSetupProgram);
}
export function verifyStaffRankSetup(v: unknown): StaffRankSetup {
  const root = closed(v, ['programs', 'students']);
  if (!Array.isArray(root.programs) || root.programs.length > RANK_SETUP_LIMITS.programs) bad();
  const programs = unique(root.programs.map(verifyRankSetupProgram), (p) => p.id);
  let students: RankSetupStudent[] | null = null;
  if (root.students !== null) {
    if (!Array.isArray(root.students) || root.students.length > RANK_SETUP_LIMITS.students) bad();
    const known = new Map(programs.map((p) => [p.id, new Set(p.ranks.map((k) => k.id))]));
    students = unique(root.students.map((x) => {
      const s = closed(x, ['enrollmentId', 'programId', 'studentProfileId', 'givenName', 'familyName', 'currentRankId', 'version']);
      if (!isRankSetupId(s.enrollmentId) || !isRankSetupId(s.programId) || !isRankSetupId(s.studentProfileId) || !version(s.version)
        || (s.currentRankId !== null && !isRankSetupId(s.currentRankId))) bad();
      shown(s.givenName, 120); shown(s.familyName, 120);
      const ranks = known.get(s.programId as string);
      // A student on a belt beyond the 60 shown still lists, so only a missing program is refused.
      if (!ranks) bad();
      return Object.freeze(s as unknown as RankSetupStudent);
    }), (s) => s.enrollmentId);
  }
  return Object.freeze({ programs, students });
}

const belt = (r: Record<string, unknown>) => isValidRankSetupName(r.name) && isRankSetupColor(r.color) && int(r.classes, 0, RANK_SETUP_LIMITS.classes) && int(r.days, 0, RANK_SETUP_LIMITS.days);
/** Closed command bodies; the API and the database check every field again. */
export function isValidRankSetupInput(op: RankSetupOperation, v: unknown): boolean {
  try {
    if (op === 'PROGRAM_CREATE') return isValidRankSetupName(closed(v, ['name']).name);
    if (op === 'PROGRAM_RENAME') { const r = closed(v, ['expectedVersion', 'name']); return version(r.expectedVersion) && isValidRankSetupName(r.name); }
    if (op === 'PROGRAM_SETUP') {
      const r = closed(v, ['name', 'ranks']);
      if (!isValidRankSetupName(r.name) || !Array.isArray(r.ranks) || r.ranks.length < 1 || r.ranks.length > RANK_SETUP_LIMITS.ranks) return false;
      const names = r.ranks.map((x) => { const k = closed(x, ['name', 'color', 'classes', 'days']); if (!belt(k)) bad(); return (k.name as string).toLowerCase(); });
      return new Set(names).size === names.length;
    }
    if (op === 'RANK_ADD') return belt(closed(v, ['name', 'color', 'classes', 'days']));
    if (op === 'RANK_UPDATE') { const r = closed(v, ['expectedVersion', 'name', 'color', 'classes', 'days']); return version(r.expectedVersion) && belt(r); }
    if (op === 'RANK_REMOVE') return version(closed(v, ['expectedVersion']).expectedVersion);
    if (op === 'RANK_MOVE') { const r = closed(v, ['expectedVersion', 'direction']); return version(r.expectedVersion) && (r.direction === 'UP' || r.direction === 'DOWN'); }
  } catch { return false; }
  return false;
}
