import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { StaffRoleAdmin } from '../src/components/staff-role-admin';

describe('human staff role administration form', () => {
  it('renders scoped exact operations without fetching identity directories or providers', () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    try {
      const html = renderToStaticMarkup(<StaffRoleAdmin />);
      expect(fetcher).not.toHaveBeenCalled();
      for (const label of ['Organization UUID', 'School UUID', 'Create custom role', 'Update custom role', 'Grant registered human role', 'End / revoke grant', 'Read known role', 'Read known grant', 'No payroll']) expect(html).toContain(label);
      expect(html).not.toContain('type="email"');
      expect(html).not.toContain('type="tel"');
      expect(html).not.toContain('Invite staff');
      expect(html).toContain('CUSTOM_');
      expect(html).toContain('Allowed permission codes');
    } finally { fetcher.mockRestore(); }
  });
});
