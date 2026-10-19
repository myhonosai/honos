import { BadRequestException, Injectable } from '@nestjs/common';
import {
  saasUuid, validateSaasAccessReadiness, validateSaasSchoolBillingAccount, validateSaasSchoolInvoiceDetail, validateSaasSchoolInvoicePage,
  validateSaasSchoolInvoiceQuery,
} from '@hon/contracts';
import { SaasBillingService } from '../saas-billing/saas-billing.service.js';

function parse<T>(work: () => T): T {
  try { return work(); } catch { throw new BadRequestException({ code: 'INVALID_SAAS_INPUT' }); }
}

/**
 * B5.1 school-owner reads of the organization's own HON subscription billing (billing.hon.view at the exact
 * school), and the HQ dry run of the proposed paid-access terms. Read-only: nothing here changes access.
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
}
