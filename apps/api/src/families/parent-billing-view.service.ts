import { ConflictException, ForbiddenException, HttpException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { verifyParentBillingView, type ParentBillingView } from '@hon/contracts';
import { RuntimeDatabaseService, type ResolvedParentFamilyScope } from '../foundation/runtime-database.service.js';

function sameScope(a: ResolvedParentFamilyScope, b: ResolvedParentFamilyScope): boolean {
  return ['principalId', 'organizationId', 'schoolId', 'familyId', 'accessLevel'].every(key => a[key as keyof ResolvedParentFamilyScope] === b[key as keyof ResolvedParentFamilyScope]);
}

/**
 * Parent/Eian billing is a read-only redacted projection. No caller supplies a
 * school, family, child, account, invoice, payment, payer, or provider value.
 * The database projection independently resolves and rechecks the same live
 * guardian scope before it reads its fixed family relationship path.
 */
@Injectable()
export class ParentBillingViewService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  private async scope(subject: string): Promise<ResolvedParentFamilyScope> {
    const discovered = await this.database.resolveParentJourneyScopes(subject);
    if (!discovered.length) {
      throw new ForbiddenException({ code: 'PARENT_BILLING_SCOPE_DENIED', detail: 'Current verified guardian family access is required.' });
    }
    if (discovered.length !== 1) {
      throw new ConflictException({ code: 'PARENT_BILLING_SCOPE_AMBIGUOUS', detail: 'A verified current-family selector is unavailable. No family is selected automatically.' });
    }
    const candidate = discovered[0]!;
    if (candidate.accessLevel === 'VIEWER') {
      throw new ForbiddenException({ code: 'PARENT_BILLING_GUARDIAN_REQUIRED', detail: 'Billing observations require a current guardian family grant.' });
    }
    // A second live resolver read prevents a cached/pre-resolved school scope
    // from becoming current authority. There is intentionally no school route
    // parameter, staff permission, organization selector, or HQ fallback.
    const verified = await this.database.resolveParentJourneyScopes(subject);
    if (verified.length !== 1 || !sameScope(candidate, verified[0]!)) {
      throw new ForbiddenException({ code: 'PARENT_BILLING_SCOPE_CHANGED', detail: 'Current guardian family access changed before the read.' });
    }
    return verified[0]!;
  }

  async get(externalSubject: string): Promise<{ data: ParentBillingView; meta: { requestId: string; correlationId: string } }> {
    const requestId = randomUUID();
    try {
      const initial = await this.scope(externalSubject);
      const raw = await this.database.readParentBillingView(externalSubject);
      const live = await this.scope(externalSubject);
      if (!sameScope(initial, live)) {
        throw new ForbiddenException({ code: 'PARENT_BILLING_SCOPE_CHANGED', detail: 'Current guardian family access changed during the read.' });
      }
      const data = verifyParentBillingView(raw);
      if (data.accessLevel !== live.accessLevel) throw new Error('Parent billing access level changed during projection.');
      return { data, meta: { requestId, correlationId: requestId } };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if ((error as { code?: string }).code === '42501') {
        throw new ForbiddenException({ code: 'PARENT_BILLING_SCOPE_DENIED', detail: 'No verified guardian billing result is shown.' });
      }
      throw new ServiceUnavailableException({ code: 'PARENT_BILLING_UNAVAILABLE', detail: 'No verified family billing result is shown.' });
    }
  }
}
