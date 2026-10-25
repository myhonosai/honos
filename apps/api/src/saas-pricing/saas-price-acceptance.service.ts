import { BadRequestException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { saasUuid, validateSaasPriceScheduleRecordInput, validateSaasPriceAcceptanceInput,
  validateSaasPriceSchedule, validateSaasPriceAcceptance, validateSaasPriceAcceptancePreview,
  validateSaasPriceScheduleReceipt, validateSaasPriceAcceptanceReceipt } from '@hon/contracts';
import { SaasBillingService } from '../saas-billing/saas-billing.service.js';
const parse = <T>(fn: () => T): T => { try { return fn(); } catch { throw new BadRequestException({ code: 'INVALID_SAAS_INPUT' }); } };
@Injectable()
export class SaasPriceAcceptanceService {
  constructor(private readonly billing: SaasBillingService) {}
  record(subject: string, body: unknown, key: unknown) {
    const [input, k] = parse(() => [validateSaasPriceScheduleRecordInput(body), saasUuid(key)] as const);
    return this.billing.call('recordPriceSchedule', [subject, JSON.stringify(input), k, randomUUID(), randomUUID()], validateSaasPriceScheduleReceipt);
  }
  schedule(subject: string, id: unknown) {
    return this.billing.call('readPriceSchedule', [subject, parse(() => saasUuid(id))], validateSaasPriceSchedule);
  }
  preview(subject: string, school: unknown, id: unknown) {
    const [s, schedule] = parse(() => [saasUuid(school), saasUuid(id)] as const);
    return this.billing.call('previewPriceAcceptance', [subject, s, schedule], validateSaasPriceAcceptancePreview);
  }
  accept(subject: string, school: unknown, body: unknown, key: unknown) {
    const [s, input, k] = parse(() => [saasUuid(school), validateSaasPriceAcceptanceInput(body), saasUuid(key)] as const);
    return this.billing.call('acceptPriceSchedule', [subject, s, JSON.stringify(input), k, randomUUID(), randomUUID()], validateSaasPriceAcceptanceReceipt);
  }
  acceptance(subject: string, school: unknown, id: unknown) {
    const [s, a] = parse(() => [saasUuid(school), saasUuid(id)] as const);
    return this.billing.call('readPriceAcceptance', [subject, s, a], validateSaasPriceAcceptance);
  }
}
