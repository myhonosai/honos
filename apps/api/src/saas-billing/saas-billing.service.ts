import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  saasUuid, validateSaasCatalogDraftInput, validateSaasCatalogDraftReceipt, validateSaasCatalogPublishReceipt, validateSaasCatalogView,
  validateSaasFounderReleaseInput, validateSaasFounderReservationList, validateSaasFounderReservationReceipt, validateSaasFounderReserveInput,
  validateSaasOrganizationSubscription, validateSaasReservationStatusFilter, validateSaasSubscriptionCommand, validateSaasSubscriptionCommandReceipt,
  validateSaasSubscriptionList, validateSaasSubscriptionRecordInput, validateSaasSubscriptionReceipt, validateSaasSubscriptionStatusFilter,
  validateSaasInvoiceCommand, validateSaasInvoiceCommandReceipt, validateSaasInvoiceDetail, validateSaasInvoiceDraftInput, validateSaasInvoiceList,
  validateSaasInvoiceReceipt, validateSaasInvoiceStatusFilter, validateSaasPaymentEvidenceInput, validateSaasPaymentEvidenceReceipt, validateSaasPaymentStanding,
  validateSaasAllowanceCommand, validateSaasAllowanceReceipt, validateSaasCostEvidenceInput, validateSaasCostEvidenceReceipt,
  validateSaasCreditEstimate, validateSaasCreditEstimateQuery, validateSaasCreditProgramInput, validateSaasCreditProgramReceipt,
  validateSaasCreditProgramView, validateSaasCreditReservationReceipt, validateSaasCreditReserveInput, validateSaasCreditResolveInput,
  validateSaasCreditResolveReceipt, validateSaasCreditSettleInput, validateSaasOrganizationCredits, validateSaasPricingDraftInput,
  validateSaasPricingPublishReceipt, validateSaasPricingReceipt, validateSaasSchoolCredits,
} from '@hon/contracts';
import { RuntimeDatabaseService, type SaasBillingOperation } from '../foundation/runtime-database.service.js';

// Business-rule refusals the UI may show verbatim. Any other database message stays private.
const RULE_REFUSALS = new Set(['SAAS_POLICY_UNDECIDED','SAAS_CATALOG_UNDECIDED','SAAS_FOUNDER_LIMIT_BELOW_USAGE','SAAS_OFFER_NOT_AVAILABLE',
  'SAAS_OFFER_NOT_FOUNDER','SAAS_FOUNDER_WINDOW_CLOSED','SAAS_FOUNDER_NOT_ELIGIBLE','SAAS_FOUNDER_ALREADY_RESERVED','SAAS_FOUNDER_SOLD_OUT',
  'SAAS_ENTITLEMENT_NOT_ACTIVE','SAAS_ENTITLEMENT_MISMATCH','SAAS_SUBSCRIPTION_EXISTS','SAAS_FOUNDER_RESERVATION_REQUIRED',
  'SAAS_FOUNDER_RESERVATION_MISMATCH','SAAS_FOUNDER_RESERVATION_EXPIRED','SAAS_NO_BILLING_PERIODS','SAAS_PERIOD_NOT_ENDED',
  'SAAS_INVOICE_NOT_BILLABLE','SAAS_INVOICE_PERIOD_NOT_STARTED','SAAS_INVOICE_EXISTS','SAAS_INVOICE_TOO_MANY_LINES','SAAS_INVOICE_NEGATIVE_TOTAL',
  'SAAS_INVOICE_TAX_UNRESOLVED','SAAS_INVOICE_ZERO_TOTAL','SAAS_INVOICE_HAS_EVIDENCE','SAAS_INVOICE_NOT_ISSUED','SAAS_EVIDENCE_IN_FUTURE',
  'SAAS_EVIDENCE_DUPLICATE_REFERENCE','SAAS_PAYMENT_EXCEEDS_BALANCE','SAAS_EVIDENCE_RELATED_MISMATCH','SAAS_REVERSAL_EXCEEDS_PAYMENT',
  'SAAS_EVIDENCE_BEFORE_PAYMENT',
  'SAAS_PRICING_NOT_PUBLISHED','SAAS_PROVIDER_UNKNOWN','SAAS_COST_BELOW_BILLED','SAAS_COST_PERIOD_INVALID','SAAS_PRICING_COST_EVIDENCE_MISMATCH',
  'SAAS_PRICING_UNDECIDED','SAAS_ALLOWANCE_PERIOD_UNAVAILABLE','SAAS_SUBSCRIPTION_NOT_ACTIVE','SAAS_CREDITS_NOT_ACTIVE','SAAS_NO_PREMIUM_ALLOWANCE',
  'SAAS_OPERATION_NOT_PRICED','SAAS_OPERATION_NOT_IN_PLAN','SAAS_OPERATION_UNITS_EXCEEDED','SAAS_CREDITS_EXHAUSTED','SAAS_FINAL_EXCEEDS_RESERVATION']);
