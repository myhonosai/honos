import { describe, expect, it } from 'vitest';
import { verifyHqSchoolDirectory } from './hq-school-directory.js';

const first = {
  schoolId: '00000000-0000-4000-8000-000000000001',
  organizationDisplayName: 'First Organization',
  schoolDisplayName: 'First School',
  organizationOperationalStatus: 'ACTIVE',
  schoolOperationalStatus: 'ACTIVE',
  entitlementTier: 'CORE',
  createdAt: '2026-10-16T08:00:00.000Z',
};

const second = {
  schoolId: '00000000-0000-4000-8000-000000000002',
  organizationDisplayName: 'Second Organization',
  schoolDisplayName: 'Second School',
  organizationOperationalStatus: 'SUSPENDED',
  schoolOperationalStatus: 'ARCHIVED',
  entitlementTier: null,
  createdAt: '2026-10-16T08:01:00.000Z',
};

describe('HQ school directory projection', () => {
  it('accepts only the minimal ordered directory projection', () => {
    expect(verifyHqSchoolDirectory({ schools: [first, second] })).toEqual({ schools: [first, second] });
    expect(verifyHqSchoolDirectory({ schools: [] })).toEqual({ schools: [] });
  });

  it('rejects raw rows, private fields, fake authority, unsupported status, and reordered entries', () => {
    for (const value of [
      { schools: [{ ...first, organizationId: 'private' }] },
      { schools: [{ ...first, email: 'private@example.test' }] },
      { schools: [{ ...first, ownerName: 'private' }] },
      { schools: [{ ...first, invoiceTotal: 1 }] },
      { schools: [{ ...first, providerId: 'PRIVATE' }] },
      { schools: [{ ...first, actionRequestId: 'private' }] },
      { schools: [{ ...first, schoolOperationalStatus: 'UNKNOWN' }] },
      { schools: [{ ...first, entitlementTier: 'ENTERPRISE' }] },
      { schools: [second, first] },
    ]) expect(() => verifyHqSchoolDirectory(value)).toThrow('HQ_SCHOOL_DIRECTORY_INVALID');
  });
});
