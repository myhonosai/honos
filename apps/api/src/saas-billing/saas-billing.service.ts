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
  validateSaasAccountCreditApplyInput, validateSaasAccountCreditApplyReceipt, validateSaasAlertStatusFilter, validateSaasCreditApplicationPreview,
  validateSaasReferralAlertList, validateSaasReferralAlertReceipt, validateSaasReferralAlertResolveInput, validateSaasRefundDecisionInput,
  validateSaasRefundDecisionReceipt, validateSaasRefundEligibility, validateSaasRefundEligibilityQuery, validateSaasRefundRequestInput,
  validateSaasRefundRequestList, validateSaasRefundRequestReceipt, validateSaasRefundReserve, validateSaasRefundStatusFilter,
  validateSaasRewardApplyInput, validateSaasRewardApplyReceipt, validateSaasRewardFulfillmentInput, validateSaasRewardFulfillmentReceipt,
  validateSaasRewardPreview,
  validateSaasHonOsOfferManagementView, validateSaasHonOsOfferSetDetail, validateSaasHonOsOfferSetDraftInput, validateSaasHonOsOfferSetReviseInput,
  validateSaasHonOsOfferSetDiscardInput, validateSaasHonOsOfferSetPublishInput, validateSaasHonOsOfferStopSalesInput, validateSaasHonOsOfferSetReceipt,
  validateSaasHonOsOfferSetDiscardReceipt, validateSaasHonOsOfferSetPublishReceipt, validateSaasHonOsOfferStopSalesReceipt, validateSaasHonOsSchoolOfferView,
} from '@hon/contracts';
import { RuntimeDatabaseService, type SaasBillingOperation } from '../foundation/runtime-database.service.js';

