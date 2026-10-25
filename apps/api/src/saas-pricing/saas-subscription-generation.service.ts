import { BadRequestException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { saasUuid, validateSaasSubscriptionGenerationInput, validateSaasSubscriptionGeneration,
  validateSaasSubscriptionGenerationReceipt } from '@hon/contracts';
import { SaasBillingService } from '../saas-billing/saas-billing.service.js';
const parse = <T>(fn: () => T): T => { try { return fn(); } catch { throw new BadRequestException({code:'INVALID_SAAS_INPUT'}); } };
@Injectable()
export class SaasSubscriptionGenerationService {
  constructor(private readonly billing: SaasBillingService) {}
  record(subject: string, school: unknown, body: unknown, key: unknown) {
    const [s,input,k] = parse(() => [saasUuid(school),validateSaasSubscriptionGenerationInput(body),saasUuid(key)] as const);
    return this.billing.call('recordSubscriptionGeneration',[subject,s,JSON.stringify(input),k,randomUUID(),randomUUID()],validateSaasSubscriptionGenerationReceipt);
  }
  read(subject: string, school: unknown, id: unknown) {
    const [s,g] = parse(() => [saasUuid(school),saasUuid(id)] as const);
    return this.billing.call('readSubscriptionGeneration',[subject,s,g],validateSaasSubscriptionGeneration);
  }
  readHq(subject: string, id: unknown) {
    return this.billing.call('readSubscriptionGenerationHq',[subject,parse(() => saasUuid(id))],validateSaasSubscriptionGeneration);
  }
}
