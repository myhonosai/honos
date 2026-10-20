import { randomUUID } from 'node:crypto';
import { BadRequestException, Injectable } from '@nestjs/common';
import {
  saasUuid, validateSaasAccessAwaitInput, validateSaasAccessAwaitReceipt, validateSaasAccessReadiness, validateSaasAccessRetryInput,
  validateSaasAccessRetryReceipt, validateSaasOrganizationAccessView, validateSaasSchoolBillingAccount, validateSaasSchoolInvoiceDetail, validateSaasSchoolInvoicePage,
  validateSaasSchoolInvoiceQuery,
} from '@hon/contracts';
import { SaasBillingService } from '../saas-billing/saas-billing.service.js';

function parse<T>(work: () => T): T {
  try { return work(); } catch { throw new BadRequestException({ code: 'INVALID_SAAS_INPUT' }); }
}

/**
 * B5.1 school-owner reads of the organization's own HON subscription billing (billing.hon.view at the exact
 * school), the HQ dry run of the proposed paid-access terms, and the B6A HQ-owner access commands, which the
 * database refuses while the paid-access program is INACTIVE.
 */
@Injectable()
export class SaasSchoolBillingService {
  constructor(private readonly billing: SaasBillingService) {}

  async readAccount(subject: string, schoolId: unknown) {
    const school = parse(() => saasUuid(schoolId));
    return this.billing.call('readSchoolBillingAccount', [subject, school], validateSaasSchoolBillingAccount);
  }
  async readInvoices(subject: string, schoolId: unknown, query: unknown) {
    const [school, q] = parse(() => [saasUuid(schoolId), validateSaasSchoolInvoiceQuery(query)] as const);
    return this.billing.call('readSchoolInvoices', [subject, school, q.status, q.kind, q.cursor?.issuedAt ?? null, q.cursor?.invoiceId ?? null, String(q.limit)],
      validateSaasSchoolInvoicePage);
  }
  async readInvoice(subject: string, schoolId: unknown, invoiceId: unknown) {
    const [school, invoice] = parse(() => [saasUuid(schoolId), saasUuid(invoiceId)] as const);
    return this.billing.call('readSchoolInvoice', [subject, school, invoice], validateSaasSchoolInvoiceDetail);
  }
  async readAccessReadiness(subject: string, organizationId: unknown) {
    const organization = parse(() => saasUuid(organizationId));
    return this.billing.call('readAccessReadiness', [subject, organization], validateSaasAccessReadiness);
  }
  async readOrganizationAccess(subject: string, organizationId: unknown) {
    const organization = parse(() => saasUuid(organizationId));
    return this.billing.call('readOrganizationAccess', [subject, organization], validateSaasOrganizationAccessView);
  }
  async awaitFirstPayment(subject: string, organizationId: unknown, body: unknown, key: unknown) {
    const [organization, input, idempotencyKey] = parse(() => [saasUuid(organizationId), validateSaasAccessAwaitInput(body), saasUuid(key)] as const);
    return this.billing.call('awaitFirstPayment', [subject, organization, JSON.stringify(input), idempotencyKey, randomUUID(), randomUUID()],
      validateSaasAccessAwaitReceipt);
  }
  async retryFirstPaymentActivation(subject: string, checkoutId: unknown, body: unknown, key: unknown) {
    const [checkout, input, idempotencyKey] = parse(() => [saasUuid(checkoutId), validateSaasAccessRetryInput(body), saasUuid(key)] as const);
    return this.billing.call('retryFirstPaymentActivation', [subject, checkout, JSON.stringify(input), idempotencyKey, randomUUID(), randomUUID()],
      validateSaasAccessRetryReceipt);
  }
}
