import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { followUpRowText, FOLLOW_UP_STATUS } from '../src/components/crm-follow-ups-workbench';

// Owner 2026-11-16: signed-in staff see people by name, never record IDs.
const me = '33333333-3333-4333-8333-333333333333', other = '55555555-5555-4555-8555-555555555555', lead = '44444444-4444-4444-8444-444444444444';
const item = { followUpId: '11111111-1111-4111-8111-111111111111', leadId: lead, assigneeId: other, dueAt: null, priority: 'HIGH' as const, version: 3, status: 'OPEN' as const };

describe('follow-up rows by name', () => {
  it('names the lead and assignee from the pick lists and never prints a record ID', () => {
    const names = { leads: new Map([[lead, 'Avery Kim']]), staff: new Map([[other, 'Coach Rae']]) };
    const row = followUpRowText(item, me, names, () => 'not set');
    expect(row).toEqual({ title: 'Open · High priority · due not set', lead: 'Avery Kim', assignee: 'Coach Rae' });
    expect(followUpRowText({ ...item, assigneeId: me }, me, names, () => 'x').assignee).toBe('You');
    const unknown = followUpRowText(item, me, { leads: new Map(), staff: new Map() }, () => 'x');
    expect(unknown.lead).toBe('Lead not in the open list');
    expect(unknown.assignee).toBe('A teammate');
    expect(JSON.stringify([row, unknown])).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
    expect(FOLLOW_UP_STATUS.CANCELLED).toBe('Cancelled');
  });

  it('opens on the signed-in school with pick lists and no ID or policy wording in view', () => {
    const source = readFileSync('src/components/crm-follow-ups-workbench.tsx', 'utf8');
    for (const text of ['useShellSchool', '<LeadPicker', '<StaffPicker', "purpose=\"followups\"", '<IdFields']) expect(source).toContain(text);
    for (const text of ['Known lead ID', 'Assignee staff ID', 'Already-known follow-up ID', 'Signed-in staff {', 'School {context.schoolId}', 'Expected version', 'Authorized school queue', 'human school boundary', 'Enter only IDs'])
      expect(source).not.toContain(text);
  });
});
