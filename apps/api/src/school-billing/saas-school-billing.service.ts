import { randomUUID } from 'node:crypto';
import { BadRequestException, Injectable } from '@nestjs/common';
import {
  saasUuid, validateSaasAccessAwaitInput, validateSaasAccessExceptionCloseInput, validateSaasAccessExceptionCloseReceipt,
  validateSaasAccessExceptionGrantInput, validateSaasAccessExceptionGrantReceipt, validateSaasAccessExceptionRevokeInput,
  validateSaasAccessExceptionRevokeReceipt, validateSaasAccessExceptionsView, validateSaasAccessAwaitReceipt, validateSaasAccessReadiness, validateSaasAccessRetryInput,
  validateSaasAccessRetryReceipt, validateSaasOrganizationAccessView, validateSaasSchoolAccessStanding, validateSaasSchoolBillingAccount, validateSaasSchoolInvoiceDetail, validateSaasSchoolInvoicePage,
  validateSaasSchoolInvoiceQuery,
  validateSaasExceptionPolicyDecisionInput, validateSaasAccessOverview, validateSaasAccessOverviewQuery, validateHqSchoolDetail, validateSaasExceptionPolicyReceipt, validateSaasExceptionPolicyView,
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
  async readAccessStanding(subject: string, schoolId: unknown) {
    const school = parse(() => saasUuid(schoolId));
    return this.billing.call('readSchoolAccessStanding', [subject, school], validateSaasSchoolAccessStanding);
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
  /** B-HQ-1: every organization's access standing for HQ owners and billing operators. Advisory; commands re-decide. */
  async readAccessOverview(subject: string, query: unknown) {
    const q = parse(() => validateSaasAccessOverviewQuery(query));
    return this.billing.call('readAccessOverview', [subject, q.status, q.cursor?.createdAt ?? null, q.cursor?.organizationId ?? null, String(q.limit)],
      validateSaasAccessOverview);
  }
  /** C-HQ-3: one school for HQ owners and billing operators: access standing, ownership and invitation/people counts. */
  async readHqSchoolDetail(subject: string, schoolId: unknown) {
    const school = parse(() => saasUuid(schoolId));
    return this.billing.call('readHqSchoolDetail', [subject, school], validateHqSchoolDetail);
  }
  // D9: HQ-owner access exceptions. The database enforces the HQ-owner authority, eligibility and window cap.
  async readExceptionPolicy(subject: string) {
    return this.billing.call('readExceptionPolicy', [subject], validateSaasExceptionPolicyView);
  }
  async decideExceptionPolicy(subject: string, body: unknown, key: unknown) {
    const [input,idempotencyKey] = parse(() => [validateSaasExceptionPolicyDecisionInput(body),saasUuid(key)] as const);
    return this.billing.call('decideExceptionPolicy', [subject,JSON.stringify(input),idempotencyKey,randomUUID(),randomUUID()],validateSaasExceptionPolicyReceipt);
  }
  async readAccessExceptions(subject: string, organizationId: unknown) {
    const organization = parse(() => saasUuid(organizationId));
    return this.billing.call('readAccessExceptions', [subject, organization], validateSaasAccessExceptionsView);
  }
  async grantAccessException(subject: string, organizationId: unknown, body: unknown, key: unknown) {
    const [organization, input, idempotencyKey] = parse(() => [saasUuid(organizationId), validateSaasAccessExceptionGrantInput(body), saasUuid(key)] as const);
    return this.billing.call('grantAccessException', [subject, organization, JSON.stringify(input), idempotencyKey, randomUUID(), randomUUID()],
      validateSaasAccessExceptionGrantReceipt);
  }
  async revokeAccessException(subject: string, exceptionId: unknown, body: unknown, key: unknown) {
    const [exception, input, idempotencyKey] = parse(() => [saasUuid(exceptionId), validateSaasAccessExceptionRevokeInput(body), saasUuid(key)] as const);
    return this.billing.call('revokeAccessException', [subject, exception, JSON.stringify(input), idempotencyKey, randomUUID(), randomUUID()],
      validateSaasAccessExceptionRevokeReceipt);
  }
  async closeExpiredAccessExceptions(subject: string, body: unknown, key: unknown) {
    const idempotencyKey = parse(() => { validateSaasAccessExceptionCloseInput(body); return saasUuid(key); });
    return this.billing.call('closeExpiredAccessExceptions', [subject, idempotencyKey, randomUUID(), randomUUID()],
      validateSaasAccessExceptionCloseReceipt);
  }
}
