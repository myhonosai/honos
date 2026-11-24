import { BadRequestException, Injectable } from '@nestjs/common';
import { saasUuid, validateSaasFounderPoolHqView, validateSaasFounderSchoolAvailability } from '@hon/contracts';
import { SaasBillingService } from '../saas-billing/saas-billing.service.js';

const parse = <T>(fn: () => T): T => { try { return fn(); } catch { throw new BadRequestException({ code: 'INVALID_SAAS_INPUT' }); } };

/**
 * Piece 4 (0279): read-only views of the founder 50-spot count. HQ (owner or billing operator) sees the pool and every
 * counted spot; a school purchaser sees whether a spot could be counted for its organization right now. Neither read
 * reserves a spot: only the first verified schedule payment counts one, inside the database.
 */
@Injectable()
export class SaasFounderService {
  constructor(private readonly billing: SaasBillingService) {}

  async pool(subject: string) {
    return this.billing.call('readFounderPoolHq', [subject], validateSaasFounderPoolHqView);
  }
  async schoolAvailability(subject: string, school: unknown) {
    return this.billing.call('readFounderAvailabilitySchool', [subject, parse(() => saasUuid(school))], validateSaasFounderSchoolAvailability);
  }
}
