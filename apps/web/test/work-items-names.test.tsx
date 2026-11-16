import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { personLabel } from '../src/components/school-pickers/pickers';

// Owner 2026-11-16: signed-in staff see teammates by name, never record IDs.
const me = '33333333-3333-4333-8333-333333333333', other = '55555555-5555-4555-8555-555555555555';
describe('work items by name', () => {
  it('labels people as You, their listed name, or a neutral fallback', () => {
    const staff = new Map([[other, 'Coach Rae']]);
    expect([personLabel(me, me, staff), personLabel(other, me, staff), personLabel(null, me, staff), personLabel(other, me, new Map())]).toEqual(['You', 'Coach Rae', 'Unassigned', 'A teammate']);
  });
  it('uses the signed-in school, a staff list, and no ID or policy wording', () => {
    const source = readFileSync('src/components/work-items-workbench.tsx', 'utf8');
    for (const text of ['useShellSchool', '<StaffPicker', 'purpose="work"', '<IdFields', 'personLabel(']) expect(source).toContain(text);
    for (const text of ['Known human assignee ID', 'Already-known work-item ID', 'signed-in human {', 'School {context.schoolId}', 'Record {r.workItemId}', '{selected.workItemId} ·', 'human actor {h.actorId}', 'AI plan ID {id}',
      'Expected version', 'Authorized school queue', 'Checking current human school authority', 'ordered by stable ID', 'Human assignee ${']) expect(source).not.toContain(text);
  });
});

describe('staff availability by name', () => {
  it('opens on the signed-in staff member, picks a teammate by name, and shows no IDs or permission codes', () => {
    const source = readFileSync('src/components/staff-availability-workbench.tsx', 'utf8');
    for (const text of ['useShellSchool', '<StaffPicker', 'purpose="availability"', '<IdFields', "load('self')"]) expect(source).toContain(text);
    for (const text of ['already-known staff principal UUID', '{profile.principalId} / {profile.schoolId}', 'staff.availability.self_manage', 'staff.qualification.manage', 'Load exact authorized', 'ISO weekdays', 'Exclusive end HH:mm', 'Read immutable version'])
      expect(source).not.toContain(text);
  });
});
