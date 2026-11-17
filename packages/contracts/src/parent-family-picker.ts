/**
 * Parent school and family picker (0469): a parent linked to more than one family (two schools, or two households at one
 * school) sees the families they are linked to now and chooses which one every parent page shows. The choice only names
 * one of the parent's live family grants; the database checks it again on every parent read and command.
 */

export const PARENT_FAMILY_ACCESS_LEVELS = ['PRIMARY_GUARDIAN', 'SECONDARY_GUARDIAN', 'VIEWER'] as const;
export type ParentFamilyAccessLevel = (typeof PARENT_FAMILY_ACCESS_LEVELS)[number];
export const PARENT_FAMILY_PICKER_LIMITS = { choices: 20 } as const;

export interface ParentFamilyChoice {
  schoolId: string; schoolName: string; familyId: string; familyName: string; accessLevel: ParentFamilyAccessLevel; current: boolean;
}
export interface ParentFamilyChoices { choices: ParentFamilyChoice[]; needsChoice: boolean }
export interface SelectParentFamilyInput { schoolId: string; familyId: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function invalid(): never { throw new Error('Invalid parent family picker data.'); }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key))) invalid();
  return row;
}
function uuid(value: unknown): string { if (typeof value !== 'string' || !UUID.test(value)) invalid(); return value; }
function name(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 300 || /[\u0000-\u001f\u007f]/.test(value)) invalid();
  return value;
}

export function validateSelectParentFamilyInput(value: unknown): SelectParentFamilyInput {
  const row = record(value, ['schoolId', 'familyId']);
  return { schoolId: uuid(row.schoolId), familyId: uuid(row.familyId) };
}

export function verifyParentFamilyChoices(value: unknown): ParentFamilyChoices {
  const row = record(value, ['choices', 'needsChoice']);
  if (typeof row.needsChoice !== 'boolean' || !Array.isArray(row.choices) || row.choices.length > PARENT_FAMILY_PICKER_LIMITS.choices) invalid();
  const seen = new Set<string>();
  const choices = row.choices.map(item => {
    const c = record(item, ['schoolId', 'schoolName', 'familyId', 'familyName', 'accessLevel', 'current']);
    if (typeof c.current !== 'boolean' || typeof c.accessLevel !== 'string' || !(PARENT_FAMILY_ACCESS_LEVELS as readonly string[]).includes(c.accessLevel)) invalid();
    const out: ParentFamilyChoice = { schoolId: uuid(c.schoolId), schoolName: name(c.schoolName), familyId: uuid(c.familyId), familyName: name(c.familyName),
      accessLevel: c.accessLevel as ParentFamilyAccessLevel, current: c.current };
    const key = `${out.schoolId}/${out.familyId}`;
    if (seen.has(key)) invalid();
    seen.add(key);
    return out;
  });
  const current = choices.filter(c => c.current).length;
  // At most one family is current. A choice is needed exactly when there are several and none is current.
  if (current > 1 || row.needsChoice !== (choices.length > 1 && current === 0)) invalid();
  // With exactly one family, that family is the current one.
  if (choices.length === 1 && current !== 1) invalid();
  return { choices, needsChoice: row.needsChoice };
}

/** The answer to a choice: the chosen family is now the current one. */
export function verifyParentFamilySelection(value: unknown, expected: SelectParentFamilyInput): ParentFamilyChoices {
  const out = verifyParentFamilyChoices(value);
  const chosen = out.choices.find(c => c.current);
  if (!chosen || chosen.schoolId !== expected.schoolId || chosen.familyId !== expected.familyId || out.needsChoice) invalid();
  return out;
}