// Business-rule refusals the UI may show verbatim. Any other database message stays private.
const RULE_REFUSALS = new Set(['HQ_CAMPAIGN_CODE_TAKEN','HQ_CAMPAIGN_ARCHIVED','HQ_CAMPAIGN_NO_CHANGE','HQ_CAMPAIGN_STATUS_NOT_ALLOWED','SUPPORT_CASE_CLOSED','SUPPORT_ASSIGNEE_NOT_ELIGIBLE','SUPPORT_NO_CHANGE','CREATIVE_TOO_MANY_IN_PROGRESS','SAAS_GENERATION_ACCEPTANCE_INVALID','SAAS_GENERATION_EVIDENCE_REQUIRED','SAAS_PRICE_TERMS_UNSUPPORTED','SAAS_PRICE_ACCEPTANCE_BLOCKED','SAAS_PRICE_EVIDENCE_REQUIRED','SAAS_PRICE_PROVIDER_BINDING_REQUIRED','SAAS_TRIAL_POLICY_REQUIRED','SAAS_TRIAL_POLICY_WINDOW_INVALID','SAAS_TRIAL_PUBLICATION_BLOCKED','SAAS_TRIAL_EVIDENCE_REQUIRED','SAAS_POLICY_UNDECIDED','SAAS_CATALOG_UNDECIDED','SAAS_FOUNDER_LIMIT_BELOW_USAGE','SAAS_OFFER_NOT_AVAILABLE',
  'SAAS_OFFER_NOT_FOUNDER','SAAS_FOUNDER_WINDOW_CLOSED','SAAS_FOUNDER_NOT_ELIGIBLE','SAAS_FOUNDER_ALREADY_RESERVED','SAAS_FOUNDER_SOLD_OUT',
  'SAAS_ENTITLEMENT_NOT_ACTIVE','SAAS_ENTITLEMENT_MISMATCH','SAAS_ACCESS_EXCEPTION_ACTIVE','SAAS_ENTITLEMENT_IN_EFFECT',
  'SAAS_EXCEPTION_WINDOW_INVALID','SAAS_EXCEPTION_TOO_LONG','SAAS_EXCEPTION_ENDED','SAAS_SUBSCRIPTION_EXISTS','SAAS_FOUNDER_RESERVATION_REQUIRED',
  'SAAS_FOUNDER_RESERVATION_MISMATCH','SAAS_FOUNDER_RESERVATION_EXPIRED','SAAS_NO_BILLING_PERIODS','SAAS_PERIOD_NOT_ENDED',
  'SAAS_INVOICE_NOT_BILLABLE','SAAS_INVOICE_PERIOD_NOT_STARTED','SAAS_INVOICE_EXISTS','SAAS_INVOICE_TOO_MANY_LINES','SAAS_INVOICE_NEGATIVE_TOTAL',
  'SAAS_INVOICE_TAX_UNRESOLVED','SAAS_INVOICE_ZERO_TOTAL','SAAS_INVOICE_HAS_EVIDENCE','SAAS_INVOICE_NOT_ISSUED','SAAS_EVIDENCE_IN_FUTURE',
  'SAAS_EVIDENCE_DUPLICATE_REFERENCE','SAAS_PAYMENT_EXCEEDS_BALANCE','SAAS_EVIDENCE_RELATED_MISMATCH','SAAS_REVERSAL_EXCEEDS_PAYMENT',
  'SAAS_EVIDENCE_BEFORE_PAYMENT',
  'SAAS_PRICING_NOT_PUBLISHED','SAAS_PROVIDER_UNKNOWN','SAAS_COST_BELOW_BILLED','SAAS_COST_PERIOD_INVALID','SAAS_PRICING_COST_EVIDENCE_MISMATCH',
  'SAAS_PRICING_UNDECIDED','SAAS_ALLOWANCE_PERIOD_UNAVAILABLE','SAAS_SUBSCRIPTION_NOT_ACTIVE','SAAS_CREDITS_NOT_ACTIVE','SAAS_NO_PREMIUM_ALLOWANCE',
  'SAAS_OPERATION_NOT_PRICED','SAAS_OPERATION_NOT_IN_PLAN','SAAS_OPERATION_UNITS_EXCEEDED','SAAS_CREDITS_EXHAUSTED','SAAS_FINAL_EXCEEDS_RESERVATION',
  'SAAS_REFUND_NO_PAID_PURCHASE','SAAS_REFUND_ALREADY_GRANTED','SAAS_REFUND_REQUEST_OPEN','SAAS_REFUND_BEFORE_PAYMENT','SAAS_REFUND_WINDOW_EXPIRED',
  'SAAS_REFUND_NOTHING_TO_REFUND','SAAS_REFUND_EVIDENCE_INCOMPLETE','SAAS_PERIOD_FREE','SAAS_REWARD_ALREADY_APPLIED','SAAS_REWARD_VOIDED',
  'SAAS_REWARD_UNDER_REVIEW','SAAS_REWARD_NOT_APPROVED','SAAS_REWARD_PRIZE_MANUAL','SAAS_REWARD_SUBSTITUTE_MANUAL','SAAS_REWARD_PAYMENT_ALERT_OPEN',
  'SAAS_REWARD_NO_SUBSCRIPTION','SAAS_REWARD_NOT_APPLICABLE','SAAS_REWARD_NOTHING_TO_APPLY','SAAS_REWARDS_NOT_ACTIVE','SAAS_REWARD_PERIOD_IN_PAST',
  'SAAS_REWARD_PERIOD_TAKEN','SAAS_NO_ACCOUNT_CREDIT','SAAS_ALERT_ATTRIBUTION_UNDECIDED',
  'SAAS_PAYMENTS_NOT_ACTIVE','SAAS_CHECKOUT_OPEN',
  'SAAS_ACCESS_NOT_ACTIVE','SAAS_ACCESS_STATE_EXISTS','SAAS_ACCESS_STATE_CHANGED','SAAS_ACCESS_PAYMENT_UNVERIFIED','SAAS_ACCESS_PAYMENT_REVERSED',
  'SAAS_ACCESS_NOT_RETRYABLE',
  'SAAS_EXCEPTION_POLICY_REQUIRED','SAAS_EXCEPTION_POLICY_WINDOW_INVALID','SAAS_EXCEPTION_POLICY_LIMIT','SAAS_EXCEPTION_POLICY_EVIDENCE_REQUIRED',
  'SAAS_OFFER_PREVIEW_CHANGED','SAAS_OFFER_SET_NOT_READY','SAAS_OFFER_NOT_PUBLISHED','SAAS_OFFER_SALES_ALREADY_STOPPED',
  'SAAS_OFFER_NOT_ELIGIBLE','SAAS_OFFER_SOLD_OUT','SAAS_OFFER_TERMS_UNSUPPORTED','SAAS_LEGACY_SALES_CLOSED',
  'AI_SPEND_PAUSE_ALREADY_ACTIVE','AI_SPEND_PAUSE_NOT_ACTIVE','AI_UNKNOWN_NOT_RESOLVABLE',
  'AI_UNKNOWN_ORIGIN_UNAVAILABLE','AI_LATE_EXPENSE_NOT_WRITTEN_OFF','AI_LATE_EXPENSE_ALREADY_RECORDED','AI_LATE_EXPENSE_DUPLICATE_GENERATION',
  // CW1 creative credit wallet (0202).
  'SAAS_CREATIVE_PROGRAM_INACTIVE','SAAS_CREATIVE_PAID_ACCESS_REQUIRED','SAAS_CREATIVE_ENTITLEMENT_NOT_IN_EFFECT',
  'SAAS_CREATIVE_HON_OS_SUBSCRIPTION_REQUIRED','SAAS_CREATIVE_SUBSCRIPTION_NOT_IN_SERVICE','SAAS_CREATIVE_VERIFIED_PAYMENT_REQUIRED',
  'SAAS_CREATIVE_WINDOW_UNAVAILABLE','SAAS_CREATIVE_WINDOW_NOT_PAID','SAAS_CREATIVE_RATES_NOT_PUBLISHED','SAAS_CREATIVE_PURCHASED_LOT_PROTECTED',
  'SAAS_CREATIVE_DEBIT_EXCEEDS_AVAILABLE','SAAS_CREATIVE_SCHOOL_NOT_ACTIVE','SAAS_CREATIVE_COST_PROVIDER_MISMATCH',
  // CW1 review: the S4 shared spend decision (class CREATIVE_MEDIA) refuses new creative reservations.
  'SAAS_CREATIVE_AI_PAUSED_BY_HQ','SAAS_CREATIVE_AI_EXCEPTION_NO_AI','SAAS_CREATIVE_AI_TRIAL_FUNDING_NOT_APPROVED','SAAS_CREATIVE_AI_ACCESS_ENDED',
  'SAAS_CREATIVE_AI_ACCESS_LAPSED','SAAS_CREATIVE_AI_ACCESS_NOT_PAID','SAAS_CREATIVE_AI_ACCESS_PAST_DUE','SAAS_CREATIVE_AI_ACCESS_REVIEW_HOLD',
  'SAAS_CREATIVE_AI_ACCESS_SUSPENDED','SAAS_CREATIVE_AI_ACCESS_UNKNOWN_STATE']);
