import { ConflictException, ForbiddenException, HttpException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { verifyParentTestingStatusView, type ParentTestingStatusView } from '@hon/contracts';
import { RuntimeDatabaseService, type ResolvedParentFamilyScope } from '../foundation/runtime-database.service.js';

function sameScope(a: ResolvedParentFamilyScope, b: ResolvedParentFamilyScope): boolean {
  return ['principalId', 'organizationId', 'schoolId', 'familyId', 'accessLevel'].every(key => a[key as keyof ResolvedParentFamilyScope] === b[key as keyof ResolvedParentFamilyScope]);
}

/** Fixed parent/Eian testing-status read: no client family, child, school, staff, or testing selectors. */
@Injectable()
export class ParentTestingStatusService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  private async scope(subject: string): Promise<ResolvedParentFamilyScope> {
    const initial = await this.database.resolveParentJourneyScopes(subject);
    if (!initial.length) throw new ForbiddenException({ code: 'PARENT_TESTING_STATUS_SCOPE_DENIED', detail: 'Current verified family access is required.' });
    if (initial.length !== 1) throw new ConflictException({ code: 'PARENT_TESTING_STATUS_SCOPE_AMBIGUOUS', detail: 'A verified current-family selector is unavailable. No family is selected automatically.' });
    const candidate = initial[0]!;
    const verified = await this.database.resolveParentJourneyScopes(subject);
    if (verified.length !== 1 || !sameScope(candidate, verified[0]!)) throw new ForbiddenException({ code: 'PARENT_TESTING_STATUS_SCOPE_CHANGED', detail: 'Current verified family access changed before the read.' });
    return verified[0]!;
  }

  async get(externalSubject: string): Promise<{ data: ParentTestingStatusView; meta: { requestId: string; correlationId: string } }> {
    const requestId = randomUUID();
    try {
      const initial = await this.scope(externalSubject);
      const raw = await this.database.readParentTestingStatus(externalSubject);
      const live = await this.scope(externalSubject);
      if (!sameScope(initial, live)) throw new ForbiddenException({ code: 'PARENT_TESTING_STATUS_SCOPE_CHANGED', detail: 'Current verified family access changed during the read.' });
      const data = verifyParentTestingStatusView(raw);
      if (data.accessLevel !== live.accessLevel) throw new Error('Parent testing access level changed during projection.');
      return { data, meta: { requestId, correlationId: requestId } };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if ((error as { code?: string }).code === '42501') throw new ForbiddenException({ code: 'PARENT_TESTING_STATUS_SCOPE_DENIED', detail: 'No verified family testing status is shown.' });
      throw new ServiceUnavailableException({ code: 'PARENT_TESTING_STATUS_UNAVAILABLE', detail: 'No verified family testing status is shown.' });
    }
  }
}
