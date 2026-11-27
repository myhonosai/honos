import { BadRequestException, Injectable } from '@nestjs/common';
import { saasUuid, validateHqSchoolPlanAssignInput, validateHqSchoolPlanReceipt, validateHqSchoolPlanRemoveInput,
  validateHqSchoolPlanView } from '@hon/contracts';
import { SaasBillingService } from '../saas-billing/saas-billing.service.js';

function parse<T>(f: () => T): T { try { return f(); } catch { throw new BadRequestException({ code: 'INVALID_SAAS_INPUT' }); } }
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * HQ school plan assignments (0676). The database decides HQ authority (owner-only commands; owner or hq.billing.manage
 * operator reads), checks the offer is published and not stopped, and freezes it. This only records the plan: nothing is
 * charged and no checkout, subscription, entitlement or access changes.
 */
@Injectable()
export class HqSchoolPlansService {
  constructor(private readonly billing: SaasBillingService) {}
  async read(subject: string, school: unknown) {
    const schoolId = parse(() => saasUuid(school));
    return this.billing.call('readHqSchoolPlan', [subject, schoolId], (v) => {
      const r = validateHqSchoolPlanView(v); if (!same(r.schoolId, schoolId)) throw new Error('mismatch'); return r;
    });
  }
  async assign(subject: string, school: unknown, body: unknown, key: unknown) {
    const [schoolId, input, k] = parse(() => [saasUuid(school), validateHqSchoolPlanAssignInput(body), saasUuid(key)] as const);
    return this.billing.call('assignHqSchoolPlan', [subject, schoolId, JSON.stringify(input), k], (v) => {
      const r = validateHqSchoolPlanReceipt(v);
      if (r.operation !== 'ASSIGN' || !same(r.schoolId, schoolId) || r.assignment.revision !== input.expectedRevision + 1) throw new Error('mismatch');
      return r;
    });
  }
  async remove(subject: string, school: unknown, body: unknown, key: unknown) {
    const [schoolId, input, k] = parse(() => [saasUuid(school), validateHqSchoolPlanRemoveInput(body), saasUuid(key)] as const);
    return this.billing.call('removeHqSchoolPlan', [subject, schoolId, JSON.stringify(input), k], (v) => {
      const r = validateHqSchoolPlanReceipt(v);
      if (r.operation !== 'REMOVE' || !same(r.schoolId, schoolId) || r.assignment.revision !== input.expectedRevision + 1) throw new Error('mismatch');
      return r;
    });
  }
}