const STATE_CONFLICTS = new Set(['SAAS_GENERATION_ACCEPTANCE_STALE','SAAS_GENERATION_EXISTS','SAAS_PRICE_PREVIEW_STALE','SAAS_TRIAL_POLICY_STALE','SAAS_TRIAL_PREVIEW_STALE','SAAS_VERSION_CONFLICT','SAAS_TRANSITION_NOT_ALLOWED','SAAS_CATALOG_NOT_DRAFT','SAAS_OFFER_SET_NOT_DRAFT','SAAS_CREATIVE_OUTCOME_PENDING','CREATIVE_GENERATION_IN_PROGRESS']);

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

  // ---------- B4: refund guarantee records and Champions reward application ----------
  async readRefundEligibility(subject: string, organizationId: unknown, query: unknown) {
    const [organization, { receivedAt }] = parse(() => [saasUuid(organizationId), validateSaasRefundEligibilityQuery(query)] as const);
    return this.run('readRefundEligibility', [subject, organization, receivedAt ?? new Date().toISOString()], validateSaasRefundEligibility);
  }
  async readRefundRequests(subject: string, status: unknown) {
    const filter = parse(() => validateSaasRefundStatusFilter(status));
    return this.run('readRefundRequests', [subject, filter], validateSaasRefundRequestList);
  }
  async readRefundReserve(subject: string) {
    return this.run('readRefundReserve', [subject], validateSaasRefundReserve);
  }
  /** Records a customer's refund request (intake). Never executes or schedules a refund. */
  async createRefundRequest(subject: string, body: unknown, key: unknown) {
    const [input, idempotencyKey] = parse(() => [validateSaasRefundRequestInput(body), saasUuid(key)] as const);
    return this.run('createRefundRequest', [subject, JSON.stringify(input), idempotencyKey, randomUUID(), randomUUID()], validateSaasRefundRequestReceipt);
  }
  async decideRefundRequest(subject: string, refundRequestId: unknown, body: unknown, key: unknown) {
    const [refund, input, idempotencyKey] = parse(() => [saasUuid(refundRequestId), validateSaasRefundDecisionInput(body), saasUuid(key)] as const);
    return this.run('decideRefundRequest', [subject, refund, JSON.stringify(input), idempotencyKey, randomUUID(), randomUUID()], validateSaasRefundDecisionReceipt);
  }
  async readRewardPreview(subject: string, organizationId: unknown) {
    const organization = parse(() => saasUuid(organizationId));
    return this.run('readRewardPreview', [subject, organization], validateSaasRewardPreview);
  }
  async readReferralAlerts(subject: string, status: unknown) {
    const filter = parse(() => validateSaasAlertStatusFilter(status));
    return this.run('readReferralAlerts', [subject, filter], validateSaasReferralAlertList);
  }
  async setRewardFulfillment(subject: string, body: unknown, key: unknown) {
    const [input, idempotencyKey] = parse(() => [validateSaasRewardFulfillmentInput(body), saasUuid(key)] as const);
    return this.run('setRewardFulfillment', [subject, JSON.stringify(input), idempotencyKey, randomUUID(), randomUUID()], validateSaasRewardFulfillmentReceipt);
  }
  async applyChampionsReward(subject: string, rewardEntryId: unknown, body: unknown, key: unknown) {
    const [entry, input, idempotencyKey] = parse(() => [saasUuid(rewardEntryId), validateSaasRewardApplyInput(body), saasUuid(key)] as const);
    return this.run('applyChampionsReward', [subject, entry, JSON.stringify(input), idempotencyKey, randomUUID(), randomUUID()], validateSaasRewardApplyReceipt);
  }
  async readCreditApplicationPreview(subject: string, invoiceId: unknown) {
    const invoice = parse(() => saasUuid(invoiceId));
    return this.run('readCreditApplicationPreview', [subject, invoice], validateSaasCreditApplicationPreview);
  }
  async applyAccountCredit(subject: string, invoiceId: unknown, body: unknown, key: unknown) {
    const [invoice, input, idempotencyKey] = parse(() => [saasUuid(invoiceId), validateSaasAccountCreditApplyInput(body), saasUuid(key)] as const);
    return this.run('applyAccountCredit', [subject, invoice, JSON.stringify(input), idempotencyKey, randomUUID(), randomUUID()], validateSaasAccountCreditApplyReceipt);
  }
  async resolveReferralAlert(subject: string, alertId: unknown, body: unknown, key: unknown) {
    const [alert, input, idempotencyKey] = parse(() => [saasUuid(alertId), validateSaasReferralAlertResolveInput(body), saasUuid(key)] as const);
    return this.run('resolveReferralAlert', [subject, alert, JSON.stringify(input), idempotencyKey, randomUUID(), randomUUID()], validateSaasReferralAlertReceipt);
  }

  // ---------- HON OS commercial offers (0181): HQ Pricing & Offers; nothing here sells, charges or grants ----------
  async readOfferManagement(subject: string) {
    return this.run('readOfferManagement', [subject], validateSaasHonOsOfferManagementView);
  }
  async readOfferSet(subject: string, setId: unknown) {
    const set = parse(() => saasUuid(setId));
    return this.run('readOfferSet', [subject, set], validateSaasHonOsOfferSetDetail);
  }
  async createOfferSetDraft(subject: string, body: unknown, key: unknown) {
    const [input, idempotencyKey] = parse(() => [validateSaasHonOsOfferSetDraftInput(body), saasUuid(key)] as const);
    return this.run('createOfferSetDraft', [subject, JSON.stringify(input), idempotencyKey, randomUUID(), randomUUID()], validateSaasHonOsOfferSetReceipt);
  }
  async reviseOfferSetDraft(subject: string, setId: unknown, body: unknown, key: unknown) {
    const [set, input, idempotencyKey] = parse(() => [saasUuid(setId), validateSaasHonOsOfferSetReviseInput(body), saasUuid(key)] as const);
    return this.run('reviseOfferSetDraft', [subject, set, JSON.stringify(input), idempotencyKey, randomUUID(), randomUUID()], validateSaasHonOsOfferSetReceipt);
  }
  async discardOfferSetDraft(subject: string, setId: unknown, body: unknown, key: unknown) {
    const [set, input, idempotencyKey] = parse(() => [saasUuid(setId), validateSaasHonOsOfferSetDiscardInput(body), saasUuid(key)] as const);
    return this.run('discardOfferSetDraft', [subject, set, JSON.stringify(input), idempotencyKey, randomUUID(), randomUUID()], validateSaasHonOsOfferSetDiscardReceipt);
  }
  async publishOfferSet(subject: string, setId: unknown, body: unknown, key: unknown) {
    const [set, input, idempotencyKey] = parse(() => [saasUuid(setId), validateSaasHonOsOfferSetPublishInput(body), saasUuid(key)] as const);
    return this.run('publishOfferSet', [subject, set, JSON.stringify(input), idempotencyKey, randomUUID(), randomUUID()], validateSaasHonOsOfferSetPublishReceipt);
  }
  async stopOfferSales(subject: string, offerId: unknown, body: unknown, key: unknown) {
    const [offer, input, idempotencyKey] = parse(() => [saasUuid(offerId), validateSaasHonOsOfferStopSalesInput(body), saasUuid(key)] as const);
    return this.run('stopOfferSales', [subject, offer, JSON.stringify(input), idempotencyKey, randomUUID(), randomUUID()], validateSaasHonOsOfferStopSalesReceipt);
  }
  async readSchoolHonOsOffers(subject: string, schoolId: unknown) {
    const school = parse(() => saasUuid(schoolId));
    return this.run('readSchoolHonOsOffers', [subject, school], validateSaasHonOsSchoolOfferView);
  }

  /** Shared fixed-function call with the SaaS error mapping (used by the B5 payments service). */
  async call<T>(operation: SaasBillingOperation, params: (string | null)[], validate: (value: unknown) => T): Promise<T> {
    return this.run(operation, params, validate);
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
