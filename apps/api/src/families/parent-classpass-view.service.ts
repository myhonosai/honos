import { ConflictException, ForbiddenException, HttpException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { verifyParentClassPassView, type ParentClassPassView } from '@hon/contracts';
import { RuntimeDatabaseService, type ResolvedParentFamilyScope } from '../foundation/runtime-database.service.js';
function sameScope(a: ResolvedParentFamilyScope, b: ResolvedParentFamilyScope): boolean {
  return ['principalId','organizationId','schoolId','familyId','accessLevel'].every(k => a[k as keyof ResolvedParentFamilyScope] === b[k as keyof ResolvedParentFamilyScope]);
}
@Injectable()
export class ParentClassPassViewService {
  constructor(private readonly database: RuntimeDatabaseService) {}
  private async scope(subject: string): Promise<ResolvedParentFamilyScope> {
    const scopes = await this.database.resolveParentJourneyScopes(subject);
    if (!scopes.length) throw new ForbiddenException({ code: 'PARENT_CLASSPASS_SCOPE_DENIED' });
    if (scopes.length !== 1) throw new ConflictException({ code: 'PARENT_CLASSPASS_SCOPE_AMBIGUOUS', detail: 'No current family is selected automatically.' });
    if (scopes[0]!.accessLevel === 'VIEWER') throw new ForbiddenException({ code: 'PARENT_CLASSPASS_GUARDIAN_REQUIRED' });
    const verified = await this.database.resolveParentJourneyScopes(subject);
    if (verified.length !== 1 || !sameScope(scopes[0]!, verified[0]!)) throw new ForbiddenException({ code: 'PARENT_CLASSPASS_SCOPE_CHANGED' });
    return verified[0]!;
  }
  async get(subject: string): Promise<{ data: ParentClassPassView; meta: { requestId: string; correlationId: string } }> {
    const requestId = randomUUID();
    try {
      const initial = await this.scope(subject);
      const raw = await this.database.readParentClassPassView(subject);
      const live = await this.scope(subject);
      if (!sameScope(initial, live)) throw new ForbiddenException({ code: 'PARENT_CLASSPASS_SCOPE_CHANGED' });
      const data = verifyParentClassPassView(raw);
      if (data.accessLevel !== live.accessLevel) throw new Error('Guardian access changed.');
      return { data, meta: { requestId, correlationId: requestId } };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if ((error as { code?: string }).code === '42501') throw new ForbiddenException({ code: 'PARENT_CLASSPASS_SCOPE_DENIED' });
      throw new ServiceUnavailableException({ code: 'PARENT_CLASSPASS_UNAVAILABLE', detail: 'No verified ClassPass result is shown. Payment/provider outcome unavailable.' });
    }
  }
}