const STATE_CONFLICTS = new Set(['SAAS_VERSION_CONFLICT','SAAS_TRANSITION_NOT_ALLOWED','SAAS_CATALOG_NOT_DRAFT']);

function parse<T>(work: () => T): T {
  try { return work(); } catch { throw new BadRequestException({ code: 'INVALID_SAAS_INPUT' }); }
}

/** HON billing schools (B1 recordkeeping). Never touches school-to-family billing, payments or credits. */
@Injectable()
export class SaasBillingService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  async readCatalog(subject: string) {
    return this.run('readCatalog', [subject], validateSaasCatalogView);
  }
  async createCatalogDraft(subject: string, body: unknown, key: unknown) {
    const [input, idempotencyKey] = parse(() => [validateSaasCatalogDraftInput(body), saasUuid(key)] as const);
    return this.run('createCatalogDraft', [subject, JSON.stringify(input), idempotencyKey, randomUUID(), randomUUID()], validateSaasCatalogDraftReceipt);
  }
  async publishCatalog(subject: string, catalogId: unknown, key: unknown) {
    const [catalog, idempotencyKey] = parse(() => [saasUuid(catalogId), saasUuid(key)]);
    return this.run('publishCatalog', [subject, catalog, idempotencyKey, randomUUID(), randomUUID()], validateSaasCatalogPublishReceipt);
  }
  async readFounderReservations(subject: string, status: unknown) {
    const filter = parse(() => validateSaasReservationStatusFilter(status));
    return this.run('readFounderReservations', [subject, filter], validateSaasFounderReservationList);
  }
  async reserveFounder(subject: string, body: unknown, key: unknown) {
    const [input, idempotencyKey] = parse(() => [validateSaasFounderReserveInput(body), saasUuid(key)] as const);
    return this.run('reserveFounder', [subject, JSON.stringify(input), idempotencyKey, randomUUID(), randomUUID()], validateSaasFounderReservationReceipt);
  }
  async releaseFounder(subject: string, reservationId: unknown, body: unknown, key: unknown) {
    const [reservation, input, idempotencyKey] = parse(() => [saasUuid(reservationId), validateSaasFounderReleaseInput(body), saasUuid(key)] as const);
    return this.run('releaseFounder', [subject, reservation, JSON.stringify(input), idempotencyKey, randomUUID(), randomUUID()], validateSaasFounderReservationReceipt);
  }
  async readSubscriptions(subject: string, status: unknown) {
    const filter = parse(() => validateSaasSubscriptionStatusFilter(status));
    return this.run('readSubscriptions', [subject, filter], validateSaasSubscriptionList);
  }
  async readOrganizationSubscription(subject: string, organizationId: unknown) {
    const organization = parse(() => saasUuid(organizationId));
    return this.run('readOrganizationSubscription', [subject, organization], validateSaasOrganizationSubscription);
  }
  async recordSubscription(subject: string, body: unknown, key: unknown) {
    const [input, idempotencyKey] = parse(() => [validateSaasSubscriptionRecordInput(body), saasUuid(key)] as const);
    return this.run('recordSubscription', [subject, JSON.stringify(input), idempotencyKey, randomUUID(), randomUUID()], validateSaasSubscriptionReceipt);
  }
  async commandSubscription(subject: string, subscriptionId: unknown, body: unknown, key: unknown) {
    const [subscription, command, idempotencyKey] = parse(() => [saasUuid(subscriptionId), validateSaasSubscriptionCommand(body), saasUuid(key)] as const);
    return this.run('commandSubscription', [subject, subscription, JSON.stringify(command), idempotencyKey, randomUUID(), randomUUID()], validateSaasSubscriptionCommandReceipt);
  }

  // ---------- B2: invoices and payment evidence (recordkeeping only) ----------
  async readInvoices(subject: string, status: unknown) {
    const filter = parse(() => validateSaasInvoiceStatusFilter(status));
    return this.run('readInvoices', [subject, filter], validateSaasInvoiceList);
  }
  async readInvoice(subject: string, invoiceId: unknown) {
    const invoice = parse(() => saasUuid(invoiceId));
    return this.run('readInvoice', [subject, invoice], validateSaasInvoiceDetail);
  }
  async readPaymentStanding(subject: string, organizationId: unknown) {
    const organization = parse(() => saasUuid(organizationId));
    return this.run('readPaymentStanding', [subject, organization], validateSaasPaymentStanding);
  }
  async createInvoiceDraft(subject: string, body: unknown, key: unknown) {
    const [input, idempotencyKey] = parse(() => [validateSaasInvoiceDraftInput(body), saasUuid(key)] as const);
    return this.run('createInvoiceDraft', [subject, JSON.stringify(input), idempotencyKey, randomUUID(), randomUUID()], validateSaasInvoiceReceipt);
  }
  async commandInvoice(subject: string, invoiceId: unknown, body: unknown, key: unknown) {
    const [invoice, command, idempotencyKey] = parse(() => [saasUuid(invoiceId), validateSaasInvoiceCommand(body), saasUuid(key)] as const);
    return this.run('commandInvoice', [subject, invoice, JSON.stringify(command), idempotencyKey, randomUUID(), randomUUID()], validateSaasInvoiceCommandReceipt);
  }
  async recordPaymentEvidence(subject: string, invoiceId: unknown, body: unknown, key: unknown) {
    const [invoice, input, idempotencyKey] = parse(() => [saasUuid(invoiceId), validateSaasPaymentEvidenceInput(body), saasUuid(key)] as const);
    return this.run('recordPaymentEvidence', [subject, invoice, JSON.stringify(input), idempotencyKey, randomUUID(), randomUUID()], validateSaasPaymentEvidenceReceipt);
  }

  // ---------- B3: premium AI credit accounting ----------
  async readCreditProgram(subject: string) {
    return this.run('readCreditProgram', [subject], validateSaasCreditProgramView);
  }
  async readOrganizationCredits(subject: string, organizationId: unknown) {
    const organization = parse(() => saasUuid(organizationId));
    return this.run('readOrganizationCredits', [subject, organization], validateSaasOrganizationCredits);
  }
  async setCreditProgram(subject: string, body: unknown, key: unknown) {
    const [input, idempotencyKey] = parse(() => [validateSaasCreditProgramInput(body), saasUuid(key)] as const);
    return this.run('setCreditProgram', [subject, JSON.stringify(input), idempotencyKey, randomUUID(), randomUUID()], validateSaasCreditProgramReceipt);
  }
  async recordCostEvidence(subject: string, body: unknown, key: unknown) {
    const [input, idempotencyKey] = parse(() => [validateSaasCostEvidenceInput(body), saasUuid(key)] as const);
    return this.run('recordCostEvidence', [subject, JSON.stringify(input), idempotencyKey, randomUUID(), randomUUID()], validateSaasCostEvidenceReceipt);
  }
  async createPricingDraft(subject: string, body: unknown, key: unknown) {
    const [input, idempotencyKey] = parse(() => [validateSaasPricingDraftInput(body), saasUuid(key)] as const);
    return this.run('createPricingDraft', [subject, JSON.stringify(input), idempotencyKey, randomUUID(), randomUUID()], validateSaasPricingReceipt);
  }
  async publishPricing(subject: string, pricingId: unknown, key: unknown) {
    const [pricing, idempotencyKey] = parse(() => [saasUuid(pricingId), saasUuid(key)]);
    return this.run('publishPricing', [subject, pricing, idempotencyKey, randomUUID(), randomUUID()], validateSaasPricingPublishReceipt);
  }
  async commandAllowance(subject: string, body: unknown, key: unknown) {
    const [input, idempotencyKey] = parse(() => [validateSaasAllowanceCommand(body), saasUuid(key)] as const);
    return this.run('commandAllowance', [subject, JSON.stringify(input), idempotencyKey, randomUUID(), randomUUID()], validateSaasAllowanceReceipt);
  }
  async resolveCreditReservation(subject: string, reservationId: unknown, body: unknown, key: unknown) {
    const [reservation, input, idempotencyKey] = parse(() => [saasUuid(reservationId), validateSaasCreditResolveInput(body), saasUuid(key)] as const);
    return this.run('resolveCreditReservation', [subject, reservation, JSON.stringify(input), idempotencyKey, randomUUID(), randomUUID()], validateSaasCreditResolveReceipt);
  }
  async readSchoolCredits(subject: string, schoolId: unknown) {
    const school = parse(() => saasUuid(schoolId));
    return this.run('readSchoolCredits', [subject, school], validateSaasSchoolCredits);
  }
  async estimatePremiumOperation(subject: string, schoolId: unknown, query: unknown) {
    const [school, { operation, units }] = parse(() => [saasUuid(schoolId), validateSaasCreditEstimateQuery(query)] as const);
    return this.run('estimatePremiumOperation', [subject, school, operation, String(units)], validateSaasCreditEstimate);
  }
  /**
   * Premium job runtime only (no HTTP route): reserve before a provider call. The same idempotency
   * key on a retry returns the original reservation and never holds credits twice.
   */
  async reservePremiumCredits(subject: string, schoolId: unknown, body: unknown, key: unknown) {
    const [school, input, idempotencyKey] = parse(() => [saasUuid(schoolId), validateSaasCreditReserveInput(body), saasUuid(key)] as const);
    return this.run('reservePremiumCredits', [subject, school, JSON.stringify(input), idempotencyKey, randomUUID(), randomUUID()], validateSaasCreditReservationReceipt);
  }
  /** Premium job runtime only (no HTTP route): settle after the provider call (SUCCEEDED, FAILED or UNKNOWN). */
  async settlePremiumCredits(subject: string, reservationId: unknown, body: unknown, key: unknown) {
    const [reservation, input, idempotencyKey] = parse(() => [saasUuid(reservationId), validateSaasCreditSettleInput(body), saasUuid(key)] as const);
    return this.run('settlePremiumCredits', [subject, reservation, JSON.stringify(input), idempotencyKey, randomUUID(), randomUUID()], validateSaasCreditReservationReceipt);
  }

  private async run<T>(operation: SaasBillingOperation, params: (string | null)[], validate: (value: unknown) => T): Promise<T> {
    let data: unknown;
    try { data = await this.database.callSaasBilling(operation, params); }
    catch (error) {
      const { code, message } = (error ?? {}) as { code?: string; message?: string };
      if (code === '42501') throw new ForbiddenException({ code: 'SAAS_FORBIDDEN' });
      if (code === 'P0002') throw new NotFoundException({ code: 'SAAS_UNAVAILABLE' });
      if (code === '40001') throw new ConflictException({ code: STATE_CONFLICTS.has(message ?? '') ? message : 'SAAS_VERSION_CONFLICT' });
      if (code === '23505') throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REUSED' });
      if (code === '55P03' || code === '57014') throw new ConflictException({ code: 'SAAS_OUTCOME_UNKNOWN', detail: 'Retry the identical request with the same key; do not assume the command took effect.' });
      if (code === '23514' && RULE_REFUSALS.has(message ?? '')) throw new UnprocessableEntityException({ code: message });
      if (['22023','22P02','22003','22007','22008','23514'].includes(code ?? '')) throw new BadRequestException({ code: 'INVALID_SAAS_INPUT' });
      throw new ServiceUnavailableException({ code: 'SAAS_UNAVAILABLE' });
    }
    try { return validate(data); } catch { throw new ServiceUnavailableException({ code: 'SAAS_UNAVAILABLE' }); }
  }
}
