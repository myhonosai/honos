import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { validateParentPlannedAbsenceRequestInput, verifyParentPlannedAbsenceRequestContext, verifyParentPlannedAbsenceSubmittedReceipt, type CreatePlannedAbsenceRequestInput, type CommandContext } from '@hon/contracts';
import { RuntimeDatabaseService, type ResolvedParentFamilyScope } from '../foundation/runtime-database.service.js';
import { ParentPlannedAbsenceService } from './parent-planned-absence.service.js';

function same(a: ResolvedParentFamilyScope, b: ResolvedParentFamilyScope): boolean {
  return ['principalId', 'organizationId', 'schoolId', 'familyId', 'accessLevel'].every(key => a[key as keyof ResolvedParentFamilyScope] === b[key as keyof ResolvedParentFamilyScope]);
}
@Injectable()
export class ParentPlannedAbsenceRequestService {
  constructor(private readonly database: RuntimeDatabaseService, private readonly canonical: ParentPlannedAbsenceService) {}
  private async scope(subject: string): Promise<ResolvedParentFamilyScope> {
    const scopes = await this.database.resolveParentJourneyScopes(subject);
    if (!scopes.length) throw new ForbiddenException({ code: 'PARENT_ABSENCE_SCOPE_DENIED' });
    if (scopes.length !== 1) throw new ConflictException({ code: 'PARENT_ABSENCE_SCOPE_AMBIGUOUS' });
    if (!['PRIMARY_GUARDIAN', 'SECONDARY_GUARDIAN'].includes(scopes[0]!.accessLevel)) throw new ForbiddenException({ code: 'PARENT_ABSENCE_GUARDIAN_REQUIRED' });
    return scopes[0]!;
  }
  private failure(error: unknown): never {
    if (error instanceof HttpException) throw error;
    if ((error as { code?: string })?.code === '42501') throw new ForbiddenException({ code: 'PARENT_ABSENCE_SCOPE_DENIED' });
    throw new ServiceUnavailableException({ code: 'PARENT_ABSENCE_UNAVAILABLE', detail: 'No verified planned-absence result is available.' });
  }
  async context(subject: string) {
    try {
      const initial = await this.scope(subject);
      const data = verifyParentPlannedAbsenceRequestContext(await this.database.readParentPlannedAbsenceRequestContext(subject));
      if (!same(initial, await this.scope(subject))) throw new ForbiddenException({ code: 'PARENT_ABSENCE_SCOPE_CHANGED' });
      const requestId = randomUUID();
      return { data, meta: { requestId, correlationId: requestId } };
    } catch (error) { this.failure(error); }
  }
  async submit(subject: string, input: CreatePlannedAbsenceRequestInput, idempotencyKey: string) {
    try { validateParentPlannedAbsenceRequestInput(input); } catch { throw new BadRequestException({ code: 'VALIDATION_FAILED' }); }
    if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim() || idempotencyKey.length > 200 || /[\u0000-\u001f\u007f]/.test(idempotencyKey)) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
    try {
      // GET choices are not authority; discover and revalidate everything anew.
      const initial = await this.scope(subject);
      const choices = verifyParentPlannedAbsenceRequestContext(await this.database.readParentPlannedAbsenceRequestContext(subject));
      const live = await this.scope(subject);
      if (!same(initial, live)) throw new ForbiddenException({ code: 'PARENT_ABSENCE_SCOPE_CHANGED' });
      if (!choices.children.some(child => child.studentProfileId === input.studentProfileId.toLowerCase())) throw new ForbiddenException({ code: 'PARENT_ABSENCE_CHILD_UNAVAILABLE' });
      const requestId = randomUUID();
      const command: CommandContext = { organizationId: live.organizationId, schoolId: live.schoolId, principalId: live.principalId, principalType: 'HUMAN_USER', source: 'HUMAN_UI', idempotencyKey: idempotencyKey.trim(), requestId, correlationId: requestId };
      // The canonical transaction locks/revalidates the verified subject and child
      // before even idempotency replay, then preserves its existing atomic evidence.
      const result = await this.canonical.request(live, live.familyId, command, input, subject);
      const data = verifyParentPlannedAbsenceSubmittedReceipt({ status: result.plannedAbsenceRequest.status, submittedAt: result.plannedAbsenceRequest.createdAt });
      return { data, meta: { requestId, correlationId: requestId, replayed: result.replayed } };
    } catch (error) { this.failure(error); }
  }
}
