import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { hqEntitlementUuid, validateHqEntitlementTransitionInput, validateHqEntitlementTransitionReceipt } from '@hon/contracts';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';

@Injectable()
export class HqEntitlementService {
  constructor(private readonly database: RuntimeDatabaseService) {}
  async transition(externalSubject: string, organizationId: unknown, body: unknown, idempotencyKey: unknown) {
    let org: string; let key: string; let input;
    try {
      org = hqEntitlementUuid(organizationId); key = hqEntitlementUuid(idempotencyKey);
      input = validateHqEntitlementTransitionInput(body);
    } catch { throw new BadRequestException({ code: 'INVALID_HQ_ENTITLEMENT_INPUT' }); }
    try {
      const result = await this.database.transitionOrganizationEntitlementFromHq(externalSubject, org, input, key,
        createHash('sha256').update(`hq.entitlement.transition:${org}:${input.targetTier}:${input.expectedVersion}`).digest('hex'), randomUUID(), randomUUID());
      return validateHqEntitlementTransitionReceipt(result);
    } catch (error) {
      const code = (error as { code?: string })?.code;
      if (code === '42501') throw new ForbiddenException({ code: 'HQ_ENTITLEMENT_FORBIDDEN' });
      if (code === 'P0002') throw new NotFoundException({ code: 'HQ_ENTITLEMENT_UNAVAILABLE' });
      if (code === '40001') throw new ConflictException({ code: 'HQ_ENTITLEMENT_VERSION_OR_TARGET_CONFLICT' });
      if (code === '23505') throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REUSED' });
      if (code === '55P03' || code === '57014') throw new ConflictException({ code: 'HQ_ENTITLEMENT_OUTCOME_UNKNOWN', detail: 'Retry the identical request with the same key; do not assume a transition occurred.' });
      if (['22023','22P02','22003','23514'].includes(code ?? '')) throw new BadRequestException({ code: 'INVALID_HQ_ENTITLEMENT_INPUT' });
      throw new ServiceUnavailableException({ code: 'HQ_ENTITLEMENT_UNAVAILABLE' });
    }
  }
}
