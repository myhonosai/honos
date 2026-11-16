import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { StaffRoleAdmin, grantLabel, roleLabel, verifyRoleLists, ROLE_LIST_LIMIT } from '../src/components/staff-role-admin';

const ROLE = { id: '11111111-1111-4111-8111-111111111111', code: 'CUSTOM_FRONT_DESK', name: 'Front desk', version: 2, permissionCodes: ['school.view'] };
const GRANT = { id: '22222222-2222-4222-8222-222222222222', roleId: ROLE.id, roleName: 'Front desk', principalId: '33333333-3333-4333-8333-333333333333',
  displayName: 'Coach Teacher', version: 1, effectiveFrom: '2026-11-01T00:00:00Z', effectiveUntil: '2026-12-01T23:59:59Z' };

describe('staff roles page', () => {
  it('renders plain sections without fetching on the server and without contact fields', () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    try {
      const html = renderToStaticMarkup(<StaffRoleAdmin />);
      expect(fetcher).not.toHaveBeenCalled();
      for (const label of ['Organization UUID', 'School UUID', 'Custom roles', 'Who has which role', 'Give a role', 'Create role', 'Give role']) expect(html).toContain(label);
      for (const old of ['Grant registered human role', 'End / revoke grant', 'Read known role', 'Read known grant']) expect(html).not.toContain(old);
      expect(html).not.toContain('type="email"');
      expect(html).not.toContain('type="tel"');
      expect(html).not.toContain('Invite staff');
      expect(html).toContain('CUSTOM_');
      expect(html).toContain('Allowed permission codes');
    } finally { fetcher.mockRestore(); }
  });

  it('accepts a closed, bounded role list and labels rows by name', () => {
    const lists = verifyRoleLists({ roles: [ROLE], grants: [GRANT] });
    expect(roleLabel(lists.roles[0]!)).toBe('Front desk · 1 permission');
    expect(grantLabel(lists.grants[0]!)).toBe('Coach Teacher · Front desk · until 2026-12-01');
    expect(grantLabel({ ...GRANT, effectiveUntil: null })).toBe('Coach Teacher · Front desk');
    expect(grantLabel(GRANT)).not.toMatch(/[0-9a-f]{8}-/);
  });

  it('rejects extra fields, protected role codes, duplicates and oversized lists', () => {
    expect(() => verifyRoleLists({ roles: [ROLE], grants: [], extra: 1 })).toThrow();
    expect(() => verifyRoleLists({ roles: [{ ...ROLE, secret: 'x' }], grants: [] })).toThrow();
    for (const code of ['OWNER', 'HQ_ADMIN', 'HON_STAFF', 'PLATFORM_X', 'SYSTEM_X']) expect(() => verifyRoleLists({ roles: [{ ...ROLE, code }], grants: [] })).toThrow();
    expect(() => verifyRoleLists({ roles: [ROLE, ROLE], grants: [] })).toThrow();
    expect(() => verifyRoleLists({ roles: [], grants: [{ ...GRANT, principalId: 'nope' }] })).toThrow();
    const many = Array.from({ length: ROLE_LIST_LIMIT + 1 }, (_, i) => ({ ...ROLE, id: `11111111-1111-4111-8111-${String(i).padStart(12, '0')}` }));
    expect(() => verifyRoleLists({ roles: many, grants: [] })).toThrow();
  });
});
