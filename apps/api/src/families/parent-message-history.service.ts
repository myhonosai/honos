import { ConflictException, ForbiddenException, HttpException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { verifyParentMessageHistoryView, type ParentMessageHistoryView } from '@hon/contracts';
import { RuntimeDatabaseService, type ResolvedParentFamilyScope } from '../foundation/runtime-database.service.js';

function sameScope(a: ResolvedParentFamilyScope, b: ResolvedParentFamilyScope): boolean {
  return ['principalId', 'organizationId', 'schoolId', 'familyId', 'accessLevel'].every(key => a[key as keyof ResolvedParentFamilyScope] === b[key as keyof ResolvedParentFamilyScope]);
}

/** Fixed parent/Eian message-history read: no family, child, message, staff, date, channel, or action selector. */
@Injectable()
export class ParentMessageHistoryService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  private async scope(subject: string): Promise<ResolvedParentFamilyScope> {
    const discovered = await this.database.resolveParentJourneyScopes(subject);
    if (!discovered.length) throw new ForbiddenException({ code: 'PARENT_MESSAGE_HISTORY_SCOPE_DENIED', detail: 'Current verified guardian family access is required.' });
    if (discovered.length !== 1) throw new ConflictException({ code: 'PARENT_MESSAGE_HISTORY_SCOPE_AMBIGUOUS', detail: 'A verified current-family selector is unavailable. No family is selected automatically.' });
    const candidate = discovered[0]!;
    if (candidate.accessLevel === 'VIEWER') throw new ForbiddenException({ code: 'PARENT_MESSAGE_HISTORY_GUARDIAN_REQUIRED', detail: 'Message history requires a current guardian family grant.' });
    const verified = await this.database.resolveParentJourneyScopes(subject);
    if (verified.length !== 1 || !sameScope(candidate, verified[0]!)) throw new ForbiddenException({ code: 'PARENT_MESSAGE_HISTORY_SCOPE_CHANGED', detail: 'Current guardian family access changed before the read.' });
    return verified[0]!;
  }

  async get(externalSubject: string): Promise<{ data: ParentMessageHistoryView; meta: { requestId: string; correlationId: string } }> {
    const requestId = randomUUID();
    try {
      const initial = await this.scope(externalSubject);
      const raw = await this.database.readParentMessageHistory(externalSubject);
      const live = await this.scope(externalSubject);
      if (!sameScope(initial, live)) throw new ForbiddenException({ code: 'PARENT_MESSAGE_HISTORY_SCOPE_CHANGED', detail: 'Current guardian family access changed during the read.' });
      const data = verifyParentMessageHistoryView(raw);
      if (data.accessLevel !== live.accessLevel) throw new Error('Parent message-history access level changed during projection.');
      return { data, meta: { requestId, correlationId: requestId } };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if ((error as { code?: string }).code === '42501') throw new ForbiddenException({ code: 'PARENT_MESSAGE_HISTORY_SCOPE_DENIED', detail: 'No verified guardian message history is shown.' });
      throw new ServiceUnavailableException({ code: 'PARENT_MESSAGE_HISTORY_UNAVAILABLE', detail: 'No verified family message history is shown.' });
    }
  }
}
