import { accountUuid, verifySchoolContactMembershipDetails, type SchoolContactMembershipDetails } from '@hon/contracts';
import { PersonRecordError, codeOf, exchange, personErrorFor, type PeopleScope } from './http';

/**
 * 0659: payer, payment schedule and (for receivables readers) paid and due for each membership on the contact card. A
 * same-origin read; the database re-checks the staff member's live permissions. Nothing is written, sent or charged.
 */
export const membershipDetailsApi = {
  async read(scope: PeopleScope, personId: string, signal: AbortSignal): Promise<SchoolContactMembershipDetails> {
    let path: string;
    try {
      path = `/api/v1/organizations/${accountUuid(scope.organizationId)}/schools/${accountUuid(scope.schoolId)}/contacts/${accountUuid(personId)}/memberships`;
    } catch { throw new PersonRecordError('INVALID'); }
    const { status, value } = await exchange(path, signal);
    if (status !== 200) throw personErrorFor(status, codeOf(value));
    try {
      if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, 'data')) throw new Error('shape');
      return verifySchoolContactMembershipDetails((value as { data: unknown }).data);
    } catch { throw new PersonRecordError('UNKNOWN'); }
  },
};
export type MembershipDetailsApi = typeof membershipDetailsApi;
