import { Injectable, OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common';
import { Pool, type PoolClient, type PoolConfig } from 'pg';
import { runtimePoolOptions } from './runtime-pool-options.js';
import { emitTelemetry, summarizeError } from '../observability/telemetry.js';
import { withTenantTransaction, type TenantTransactionContext } from '@hon/database';
import type { HonTier, AiControlPlaneSnapshot, AiControlPlaneKind, AiProviderConnectionWrite, AiCatalogEntryWrite, AiRoutingPolicyWrite, AiTaskProfileWrite, AiTaskProfileRegistry, AiRoutingRegistry, HqPlatformOverview, HqSchoolDirectory, OrganizationOperationsSummary, SchoolCommandCenterProjection, SchoolHealthScoreProjection, RetentionReviewSignals, RetentionReviewSignalsContext } from '@hon/contracts';
import type { HqEntitlementTransitionInput, HqEntitlementTransitionReceipt } from '@hon/contracts';
import type { StaffSearchKind, StaffSearchResponse } from '@hon/contracts';
export interface ResolvedStaffReportingScope {
  organizationId: string;
  schoolId: string;
}

export interface StaffReportingSchoolChoice extends ResolvedStaffReportingScope {
  organizationName: string;
  schoolName: string;
}

export interface ResolvedPrincipalScope {
  principalId: string;
  organizationId: string;
  schoolId: string;
}

interface TestingCertificateRuntimeContext extends TenantTransactionContext {
  externalSubject: string;
  source: 'HUMAN_UI';
  idempotencyKey: string;
  correlationId: string;
}

export interface ResolvedHqOperatorScope {
  principalId: string;
  hqRole: 'HON_HQ_OWNER' | 'HON_HQ_OPERATOR' | 'HON_HQ_SUPPORT';
}

export interface ResolvedParentFamilyScope extends ResolvedPrincipalScope {
  familyId: string;
  accessLevel: 'PRIMARY_GUARDIAN' | 'SECONDARY_GUARDIAN' | 'VIEWER';
}

export interface HqSchoolProvisioningCommand {
  externalSubject: string;
  /** The HQ principal the human screen verified; the database refuses before any write unless it is the actor. */
  expectedPrincipalId: string;
  legalName: string;
  displayName: string;
  schoolName: string;
  schoolSlug: string;
  timezone: string;
  initialTier: HonTier;
  idempotencyKey: string;
  requestFingerprint: string;
  requestId: string;
  correlationId: string;
}

export interface HqSchoolProvisioningResult {
  organizationId: string;
  schoolId: string;
  ownerRoleId: string;
  replayed: boolean;
  actorPrincipalId: string;
  entitlementStatus: string;
}

const CHAMPIONS_CLUB_CALLS = {
  issueReferralCode: { sql: 'SELECT hon.issue_champions_referral_code($1,$2::uuid,$3::uuid,$4::uuid,$5::uuid) AS data', arity: 5, readOnly: false },
  readSchoolView: { sql: 'SELECT hon.read_champions_school_view($1,$2::uuid) AS data', arity: 2, readOnly: true },
  readProgram: { sql: 'SELECT hon.read_champions_program_from_hq($1) AS data', arity: 1, readOnly: true },
  createPolicyDraft: { sql: 'SELECT hon.create_champions_policy_draft($1,$2::jsonb,$3::uuid,$4::uuid,$5::uuid) AS data', arity: 5, readOnly: false },
  publishPolicy: { sql: 'SELECT hon.publish_champions_policy($1,$2::uuid,$3::uuid,$4::uuid,$5::uuid) AS data', arity: 5, readOnly: false },
  captureAttribution: { sql: 'SELECT hon.capture_champions_attribution($1,$2::jsonb,$3::uuid,$4::uuid,$5::uuid) AS data', arity: 5, readOnly: false },
  decideAttribution: { sql: 'SELECT hon.decide_champions_attribution($1,$2::uuid,$3::jsonb,$4::uuid,$5::uuid,$6::uuid) AS data', arity: 6, readOnly: false },
  readAttributions: { sql: 'SELECT hon.read_champions_attributions_from_hq($1,$2) AS data', arity: 2, readOnly: true },
  readRewardProgram: { sql: 'SELECT hon.read_champions_reward_program_from_hq($1) AS data', arity: 1, readOnly: true },
  createRewardPolicyDraft: { sql: 'SELECT hon.create_champions_reward_policy_draft($1,$2::jsonb,$3::uuid,$4::uuid,$5::uuid) AS data', arity: 5, readOnly: false },
  publishRewardPolicy: { sql: 'SELECT hon.publish_champions_reward_policy($1,$2::uuid,$3::uuid,$4::uuid,$5::uuid) AS data', arity: 5, readOnly: false },
  reconcileRewards: { sql: 'SELECT hon.reconcile_champions_rewards($1,$2::uuid,$3::uuid,$4::uuid,$5::uuid) AS data', arity: 5, readOnly: false },
  decideReward: { sql: 'SELECT hon.decide_champions_reward($1,$2::uuid,$3::jsonb,$4::uuid,$5::uuid,$6::uuid) AS data', arity: 6, readOnly: false },
  readRewardLedger: { sql: 'SELECT hon.read_champions_reward_ledger_from_hq($1,$2) AS data', arity: 2, readOnly: true },
  readSchoolRewards: { sql: 'SELECT hon.read_champions_school_rewards($1,$2::uuid) AS data', arity: 2, readOnly: true },
  readHqLeaderboard: { sql: 'SELECT hon.read_champions_leaderboard_from_hq($1,$2,$3) AS data', arity: 3, readOnly: true },
  readHqSchoolStatistics: { sql: 'SELECT hon.read_champions_school_statistics_from_hq($1,$2::uuid) AS data', arity: 2, readOnly: true },
  setLeaderboardHold: { sql: 'SELECT hon.set_champions_leaderboard_hold($1,$2::jsonb,$3::uuid,$4::uuid,$5::uuid) AS data', arity: 5, readOnly: false },
  readSchoolLeaderboard: { sql: 'SELECT hon.read_champions_leaderboard_for_school($1,$2::uuid,$3,$4) AS data', arity: 4, readOnly: true },
  readSchoolStatistics: { sql: 'SELECT hon.read_champions_school_statistics($1,$2::uuid) AS data', arity: 2, readOnly: true },
  setLeaderboardPreference: { sql: 'SELECT hon.set_champions_leaderboard_preference($1,$2::uuid,$3::jsonb,$4::uuid,$5::uuid,$6::uuid) AS data', arity: 6, readOnly: false },
  commandContest: { sql: 'SELECT hon.command_champions_contest($1,$2::uuid,$3::jsonb,$4::uuid,$5::uuid,$6::uuid) AS data', arity: 6, readOnly: false },
  readContests: { sql: 'SELECT hon.read_champions_contests_from_hq($1,$2) AS data', arity: 2, readOnly: true },
  readContest: { sql: 'SELECT hon.read_champions_contest_from_hq($1,$2::uuid) AS data', arity: 2, readOnly: true },
  readSchoolContests: { sql: 'SELECT hon.read_champions_contests_for_school($1,$2::uuid) AS data', arity: 2, readOnly: true },
  readOverview: { sql: 'SELECT hon.read_champions_overview_from_hq($1) AS data', arity: 1, readOnly: true },
} as const;
export type ChampionsClubOperation = keyof typeof CHAMPIONS_CLUB_CALLS;

// HON subscription catalog (B1): HON billing schools. Separate from school-to-family billing.
const SAAS_BILLING_CALLS = {
  recordSubscriptionGeneration: { sql: 'SELECT hon.record_saas_subscription_generation($1,$2::uuid,$3::jsonb,$4::uuid,$5::uuid,$6::uuid) AS data', arity: 6, readOnly: false },
  readSubscriptionGeneration: { sql: 'SELECT hon.read_saas_subscription_generation($1,$2::uuid,$3::uuid) AS data', arity: 3, readOnly: true },
  readSubscriptionGenerationHq: { sql: 'SELECT hon.read_saas_subscription_generation_from_hq($1,$2::uuid) AS data', arity: 2, readOnly: true },
  startScheduleBinding: { sql: 'SELECT hon.start_saas_schedule_binding($1,$2::uuid,$3::jsonb,$4::uuid,$5::uuid,$6::uuid) AS data', arity: 6, readOnly: false },
  recordScheduleBindingObservation: { sql: 'SELECT hon.record_saas_schedule_binding_observation($1::uuid,$2::jsonb,$3::uuid,$4::uuid) AS data', arity: 4, readOnly: false },
  recordScheduleBindingReconciliation: { sql: 'SELECT hon.record_saas_schedule_binding_reconciliation($1::uuid,$2::jsonb) AS data', arity: 2, readOnly: false },
  recordScheduleBindingExpiry: { sql: 'SELECT hon.record_saas_schedule_binding_expiry($1::uuid,$2::jsonb) AS data', arity: 2, readOnly: false },
  cancelScheduleBinding: { sql: 'SELECT hon.cancel_saas_schedule_binding($1::text,$2::uuid,$3::uuid,$4::jsonb,$5::uuid,$6::uuid,$7::uuid) AS data', arity: 7, readOnly: false },
  readScheduleBinding: { sql: 'SELECT hon.read_saas_schedule_binding($1,$2::uuid,$3::uuid) AS data', arity: 3, readOnly: true },
  readScheduleBindingHq: { sql: 'SELECT hon.read_saas_schedule_binding_from_hq($1,$2::uuid) AS data', arity: 2, readOnly: true },
  ingestScheduleEvidence: { sql: 'SELECT hon.ingest_saas_schedule_evidence($1::jsonb,$2) AS data', arity: 2, readOnly: false },
  recordPriceSchedule: { sql: 'SELECT hon.record_saas_price_schedule($1,$2::jsonb,$3::uuid,$4::uuid,$5::uuid) AS data', arity: 5, readOnly: false },
  readPriceSchedule: { sql: 'SELECT hon.read_saas_price_schedule($1,$2::uuid) AS data', arity: 2, readOnly: true },
  previewPriceAcceptance: { sql: 'SELECT hon.preview_saas_price_acceptance($1,$2::uuid,$3::uuid) AS data', arity: 3, readOnly: true },
  acceptPriceSchedule: { sql: 'SELECT hon.accept_saas_price_schedule($1,$2::uuid,$3::jsonb,$4::uuid,$5::uuid,$6::uuid) AS data', arity: 6, readOnly: false },
  readPriceAcceptance: { sql: 'SELECT hon.read_saas_price_acceptance($1,$2::uuid,$3::uuid) AS data', arity: 3, readOnly: true },
  readCatalog: { sql: 'SELECT hon.read_saas_catalog_from_hq($1) AS data', arity: 1, readOnly: true },
  createCatalogDraft: { sql: 'SELECT hon.create_saas_catalog_draft($1,$2::jsonb,$3::uuid,$4::uuid,$5::uuid) AS data', arity: 5, readOnly: false },
  publishCatalog: { sql: 'SELECT hon.publish_saas_catalog($1,$2::uuid,$3::uuid,$4::uuid,$5::uuid) AS data', arity: 5, readOnly: false },
  readFounderReservations: { sql: 'SELECT hon.read_saas_founder_reservations_from_hq($1,$2) AS data', arity: 2, readOnly: true },
  reserveFounder: { sql: 'SELECT hon.reserve_saas_founder_offer($1,$2::jsonb,$3::uuid,$4::uuid,$5::uuid) AS data', arity: 5, readOnly: false },
  releaseFounder: { sql: 'SELECT hon.release_saas_founder_reservation($1,$2::uuid,$3::jsonb,$4::uuid,$5::uuid,$6::uuid) AS data', arity: 6, readOnly: false },
  readSubscriptions: { sql: 'SELECT hon.read_saas_subscriptions_from_hq($1,$2) AS data', arity: 2, readOnly: true },
  readOrganizationSubscription: { sql: 'SELECT hon.read_saas_organization_subscription_from_hq($1,$2::uuid) AS data', arity: 2, readOnly: true },
  recordSubscription: { sql: 'SELECT hon.record_saas_subscription($1,$2::jsonb,$3::uuid,$4::uuid,$5::uuid) AS data', arity: 5, readOnly: false },
  commandSubscription: { sql: 'SELECT hon.command_saas_subscription($1,$2::uuid,$3::jsonb,$4::uuid,$5::uuid,$6::uuid) AS data', arity: 6, readOnly: false },
  // B2: HON invoices and payment evidence (recordkeeping; nothing is collected or sent).
  readInvoices: { sql: 'SELECT hon.read_saas_invoices_from_hq($1,$2) AS data', arity: 2, readOnly: true },
  readInvoice: { sql: 'SELECT hon.read_saas_invoice_from_hq($1,$2::uuid) AS data', arity: 2, readOnly: true },
  readPaymentStanding: { sql: 'SELECT hon.read_saas_payment_standing_from_hq($1,$2::uuid) AS data', arity: 2, readOnly: true },
  createInvoiceDraft: { sql: 'SELECT hon.create_saas_invoice_draft($1,$2::jsonb,$3::uuid,$4::uuid,$5::uuid) AS data', arity: 5, readOnly: false },
  commandInvoice: { sql: 'SELECT hon.command_saas_invoice($1,$2::uuid,$3::jsonb,$4::uuid,$5::uuid,$6::uuid) AS data', arity: 6, readOnly: false },
  recordPaymentEvidence: { sql: 'SELECT hon.record_saas_payment_evidence($1,$2::uuid,$3::jsonb,$4::uuid,$5::uuid,$6::uuid) AS data', arity: 6, readOnly: false },
  // B3: premium AI credit accounting (no purchase, top-up, overage or provider call).
  readCreditProgram: { sql: 'SELECT hon.read_saas_credit_program_from_hq($1) AS data', arity: 1, readOnly: true },
  readOrganizationCredits: { sql: 'SELECT hon.read_saas_organization_credits_from_hq($1,$2::uuid) AS data', arity: 2, readOnly: true },
  setCreditProgram: { sql: 'SELECT hon.set_saas_credit_program($1,$2::jsonb,$3::uuid,$4::uuid,$5::uuid) AS data', arity: 5, readOnly: false },
  recordCostEvidence: { sql: 'SELECT hon.record_saas_provider_cost_evidence($1,$2::jsonb,$3::uuid,$4::uuid,$5::uuid) AS data', arity: 5, readOnly: false },
  createPricingDraft: { sql: 'SELECT hon.create_saas_pricing_draft($1,$2::jsonb,$3::uuid,$4::uuid,$5::uuid) AS data', arity: 5, readOnly: false },
  publishPricing: { sql: 'SELECT hon.publish_saas_pricing($1,$2::uuid,$3::uuid,$4::uuid,$5::uuid) AS data', arity: 5, readOnly: false },
  commandAllowance: { sql: 'SELECT hon.command_saas_credit_allowance($1,$2::jsonb,$3::uuid,$4::uuid,$5::uuid) AS data', arity: 5, readOnly: false },
  resolveCreditReservation: { sql: 'SELECT hon.resolve_saas_credit_reservation($1,$2::uuid,$3::jsonb,$4::uuid,$5::uuid,$6::uuid) AS data', arity: 6, readOnly: false },
  readSchoolCredits: { sql: 'SELECT hon.read_saas_school_credits($1,$2::uuid) AS data', arity: 2, readOnly: true },
  estimatePremiumOperation: { sql: 'SELECT hon.estimate_saas_premium_operation($1,$2::uuid,$3,$4::integer) AS data', arity: 4, readOnly: true },
  reservePremiumCredits: { sql: 'SELECT hon.reserve_saas_premium_credits($1,$2::uuid,$3::jsonb,$4::uuid,$5::uuid,$6::uuid) AS data', arity: 6, readOnly: false },
  settlePremiumCredits: { sql: 'SELECT hon.settle_saas_premium_credits($1,$2::uuid,$3::jsonb,$4::uuid,$5::uuid,$6::uuid) AS data', arity: 6, readOnly: false },
  // CW1: HON OS creative credit wallet (no provider call, no card charge; purchases are recorded intents only).
  setCreativeProgram: { sql: 'SELECT hon.set_saas_creative_program($1,$2::jsonb,$3::uuid,$4::uuid,$5::uuid) AS data', arity: 5, readOnly: false },
  publishCreativeRates: { sql: 'SELECT hon.publish_saas_creative_rates($1,$2::jsonb,$3::uuid,$4::uuid,$5::uuid) AS data', arity: 5, readOnly: false },
  grantCreativeCredits: { sql: 'SELECT hon.grant_saas_creative_credits_from_hq($1,$2::uuid,$3::jsonb,$4::uuid,$5::uuid,$6::uuid) AS data', arity: 6, readOnly: false },
  debitCreativeLot: { sql: 'SELECT hon.debit_saas_creative_lot_from_hq($1,$2::uuid,$3::jsonb,$4::uuid,$5::uuid,$6::uuid) AS data', arity: 6, readOnly: false },
  resolveCreativeReservation: { sql: 'SELECT hon.resolve_saas_creative_reservation_from_hq($1,$2::uuid,$3::jsonb,$4::uuid,$5::uuid,$6::uuid) AS data', arity: 6, readOnly: false },
  recordCreativeCost: { sql: 'SELECT hon.record_saas_creative_cost_from_hq($1,$2::uuid,$3::jsonb,$4::uuid,$5::uuid,$6::uuid) AS data', arity: 6, readOnly: false },
  readCreativeWalletFromHq: { sql: 'SELECT hon.read_saas_creative_wallet_from_hq($1,$2::uuid) AS data', arity: 2, readOnly: true },
  readCreativeWalletsFromHq: { sql: 'SELECT hon.read_saas_creative_wallets_from_hq($1) AS data', arity: 1, readOnly: true },
  readSchoolCreativeWallet: { sql: 'SELECT hon.read_saas_creative_wallet($1,$2::uuid) AS data', arity: 2, readOnly: true },
  openCreativeWindow: { sql: 'SELECT hon.open_saas_creative_window($1,$2::uuid,$3::uuid,$4::uuid,$5::uuid) AS data', arity: 5, readOnly: false },
  reserveCreativeCredits: { sql: 'SELECT hon.reserve_saas_creative_credits($1,$2::uuid,$3::jsonb,$4::uuid,$5::uuid,$6::uuid) AS data', arity: 6, readOnly: false },
  settleCreativeCredits: { sql: 'SELECT hon.settle_saas_creative_credits($1,$2::uuid,$3::jsonb,$4::uuid,$5::uuid,$6::uuid) AS data', arity: 6, readOnly: false },
  createCreativeTopupPurchase: { sql: 'SELECT hon.create_saas_creative_topup_purchase($1,$2::uuid,$3::jsonb,$4::uuid,$5::uuid,$6::uuid) AS data', arity: 6, readOnly: false },
  // CS1 (0216, proposed): Creative Studio generations on the school's creative wallet (no provider is called by the database).
  createCreativeGeneration: { sql: 'SELECT hon.create_creative_generation($1,$2::uuid,$3::jsonb,$4::jsonb,$5::uuid,$6::uuid,$7::uuid) AS data', arity: 7, readOnly: false },
  recordCreativeGenerationResult: { sql: 'SELECT hon.record_creative_generation_result($1,$2::uuid,$3::jsonb) AS data', arity: 3, readOnly: false },
  readCreativeGenerations: { sql: 'SELECT hon.read_creative_generations($1,$2::uuid) AS data', arity: 2, readOnly: true },
  readCreativeGeneration: { sql: 'SELECT hon.read_creative_generation($1,$2::uuid,$3::uuid) AS data', arity: 3, readOnly: true },
  // B4: refund guarantee records and Champions reward application (no refund execution, payout or prize).
  readRefundEligibility: { sql: 'SELECT hon.read_saas_refund_eligibility_from_hq($1,$2::uuid,$3::timestamptz) AS data', arity: 3, readOnly: true },
  readRefundRequests: { sql: 'SELECT hon.read_saas_refund_requests_from_hq($1,$2) AS data', arity: 2, readOnly: true },
  readRefundReserve: { sql: 'SELECT hon.read_saas_refund_reserve_from_hq($1) AS data', arity: 1, readOnly: true },
  createRefundRequest: { sql: 'SELECT hon.create_saas_refund_request($1,$2::jsonb,$3::uuid,$4::uuid,$5::uuid) AS data', arity: 5, readOnly: false },
  decideRefundRequest: { sql: 'SELECT hon.decide_saas_refund_request($1,$2::uuid,$3::jsonb,$4::uuid,$5::uuid,$6::uuid) AS data', arity: 6, readOnly: false },
  readRewardPreview: { sql: 'SELECT hon.read_saas_reward_preview_from_hq($1,$2::uuid) AS data', arity: 2, readOnly: true },
  readReferralAlerts: { sql: 'SELECT hon.read_saas_referral_alerts_from_hq($1,$2) AS data', arity: 2, readOnly: true },
  setRewardFulfillment: { sql: 'SELECT hon.set_saas_reward_fulfillment($1,$2::jsonb,$3::uuid,$4::uuid,$5::uuid) AS data', arity: 5, readOnly: false },
  applyChampionsReward: { sql: 'SELECT hon.apply_saas_referral_reward($1,$2::uuid,$3::jsonb,$4::uuid,$5::uuid,$6::uuid) AS data', arity: 6, readOnly: false },
  readCreditApplicationPreview: { sql: 'SELECT hon.read_saas_credit_application_preview($1,$2::uuid) AS data', arity: 2, readOnly: true },
  applyAccountCredit: { sql: 'SELECT hon.apply_saas_account_credit($1,$2::uuid,$3::jsonb,$4::uuid,$5::uuid,$6::uuid) AS data', arity: 6, readOnly: false },
  resolveReferralAlert: { sql: 'SELECT hon.resolve_saas_referral_alert($1,$2::uuid,$3::jsonb,$4::uuid,$5::uuid,$6::uuid) AS data', arity: 6, readOnly: false },
  // B5: hosted checkout and provider-verified payments, test mode only (no charge, refund or card data).
  readPayments: { sql: 'SELECT hon.read_saas_payments_from_hq($1) AS data', arity: 1, readOnly: true },
  readSchoolPlanOptions: { sql: 'SELECT hon.read_saas_school_plan_options($1,$2::uuid) AS data', arity: 2, readOnly: true },
  setPaymentProgram: { sql: 'SELECT hon.set_saas_payment_program($1,$2::jsonb,$3::uuid,$4::uuid,$5::uuid) AS data', arity: 5, readOnly: false },
  createSchoolCheckout: { sql: 'SELECT hon.create_saas_checkout_from_school($1,$2::uuid,$3::jsonb,$4::uuid,$5::uuid,$6::uuid) AS data', arity: 6, readOnly: false },
  createHqCheckout: { sql: 'SELECT hon.create_saas_checkout_from_hq($1,$2::jsonb,$3::uuid,$4::uuid,$5::uuid) AS data', arity: 5, readOnly: false },
  attachCheckoutSession: { sql: 'SELECT hon.attach_saas_checkout_session($1,$2::uuid,$3::jsonb,$4::uuid,$5::uuid,$6::uuid) AS data', arity: 6, readOnly: false },
  cancelCheckout: { sql: 'SELECT hon.cancel_saas_checkout($1,$2::uuid,$3::jsonb,$4::uuid,$5::uuid,$6::uuid) AS data', arity: 6, readOnly: false },
  sweepCheckouts: { sql: 'SELECT hon.sweep_saas_checkouts($1,$2::uuid,$3::uuid,$4::uuid) AS data', arity: 4, readOnly: false },
  // Called only after the API has verified the provider signature; there is no human subject.
  ingestProviderEvent: { sql: 'SELECT hon.ingest_saas_provider_event($1::jsonb,$2) AS data', arity: 2, readOnly: false },
  readSchoolBillingAccount: { sql: 'SELECT hon.read_saas_school_billing_account($1,$2::uuid) AS data', arity: 2, readOnly: true },
  readSchoolInvoices: { sql: 'SELECT hon.read_saas_school_invoices($1,$2::uuid,$3,$4,$5::timestamptz,$6::uuid,$7::integer) AS data', arity: 7, readOnly: true },
  readSchoolInvoice: { sql: 'SELECT hon.read_saas_school_invoice($1,$2::uuid,$3::uuid) AS data', arity: 3, readOnly: true },
  readSchoolAccessStanding: { sql: 'SELECT hon.read_saas_school_access_standing($1,$2::uuid) AS data', arity: 2, readOnly: true },
  readAccessReadiness: { sql: 'SELECT hon.read_saas_access_readiness_from_hq($1,$2::uuid) AS data', arity: 2, readOnly: true },
  readOrganizationAccess: { sql: 'SELECT hon.read_saas_organization_access_from_hq($1,$2::uuid) AS data', arity: 2, readOnly: true },
  awaitFirstPayment: { sql: 'SELECT hon.place_saas_organization_awaiting_payment($1,$2::uuid,$3::jsonb,$4::uuid,$5::uuid,$6::uuid) AS data', arity: 6, readOnly: false },
  retryFirstPaymentActivation: { sql: 'SELECT hon.retry_saas_first_payment_activation($1,$2::uuid,$3::jsonb,$4::uuid,$5::uuid,$6::uuid) AS data', arity: 6, readOnly: false },
  // D9 HQ-owner access exceptions (0185): time-limited free access for testing, demos and approved pilots; never credits.
  readAiUnknownInvocations: { sql: 'SELECT hon.read_ai_unknown_invocations_from_hq($1) AS data', arity: 1, readOnly: true },
  readAiSchoolUsage: { sql: 'SELECT hon.read_ai_school_usage_from_hq($1,$2::timestamptz,$3::timestamptz) AS data', arity: 3, readOnly: true },
  resolveAiUnknownInvocation: { sql: 'SELECT hon.resolve_ai_unknown_invocation($1,$2,$3::uuid,$4::jsonb,$5::uuid,$6::uuid,$7::uuid) AS data', arity: 7, readOnly: false },
  recordAiLateProviderExpense: { sql: 'SELECT hon.record_ai_late_provider_expense($1,$2,$3::uuid,$4::jsonb,$5::uuid,$6::uuid,$7::uuid) AS data', arity: 7, readOnly: false },
  readAiSpendPauses: { sql: 'SELECT hon.read_ai_spend_pauses_from_hq($1) AS data', arity: 1, readOnly: true },
  commandAiSpendPause: { sql: 'SELECT hon.command_ai_spend_pause($1,$2::jsonb,$3::uuid) AS data', arity: 3, readOnly: false },
  readAccessExceptions: { sql: 'SELECT hon.read_saas_access_exceptions_from_hq($1,$2::uuid) AS data', arity: 2, readOnly: true },
  grantAccessException: { sql: 'SELECT hon.grant_saas_access_exception($1,$2::uuid,$3::jsonb,$4::uuid,$5::uuid,$6::uuid) AS data', arity: 6, readOnly: false },
  revokeAccessException: { sql: 'SELECT hon.revoke_saas_access_exception($1,$2::uuid,$3::jsonb,$4::uuid,$5::uuid,$6::uuid) AS data', arity: 6, readOnly: false },
  closeExpiredAccessExceptions: { sql: 'SELECT hon.close_expired_saas_access_exceptions($1,$2::uuid,$3::uuid,$4::uuid) AS data', arity: 4, readOnly: false },
  readTrialGovernance: { sql: 'SELECT hon.read_saas_trial_governance($1) AS data', arity: 1, readOnly: true },
  readTrialCampaign: { sql: 'SELECT hon.read_saas_trial_campaign($1,$2::uuid) AS data', arity: 2, readOnly: true },
  previewTrialPublication: { sql: 'SELECT hon.preview_saas_trial_publication($1,$2::uuid) AS data', arity: 2, readOnly: true },
  proposeTrialPolicy: { sql: 'SELECT hon.propose_saas_trial_policy($1,$2::jsonb,$3::uuid,$4::uuid,$5::uuid) AS data', arity: 5, readOnly: false },
  decideTrialPolicy: { sql: 'SELECT hon.decide_saas_trial_policy($1,$2::jsonb,$3::uuid,$4::uuid,$5::uuid) AS data', arity: 5, readOnly: false },
  draftTrialCampaign: { sql: 'SELECT hon.draft_saas_trial_campaign($1,$2::jsonb,$3::uuid,$4::uuid,$5::uuid) AS data', arity: 5, readOnly: false },
  publishTrialCampaign: { sql: 'SELECT hon.publish_saas_trial_campaign($1,$2::uuid,$3::jsonb,$4::uuid,$5::uuid,$6::uuid) AS data', arity: 6, readOnly: false },
  withdrawTrialCampaign: { sql: 'SELECT hon.withdraw_saas_trial_campaign($1,$2::uuid,$3::jsonb,$4::uuid,$5::uuid,$6::uuid) AS data', arity: 6, readOnly: false },
  readExceptionPolicy: { sql: 'SELECT hon.read_saas_exception_policy($1) AS data', arity: 1, readOnly: true },
  // B-HQ-1 (0219): read-only HQ overview of every organization's access standing; writes nothing.
  readAccessOverview: { sql: 'SELECT hon.read_saas_access_overview_from_hq($1,$2,$3::timestamptz,$4::uuid,$5::integer) AS data', arity: 5, readOnly: true },
  // C-HQ-3 (0225): read-only HQ detail of one school; names, statuses and counts only.
  readHqSchoolDetail: { sql: 'SELECT hon.read_hq_school_detail_from_hq($1,$2::uuid) AS data', arity: 2, readOnly: true },
  // B-HQ-2 (0232): HQ support records. Reads are read-only; the three commands write only support rows.
  readSupportCases: { sql: 'SELECT hon.read_hq_support_cases($1,$2,$3::uuid,$4::timestamptz,$5::uuid,$6::integer) AS data', arity: 6, readOnly: true },
  readSupportCase: { sql: 'SELECT hon.read_hq_support_case($1,$2::uuid) AS data', arity: 2, readOnly: true },
  readSupportSchools: { sql: 'SELECT hon.read_hq_support_schools($1) AS data', arity: 1, readOnly: true },
  openSupportCase: { sql: 'SELECT hon.open_hq_support_case($1,$2::jsonb,$3::uuid) AS data', arity: 3, readOnly: false },
  addSupportNote: { sql: 'SELECT hon.add_hq_support_note($1,$2::uuid,$3::jsonb,$4::uuid) AS data', arity: 4, readOnly: false },
  changeSupportCase: { sql: 'SELECT hon.change_hq_support_case($1,$2::uuid,$3::jsonb,$4::uuid) AS data', arity: 4, readOnly: false },
  decideExceptionPolicy: { sql: 'SELECT hon.decide_saas_exception_policy($1,$2::jsonb,$3::uuid,$4::uuid,$5::uuid) AS data', arity: 5, readOnly: false },
  // HON OS commercial offers (0181): HQ Pricing & Offers and the school purchaser discovery read; no checkout connection.
  readOfferManagement: { sql: 'SELECT hon.read_saas_offer_management_from_hq($1) AS data', arity: 1, readOnly: true },
  readOfferSet: { sql: 'SELECT hon.read_saas_offer_set_from_hq($1,$2::uuid) AS data', arity: 2, readOnly: true },
  createOfferSetDraft: { sql: 'SELECT hon.create_saas_offer_set_draft($1,$2::jsonb,$3::uuid,$4::uuid,$5::uuid) AS data', arity: 5, readOnly: false },
  reviseOfferSetDraft: { sql: 'SELECT hon.revise_saas_offer_set_draft($1,$2::uuid,$3::jsonb,$4::uuid,$5::uuid,$6::uuid) AS data', arity: 6, readOnly: false },
  discardOfferSetDraft: { sql: 'SELECT hon.discard_saas_offer_set_draft($1,$2::uuid,$3::jsonb,$4::uuid,$5::uuid,$6::uuid) AS data', arity: 6, readOnly: false },
  publishOfferSet: { sql: 'SELECT hon.publish_saas_offer_set($1,$2::uuid,$3::jsonb,$4::uuid,$5::uuid,$6::uuid) AS data', arity: 6, readOnly: false },
  stopOfferSales: { sql: 'SELECT hon.stop_saas_offer_sales($1,$2::uuid,$3::jsonb,$4::uuid,$5::uuid,$6::uuid) AS data', arity: 6, readOnly: false },
  readSchoolHonOsOffers: { sql: 'SELECT hon.read_saas_hon_os_offers_for_school($1,$2::uuid) AS data', arity: 2, readOnly: true },
  createSchoolHonOsCheckout: { sql: 'SELECT hon.create_saas_hon_os_checkout_from_school($1,$2::uuid,$3::jsonb,$4::uuid,$5::uuid,$6::uuid) AS data', arity: 6, readOnly: false },
} as const;
export type SaasBillingOperation = keyof typeof SAAS_BILLING_CALLS;
// Interface language persistence (0171): fixed subject-bound functions; the subject is the verified identity.
const LANGUAGE_CALLS = {
  readMine: { sql: 'SELECT hon.read_my_language_preference($1,$2::uuid) AS data', arity: 2, readOnly: true },
  updateMine: { sql: 'SELECT hon.set_my_language_preference($1,$2::jsonb,$3::uuid,$4::uuid,$5::uuid) AS data', arity: 5, readOnly: false },
  readSchool: { sql: 'SELECT hon.read_school_language_default($1,$2::uuid) AS data', arity: 2, readOnly: true },
  updateSchool: { sql: 'SELECT hon.set_school_language_default($1,$2::uuid,$3::jsonb,$4::uuid,$5::uuid,$6::uuid) AS data', arity: 6, readOnly: false },
} as const;
export type LanguageOperation = keyof typeof LANGUAGE_CALLS;

export type SchoolOwnershipOperation = 'hqRead'|'setPrimary'|'ownerRead';

@Injectable()
export class RuntimeDatabaseService implements OnModuleDestroy {
  private pool: Pool | undefined;
  private postureCheck: Promise<void> | undefined;
  private configurationErrorReported = false;

  isConfigured(): boolean {
    return Boolean(process.env.HON_RUNTIME_DATABASE_URL);
  }

  private getPool(): Pool {
    const connectionString = process.env.HON_RUNTIME_DATABASE_URL;
    if (!connectionString) {
      throw new ServiceUnavailableException({
        type: 'https://hon.example/problems/runtime-database-not-configured',
        title: 'HON runtime database is not configured',
        status: 503,
        code: 'PERSISTENCE_NOT_CONFIGURED',
        detail: 'HON refuses to use the privileged migration connection at runtime.',
      });
    }

    if (!this.pool) {
      let options: PoolConfig;
      try {
        options = runtimePoolOptions(connectionString);
      } catch (error) {
        // Logged once per process so a misconfiguration cannot flood (and bill) the log drain.
        if (!this.configurationErrorReported) emitTelemetry('error', 'database.configuration_invalid', { component: 'runtime-database', ...summarizeError(error) });
        this.configurationErrorReported = true;
        throw new ServiceUnavailableException({
          type: 'https://hon.example/problems/runtime-database-not-configured',
          title: 'HON runtime database is not configured',
          status: 503,
          code: 'PERSISTENCE_NOT_CONFIGURED',
          detail: 'HON requires a verified TLS connection to its runtime database.',
        });
      }
      const pool = new Pool(options);
      // An idle client can fail when the database or pooler restarts. Without a listener the pool's
      // 'error' event would crash the process; the pool already discards the broken client.
      pool.on('error', (error) => emitTelemetry('warn', 'database.idle_client_error', { component: 'runtime-database', ...summarizeError(error) }));
      this.pool = pool;
    }
    return this.pool;
  }

  async probe(): Promise<void> {
    await this.assertRuntimePosture();
    await this.getPool().query('SELECT 1');
  }

  async submitKioskHandoff(terminalSession: string, claim: string): Promise<void> {
    await this.assertRuntimePosture();
    const client = await this.getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'; SET LOCAL log_parameter_max_length_on_error=0");
      const logging = await client.query<{ safe: boolean }>("SELECT current_setting('log_parameter_max_length')='0' safe");
      if (logging.rows[0]?.safe !== true) throw new Error('KIOSK_UNAVAILABLE');
      await client.query('SELECT hon.submit_kiosk_handoff($1,$2)', [terminalSession,claim]);
      await client.query('COMMIT');
    } catch {
      await client.query('ROLLBACK');
      throw new Error('KIOSK_UNAVAILABLE');
    } finally { client.release(); }
  }

  private async assertRuntimePosture(): Promise<void> {
    this.postureCheck ??= (async () => {
      const result = await this.getPool().query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
      );
      const role = result.rows[0];
      if (!role || role.rolsuper || role.rolbypassrls) {
        throw new ServiceUnavailableException({
          type: 'https://hon.example/problems/runtime-database-role-unsafe',
          title: 'HON runtime database role is unsafe',
          status: 503,
          code: 'PERSISTENCE_NOT_CONFIGURED',
          detail: 'HON requires a non-superuser PostgreSQL role without BYPASSRLS for runtime data access.',
        });
      }
    })();
    try {
      await this.postureCheck;
    } catch (error) {
      this.postureCheck = undefined;
      throw error;
    }
  }

  /** Dashboard-only default. No selector, principal metadata, or candidate list. */
  async resolveCurrentStaffReportingScope(externalSubject: string): Promise<ResolvedStaffReportingScope | undefined> {
    await this.assertRuntimePosture();
    const result = await this.getPool().query<ResolvedStaffReportingScope>(
      'SELECT organization_id AS "organizationId", school_id AS "schoolId" FROM hon.resolve_current_staff_reporting_scope($1)',
      [externalSubject],
    );
    if (result.rows.length !== 1) return undefined;
    const scope = result.rows[0]!;
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (Object.keys(scope).length !== 2 || typeof scope.organizationId !== 'string' || typeof scope.schoolId !== 'string'
      || !uuid.test(scope.organizationId) || !uuid.test(scope.schoolId)) {
      throw new ServiceUnavailableException('Current staff reporting scope is unavailable.');
    }
    return { organizationId: scope.organizationId, schoolId: scope.schoolId };
  }

  /** Dashboard-only subject read. No tenant GUC, caller selector or table query. */
  async readStaffReportingSchools(externalSubject: string): Promise<StaffReportingSchoolChoice[]> {
    await this.assertRuntimePosture();
    const client = await this.getPool().connect();
    try {
      await client.query('BEGIN READ ONLY');
      await client.query("SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'; SET LOCAL log_parameter_max_length_on_error=0");
      const posture = await client.query<{ safe: boolean }>(`SELECT current_user = 'hon_runtime'
        AND NOT (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication)
        AND NOT EXISTS (SELECT 1 FROM pg_auth_members WHERE member = pg_roles.oid) AS safe
        FROM pg_roles WHERE rolname = current_user`);
      if (posture.rows[0]?.safe !== true) throw new ServiceUnavailableException('Staff reporting schools are unavailable.');
      const result = await client.query<StaffReportingSchoolChoice>(
        'SELECT organization_id AS "organizationId", school_id AS "schoolId", organization_name AS "organizationName", school_name AS "schoolName" FROM hon.read_staff_reporting_schools($1)',
        [externalSubject],
      );
      const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      const unsafeName = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u;
      const safeName = (value: unknown): value is string => typeof value === 'string' && value.length > 0
        && Array.from(value).length <= 120 && value.trim() === value && !unsafeName.test(value);
      const seen = new Set<string>();
      if (result.rows.length === 1 || result.rows.length > 20) throw new ServiceUnavailableException('Staff reporting schools are unavailable.');
      const schools = result.rows.map((school) => {
        if (Object.keys(school).length !== 4 || typeof school.organizationId !== 'string' || typeof school.schoolId !== 'string'
          || !uuid.test(school.organizationId) || !uuid.test(school.schoolId)
          || !safeName(school.organizationName) || !safeName(school.schoolName) || seen.has(school.schoolId.toLowerCase())) {
          throw new ServiceUnavailableException('Staff reporting schools are unavailable.');
        }
        seen.add(school.schoolId.toLowerCase());
        return { organizationId: school.organizationId.toLowerCase(), schoolId: school.schoolId.toLowerCase(),
          organizationName: school.organizationName, schoolName: school.schoolName };
      });
      await client.query('COMMIT');
      return schools;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async resolveOwnerLaunchScope(externalSubject: string): Promise<ResolvedPrincipalScope | undefined> {
    await this.assertRuntimePosture();
    return (await this.getPool().query<ResolvedPrincipalScope>('SELECT principal_id AS "principalId", organization_id AS "organizationId", school_id AS "schoolId" FROM hon.resolve_owner_launch_scope($1)', [externalSubject])).rows[0];
  }

  async ownerLaunchCommand(context: import('@hon/contracts').OwnerLaunchContext, input?: import('@hon/contracts').RegisterStudentInput): Promise<unknown> {
    return this.withTenantTransaction(context, async client => {
      await client.query("SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'; SET LOCAL log_parameter_max_length_on_error=0");
      await client.query("SELECT set_config('app.hon_source',$1,true),set_config('app.hon_external_subject',$2,true),set_config('app.hon_action_request_id',$3,true),set_config('app.hon_delegated_by_principal_id',$4,true)", [context.source, context.externalSubject, context.actionRequestId ?? '', context.delegatedByPrincipalId ?? '']);
      if (!input) return (await client.query<{ data: unknown }>('SELECT hon.read_owner_launch($1) data', [context.externalSubject])).rows[0]!.data;
      return (await client.query<{ data: unknown }>('SELECT hon.register_owner_launch_student($1,$2::jsonb,$3,$4::uuid,$5::uuid) data', [context.externalSubject, JSON.stringify(input), context.idempotencyKey, context.requestId, context.correlationId])).rows[0]!.data;
    });
  }

  /** Fixed selector-free owner receipt confirmation; it never reads a caller-selected student or school. */
  async readOwnerLaunchSavedStudents(context: import('@hon/contracts').OwnerLaunchContext): Promise<unknown> {
    return this.withTenantTransaction(context, async client => {
      await client.query("SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'; SET LOCAL log_parameter_max_length_on_error=0");
      await client.query("SELECT set_config('app.hon_source',$1,true),set_config('app.hon_external_subject',$2,true),set_config('app.hon_action_request_id',$3,true),set_config('app.hon_delegated_by_principal_id',$4,true)", [context.source, context.externalSubject, context.actionRequestId ?? '', context.delegatedByPrincipalId ?? '']);
      return (await client.query<{ data: unknown }>('SELECT hon.read_owner_launch_saved_students($1) data', [context.externalSubject])).rows[0]!.data;
    });
  }

  /** Selector-free confirmation. Ordinary transaction supports existing IAM SHARE locks; zero writes. */
  async readOwnerLaunchFirstClassBookingContext(context: import('@hon/contracts').OwnerLaunchContext): Promise<unknown> {
    return this.withTenantTransaction(context, async client => {
      await client.query("SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'; SET LOCAL log_parameter_max_length_on_error=0");
      await client.query("SELECT set_config('app.hon_source',$1,true),set_config('app.hon_external_subject',$2,true),set_config('app.hon_action_request_id',$3,true),set_config('app.hon_delegated_by_principal_id',$4,true)", [context.source,context.externalSubject,context.actionRequestId ?? '',context.delegatedByPrincipalId ?? '']);
      return (await client.query<{data:unknown}>('SELECT hon.read_owner_launch_first_class_booking_context($1) data', [context.externalSubject])).rows[0]!.data;
    });
  }

  /** Fixed selector-free current DRAFT confirmation, no table access or command side effect. */
  async readOwnerLaunchMembershipDraft(context: import('@hon/contracts').OwnerLaunchContext): Promise<unknown> {
    return this.withTenantTransaction(context, async client => {
      await client.query("SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'; SET LOCAL log_parameter_max_length_on_error=0");
      await client.query("SELECT set_config('app.hon_source',$1,true),set_config('app.hon_external_subject',$2,true),set_config('app.hon_action_request_id',$3,true),set_config('app.hon_delegated_by_principal_id',$4,true)", [context.source,context.externalSubject,context.actionRequestId ?? '',context.delegatedByPrincipalId ?? '']);
      return (await client.query<{data:unknown}>('SELECT hon.read_owner_launch_membership_draft($1) data', [context.externalSubject])).rows[0]!.data;
    });
  }

  /** Fixed receipt-only owner-launch booking wrapper; no client student/class/program/school selector reaches SQL. */
  async bookOwnerLaunchFirstClass(context: import('@hon/contracts').OwnerLaunchContext, input: import('@hon/contracts').BookOwnerLaunchFirstClassInput): Promise<unknown> {
    return this.withTenantTransaction(context, async client => {
      await client.query("SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'; SET LOCAL log_parameter_max_length_on_error=0");
      await client.query("SELECT set_config('app.hon_source',$1,true),set_config('app.hon_external_subject',$2,true),set_config('app.hon_action_request_id',$3,true),set_config('app.hon_delegated_by_principal_id',$4,true)", [context.source, context.externalSubject, context.actionRequestId ?? '', context.delegatedByPrincipalId ?? '']);
      return (await client.query<{ data: unknown }>('SELECT hon.book_owner_launch_first_class($1,$2::jsonb,$3,$4::uuid,$5::uuid) data', [context.externalSubject, JSON.stringify(input), context.idempotencyKey, context.requestId, context.correlationId])).rows[0]!.data;
    });
  }

  /** Fixed receipt-only DRAFT command; canonical writes and evidence are wholly database-owned. */
  async draftOwnerLaunchMembership(context: import('@hon/contracts').OwnerLaunchContext, input: import('@hon/contracts').DraftOwnerLaunchMembershipInput): Promise<unknown> {
    return this.withTenantTransaction(context, async client => {
      await client.query("SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'; SET LOCAL log_parameter_max_length_on_error=0");
      await client.query("SELECT set_config('app.hon_source',$1,true),set_config('app.hon_external_subject',$2,true),set_config('app.hon_action_request_id',$3,true),set_config('app.hon_delegated_by_principal_id',$4,true)", [context.source,context.externalSubject,context.actionRequestId ?? '',context.delegatedByPrincipalId ?? '']);
      return (await client.query<{data:unknown}>('SELECT hon.draft_owner_launch_membership($1,$2::jsonb,$3,$4::uuid,$5::uuid) data', [context.externalSubject,JSON.stringify(input),context.idempotencyKey,context.requestId,context.correlationId])).rows[0]!.data;
    });
  }

  async ownerLaunchGuardianChildCommand(context: import('@hon/contracts').OwnerLaunchContext, input: import('@hon/contracts').RegisterGuardianChildInput): Promise<unknown> {
    return this.withTenantTransaction(context, async client => {
      await client.query("SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'; SET LOCAL log_parameter_max_length_on_error=0");
      await client.query("SELECT set_config('app.hon_source',$1,true),set_config('app.hon_external_subject',$2,true),set_config('app.hon_action_request_id',$3,true),set_config('app.hon_delegated_by_principal_id',$4,true)", [context.source,context.externalSubject,context.actionRequestId ?? '',context.delegatedByPrincipalId ?? '']);
      return (await client.query<{data:unknown}>('SELECT hon.register_owner_launch_guardian_child($1,$2::jsonb,$3,$4::uuid,$5::uuid) data', [context.externalSubject,JSON.stringify(input),context.idempotencyKey,context.requestId,context.correlationId])).rows[0]!.data;
    });
  }

  async resolveAuthorizedScope(
    externalSubject: string,
    schoolId: string,
    permissionCode: string,
  ): Promise<ResolvedPrincipalScope | undefined> {
    await this.assertRuntimePosture();
    const result = await this.getPool().query<ResolvedPrincipalScope>(
      `SELECT
         principal_id AS "principalId",
         organization_id AS "organizationId",
         school_id AS "schoolId"
       FROM hon.resolve_authorized_scope($1, $2::uuid, $3)`,
      [externalSubject, schoolId, permissionCode],
    );
    return result.rows[0];
  }

  async readA2pPreparationScope(context: ResolvedPrincipalScope & {externalSubject:string;principalType:'HUMAN_USER';requestId:string}): Promise<(ResolvedPrincipalScope & {schoolName:string;canConfirmOwnerFacts:boolean}) | null> {
    return this.withTenantReadOnlyTransaction(context, async client => {
      await client.query("SET LOCAL statement_timeout='3s'; SET LOCAL lock_timeout='1s'; SET LOCAL log_parameter_max_length_on_error=0");
      await client.query("SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_external_subject',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)",[context.externalSubject]);
      return (await client.query<{data:ResolvedPrincipalScope & {schoolName:string;canConfirmOwnerFacts:boolean}}>('SELECT hon.read_a2p_preparation_scope($1) data',[context.externalSubject])).rows[0]?.data ?? null;
    });
  }

  async resolvePlannedAbsenceReviewScope(externalSubject: string): Promise<ResolvedPrincipalScope | undefined> {
    await this.assertRuntimePosture();
    const result = await this.getPool().query<ResolvedPrincipalScope>(
      'SELECT principal_id AS "principalId", organization_id AS "organizationId", school_id AS "schoolId" FROM hon.resolve_planned_absence_review_scope($1)', [externalSubject],
    );
    if (result.rows.length !== 1) return undefined;
    const scope = result.rows[0]!;
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (Object.keys(scope).length !== 3 || ![scope.principalId, scope.organizationId, scope.schoolId].every(value => typeof value === 'string' && uuid.test(value))) throw new ServiceUnavailableException('Planned absence review scope unavailable.');
    return scope;
  }

  async readPlannedAbsenceReviewQueue(context: import('@hon/contracts').PlannedAbsenceReviewContext): Promise<unknown> {
    return this.withTenantReadOnlyTransaction(context, async client => {
      await client.query("SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'; SET LOCAL log_parameter_max_length_on_error=0");
      await client.query("SELECT set_config('app.hon_source',$1,true),set_config('app.hon_external_subject',$2,true),set_config('app.hon_action_request_id',$3,true),set_config('app.hon_delegated_by_principal_id',$4,true)", [context.source, context.externalSubject, context.actionRequestId ?? '', context.delegatedByPrincipalId ?? '']);
      const result = await client.query<{ data: unknown }>('SELECT hon.read_staff_planned_absence_review_queue($1) data', [context.externalSubject]);
      if (result.rows.length !== 1) throw new ServiceUnavailableException('Planned absence review queue unavailable.');
      return result.rows[0]!.data;
    });
  }

  async resolvePublicFormScope(externalSubject: string, permission: string): Promise<ResolvedPrincipalScope | undefined> {
    await this.assertRuntimePosture();
    return (await this.getPool().query<ResolvedPrincipalScope>(
      'SELECT principal_id AS "principalId", organization_id AS "organizationId", school_id AS "schoolId" FROM hon.resolve_public_form_scope($1,$2)', [externalSubject, permission],
    )).rows[0];
  }
  async readPublishedLeadForm(publicId: string): Promise<import('@hon/contracts').PublishedLeadForm | null> {
    await this.assertRuntimePosture();
    return (await this.getPool().query<{ data: import('@hon/contracts').PublishedLeadForm | null }>('SELECT hon.read_published_form($1) data', [publicId])).rows[0]!.data;
  }
  async submitPublishedLeadForm(publicId: string, input: object, key: string): Promise<string> {
    await this.assertRuntimePosture();
    const client = await this.getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'");
      const result = await client.query<{ result: string }>('SELECT hon.submit_public_form($1,$2::jsonb,$3) result', [publicId, JSON.stringify(input), key]);
      await client.query('COMMIT');
      return result.rows[0]!.result;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  async resolveHumanWorkScope(externalSubject: string): Promise<ResolvedPrincipalScope | undefined> {
    await this.assertRuntimePosture();
    return (await this.getPool().query<ResolvedPrincipalScope>(
      'SELECT principal_id AS "principalId", organization_id AS "organizationId", school_id AS "schoolId" FROM hon.resolve_human_work_scope($1)', [externalSubject],
    )).rows[0];
  }
  async resolveFollowUpScope(externalSubject: string): Promise<ResolvedPrincipalScope | undefined> {
    await this.assertRuntimePosture();
    const result = await this.getPool().query<ResolvedPrincipalScope>(
      'SELECT principal_id AS "principalId", organization_id AS "organizationId", school_id AS "schoolId" FROM hon.resolve_follow_up_scope($1)', [externalSubject],
    );
    return result.rows[0];
  }
  async resolveCrmLeadCloseScope(externalSubject: string, schoolId: string): Promise<ResolvedPrincipalScope | undefined> {
    await this.assertRuntimePosture();
    return (await this.getPool().query<ResolvedPrincipalScope>(
      'SELECT principal_id AS "principalId", organization_id AS "organizationId", school_id AS "schoolId" FROM hon.resolve_crm_lead_close_scope($1,$2::uuid)',
      [externalSubject, schoolId],
    )).rows[0];
  }
  async resolveCrmLeadRegistrationScope(externalSubject: string, schoolId: string): Promise<ResolvedPrincipalScope | undefined> {
    await this.assertRuntimePosture();
    return (await this.getPool().query<ResolvedPrincipalScope>(
      'SELECT principal_id AS "principalId", organization_id AS "organizationId", school_id AS "schoolId" FROM hon.resolve_crm_lead_registration_scope($1,$2::uuid)',
      [externalSubject, schoolId],
    )).rows[0];
  }
  async resolveChadFollowUpAssistantScope(externalSubject: string): Promise<ResolvedPrincipalScope | undefined> {
    await this.assertRuntimePosture();
    return (await this.getPool().query<ResolvedPrincipalScope>(
      'SELECT principal_id AS "principalId", organization_id AS "organizationId", school_id AS "schoolId" FROM hon.resolve_chad_follow_up_scope($1)', [externalSubject],
    )).rows[0];
  }
  async resolveMarketplaceScope(externalSubject: string, schoolId: string): Promise<ResolvedPrincipalScope | undefined> {
    await this.assertRuntimePosture();
    return (await this.getPool().query<ResolvedPrincipalScope>(
      'SELECT principal_id AS "principalId", organization_id AS "organizationId", school_id AS "schoolId" FROM hon.resolve_marketplace_scope($1,$2::uuid)', [externalSubject, schoolId],
    )).rows[0];
  }
  async resolveAchievementScope(externalSubject: string, schoolId: string): Promise<ResolvedPrincipalScope | undefined> {
    await this.assertRuntimePosture();
    return (await this.getPool().query<ResolvedPrincipalScope>(
      'SELECT principal_id AS "principalId", organization_id AS "organizationId", school_id AS "schoolId" FROM hon.resolve_achievement_scope($1,$2::uuid)', [externalSubject, schoolId],
    )).rows[0];
  }
  async resolveTeachingStudioScope(externalSubject: string, schoolId: string): Promise<ResolvedPrincipalScope | undefined> {
    await this.assertRuntimePosture();
    return (await this.getPool().query<ResolvedPrincipalScope>(
      'SELECT principal_id AS "principalId", organization_id AS "organizationId", school_id AS "schoolId" FROM hon.resolve_teaching_studio_scope($1,$2::uuid)', [externalSubject, schoolId],
    )).rows[0];
  }
  /** Claire has no client school selector; SQL returns only one live eligible staff scope. */
  async resolveTeachingAssistantScope(externalSubject: string): Promise<ResolvedPrincipalScope | undefined> {
    await this.assertRuntimePosture();
    return (await this.getPool().query<ResolvedPrincipalScope>(
      'SELECT principal_id AS "principalId", organization_id AS "organizationId", school_id AS "schoolId" FROM hon.resolve_teaching_assistant_scope($1)', [externalSubject],
    )).rows[0];
  }
  async resolveRetentionReviewScope(externalSubject: string, schoolId: string): Promise<ResolvedPrincipalScope | undefined> {
    await this.assertRuntimePosture();
    return (await this.getPool().query<ResolvedPrincipalScope>(
      'SELECT principal_id AS "principalId", organization_id AS "organizationId", school_id AS "schoolId" FROM hon.resolve_retention_review_scope($1,$2::uuid)', [externalSubject, schoolId],
    )).rows[0];
  }
  async resolveTestingCertificateScope(externalSubject: string, schoolId: string): Promise<ResolvedPrincipalScope | undefined> {
    await this.assertRuntimePosture();
    return (await this.getPool().query<ResolvedPrincipalScope>(
      'SELECT principal_id AS "principalId", organization_id AS "organizationId", school_id AS "schoolId" FROM hon.resolve_testing_certificate_scope($1,$2::uuid)', [externalSubject, schoolId],
    )).rows[0];
  }
  async resolveTestingScorecardScope(externalSubject: string, schoolId: string): Promise<ResolvedPrincipalScope | undefined> {
    await this.assertRuntimePosture();
    return (await this.getPool().query<ResolvedPrincipalScope>(
      'SELECT principal_id AS "principalId", organization_id AS "organizationId", school_id AS "schoolId" FROM hon.resolve_testing_scorecard_scope($1,$2::uuid)', [externalSubject, schoolId],
    )).rows[0];
  }
  async resolveCommunityScope(externalSubject: string, schoolId: string): Promise<ResolvedPrincipalScope | undefined> {
    await this.assertRuntimePosture();
    return (await this.getPool().query<ResolvedPrincipalScope>(
      'SELECT principal_id AS "principalId", organization_id AS "organizationId", school_id AS "schoolId" FROM hon.resolve_community_scope($1,$2::uuid)', [externalSubject, schoolId],
    )).rows[0];
  }
  async resolveRenewalScope(externalSubject: string): Promise<ResolvedPrincipalScope | undefined> {
    await this.assertRuntimePosture();
    return (await this.getPool().query<ResolvedPrincipalScope>(
      'SELECT principal_id AS "principalId", organization_id AS "organizationId", school_id AS "schoolId" FROM hon.resolve_renewal_scope($1)', [externalSubject],
    )).rows[0];
  }
  async resolveAutomationRuleScope(externalSubject: string, permission: string): Promise<ResolvedPrincipalScope | undefined> {
    await this.assertRuntimePosture();
    return (await this.getPool().query<ResolvedPrincipalScope>(
      'SELECT principal_id AS "principalId", organization_id AS "organizationId", school_id AS "schoolId" FROM hon.resolve_automation_rule_scope($1,$2)', [externalSubject, permission],
    )).rows[0];
  }

  async resolveStaffAvailabilityScope(externalSubject: string, permission: string): Promise<ResolvedPrincipalScope | undefined> {
    await this.assertRuntimePosture();
    return (await this.getPool().query<ResolvedPrincipalScope>(
      'SELECT principal_id AS "principalId", organization_id AS "organizationId", school_id AS "schoolId" FROM hon.resolve_staff_availability_scope($1,$2)',
      [externalSubject, permission],
    )).rows[0];
  }

  /** Fixed direct-human workforce scope; the database rejects ambiguous school scope. */
  async resolveInstructorQualificationScope(externalSubject: string): Promise<ResolvedPrincipalScope | undefined> {
    await this.assertRuntimePosture();
    return (await this.getPool().query<ResolvedPrincipalScope>(
      'SELECT principal_id AS "principalId", organization_id AS "organizationId", school_id AS "schoolId" FROM hon.resolve_instructor_qualification_scope($1)',
      [externalSubject],
    )).rows[0];
  }

  async resolveCampaignScope(externalSubject: string, permission: string): Promise<ResolvedPrincipalScope | undefined> {
    await this.assertRuntimePosture();
    return (await this.getPool().query<ResolvedPrincipalScope>(
      'SELECT principal_id AS "principalId", organization_id AS "organizationId", school_id AS "schoolId" FROM hon.resolve_campaign_scope($1,$2)',
      [externalSubject, permission],
    )).rows[0];
  }
  async resolveLeadImportScope(externalSubject: string, permission: string): Promise<ResolvedPrincipalScope | undefined> {
    await this.assertRuntimePosture();
    return (await this.getPool().query<ResolvedPrincipalScope>(
      'SELECT principal_id AS "principalId", organization_id AS "organizationId", school_id AS "schoolId" FROM hon.resolve_lead_import_scope($1,$2)',
      [externalSubject,permission],
    )).rows[0];
  }

  async readOrganizationOperationsSummary(
    externalSubject: string, organizationId: string, from: string, to: string,
  ): Promise<OrganizationOperationsSummary> {
    await this.assertRuntimePosture();
    // One read-only statement: IAM, entitlement, school set and metrics use the
    // same database snapshot. Never widen school RLS or set an organization GUC.
    const result = await this.getPool().query<{ data: OrganizationOperationsSummary }>(
      'SELECT hon.read_organization_operations_summary($1, $2::uuid, $3::timestamptz, $4::timestamptz) AS data',
      [externalSubject, organizationId, from, to],
    );
    const row = result.rows[0];
    if (!row) throw new Error('HON operations summary projection did not return a result.');
    return row.data;
  }

  async readSchoolCommandCenter(
    externalSubject: string, organizationId: string, schoolId: string,
  ): Promise<SchoolCommandCenterProjection> {
    await this.assertRuntimePosture();
    // The fixed SECURITY DEFINER projection independently resolves the verified
    // human, selected school, exact reporting.view, and live entitlement. Do not
    // establish caller-controlled tenant/principal GUCs for this aggregate read.
    const result = await this.getPool().query<{ data: SchoolCommandCenterProjection }>(
      'SELECT hon.read_school_command_center($1,$2::uuid,$3::uuid) AS data',
      [externalSubject, organizationId, schoolId],
    );
    const row = result.rows[0];
    if (!row) throw new Error('HON Command Center projection did not return a result.');
    return row.data;
  }

  async readSchoolHealthScore(
    externalSubject: string, organizationId: string, schoolId: string,
  ): Promise<SchoolHealthScoreProjection> {
    await this.assertRuntimePosture();
    // This fixed SECURITY DEFINER projection independently resolves verified
    // human/school/reporting/tier authority. Selectors never become caller GUCs.
    const result = await this.getPool().query<{ data: SchoolHealthScoreProjection }>(
      'SELECT hon.read_school_health_score($1,$2::uuid,$3::uuid) AS data',
      [externalSubject, organizationId, schoolId],
    );
    const row = result.rows[0];
    if (!row) throw new Error('HON School Health Score projection did not return a result.');
    return row.data;
  }

  private async retentionAttentionTransaction(context: RetentionReviewSignalsContext, readOnly: boolean, work: (client: PoolClient) => Promise<unknown>): Promise<unknown> {
    const scopedWork = async (client: PoolClient) => {
      await client.query("SELECT set_config('app.hon_source',$1,true),set_config('app.hon_external_subject',$2,true),set_config('app.hon_action_request_id',$3,true),set_config('app.hon_delegated_by_principal_id',$4,true)", [context.source, context.externalSubject, context.actionRequestId ?? '', context.delegatedByPrincipalId ?? '']);
      await client.query("SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'");
      return work(client);
    };
    // PostgreSQL must enter READ ONLY before any context-setting statement. The
    // fixed helper establishes tenant GUCs and checks context only after BEGIN
    // READ ONLY; the attention-specific source/subject GUCs follow inside that
    // same transaction. Command paths retain the ordinary write boundary.
    return readOnly
      ? this.withTenantReadOnlyTransaction(context, scopedWork)
      : this.withTenantTransaction(context, scopedWork);
  }
  async readRetentionAttentionAlerts(context: RetentionReviewSignalsContext, membershipId: string): Promise<unknown> {
    return this.retentionAttentionTransaction(context, true, async client => (await client.query('SELECT hon.read_retention_attention_alerts($1,$2::uuid) AS data', [context.externalSubject, membershipId])).rows[0]?.data);
  }
  async readRetentionAttentionEvidence(context: RetentionReviewSignalsContext, membershipId: string): Promise<unknown> {
    return this.retentionAttentionTransaction(context, true, async client => (await client.query('SELECT hon.read_retention_attention_evidence($1,$2::uuid) AS data', [context.externalSubject, membershipId])).rows[0]?.data);
  }
  async recordRetentionAttentionAlert(context: RetentionReviewSignalsContext, membershipId: string, input: import('@hon/contracts').RetentionAttentionRecordInput): Promise<unknown> {
    return this.retentionAttentionTransaction(context, false, async client => (await client.query('SELECT hon.record_retention_attention_alert($1,$2::uuid,$3,$4,$5::timestamptz,$6,$7::uuid,$8::uuid,$9::uuid) AS data', [context.externalSubject, membershipId, input.evidenceVersion, input.evidenceFingerprint, input.observedAt, input.evidenceCode, input.idempotencyKey, context.requestId, context.correlationId])).rows[0]?.data);
  }
  async resolveRetentionAttentionAlert(context: RetentionReviewSignalsContext, membershipId: string, input: import('@hon/contracts').RetentionAttentionResolutionInput): Promise<unknown> {
    return this.retentionAttentionTransaction(context, false, async client => (await client.query('SELECT hon.resolve_retention_attention_alert($1,$2::uuid,$3::uuid,$4::integer,$5,$6::uuid,$7::uuid,$8::uuid) AS data', [context.externalSubject, membershipId, input.alertId, input.expectedAlertVersion, input.resolutionReason, input.idempotencyKey, context.requestId, context.correlationId])).rows[0]?.data);
  }

  async readRetentionReviewAcknowledgementEvidence(context: RetentionReviewSignalsContext, membershipId: string): Promise<unknown> {
    return this.withTenantTransaction(context, async client => {
      await client.query("SELECT set_config('app.hon_source',$1,true),set_config('app.hon_external_subject',$2,true),set_config('app.hon_action_request_id',$3,true),set_config('app.hon_delegated_by_principal_id',$4,true)", [context.source, context.externalSubject, context.actionRequestId ?? '', context.delegatedByPrincipalId ?? '']);
      await client.query("SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'; SET TRANSACTION READ ONLY");
      return (await client.query('SELECT hon.read_retention_review_acknowledgement_evidence($1,$2::uuid) AS data', [context.externalSubject, membershipId])).rows[0]?.data;
    });
  }
  async acknowledgeRetentionReviewEvidence(context: RetentionReviewSignalsContext, membershipId: string, input: { evidenceVersion: string; evidenceFingerprint: string; observedAt: string; idempotencyKey: string }): Promise<unknown> {
    return this.withTenantTransaction(context, async client => {
      await client.query("SELECT set_config('app.hon_source',$1,true),set_config('app.hon_external_subject',$2,true),set_config('app.hon_action_request_id',$3,true),set_config('app.hon_delegated_by_principal_id',$4,true)", [context.source, context.externalSubject, context.actionRequestId ?? '', context.delegatedByPrincipalId ?? '']);
      await client.query("SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'");
      return (await client.query('SELECT hon.acknowledge_retention_review_evidence($1,$2::uuid,$3,$4,$5::timestamptz,$6::uuid,$7::uuid,$8::uuid) AS data', [context.externalSubject, membershipId, input.evidenceVersion, input.evidenceFingerprint, input.observedAt, input.idempotencyKey, context.requestId, context.correlationId])).rows[0]?.data;
    });
  }

  async readRetentionReviewSignals(
    context: RetentionReviewSignalsContext, membershipId: string,
  ): Promise<RetentionReviewSignals> {
    return this.withTenantTransaction(context, async client => {
      await client.query("SELECT set_config('app.hon_source',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)", [context.source]);
      await client.query("SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'; SET TRANSACTION READ ONLY");
      const result = await client.query<{ data: RetentionReviewSignals }>(
        'SELECT hon.read_retention_review_signals($1,$2::uuid) AS data', [context.externalSubject, membershipId],
      );
      if (!result.rows[0]) throw new Error('HON Retention Review Signals projection did not return a result.');
      return result.rows[0].data;
    });
  }

  async readTestingCertificate(
    context: TestingCertificateRuntimeContext, testingCandidateId: string,
  ): Promise<unknown> {
    return this.withTenantTransaction(context, async client => {
      await client.query("SELECT set_config('app.hon_source',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)", [context.source]);
      await client.query("SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'");
      const result = await client.query<{ data: unknown }>(
        'SELECT hon.read_testing_certificate($1,$2::uuid) AS data', [context.externalSubject, testingCandidateId],
      );
      if (!result.rows[0]) throw new Error('HON testing certificate projection did not return a result.');
      return result.rows[0].data;
    });
  }

  async issueTestingCertificate(
    context: TestingCertificateRuntimeContext, testingCandidateId: string, input: object,
  ): Promise<unknown> {
    return this.withTenantTransaction(context, async client => {
      await client.query("SELECT set_config('app.hon_source',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)", [context.source]);
      await client.query("SET LOCAL statement_timeout='15s'; SET LOCAL lock_timeout='5s'");
      const result = await client.query<{ data: unknown }>(
        'SELECT hon.issue_testing_certificate($1,$2::uuid,$3::jsonb,$4,$5::uuid,$6::uuid) AS data',
        [context.externalSubject, testingCandidateId, JSON.stringify(input), context.idempotencyKey, context.requestId, context.correlationId],
      );
      if (!result.rows[0]) throw new Error('HON testing certificate issue did not return a receipt.');
      return result.rows[0].data;
    });
  }

  async readTestingScorecard(
    context: TestingCertificateRuntimeContext, testingCandidateId: string, testingEventId: string,
  ): Promise<unknown> {
    return this.withTenantTransaction(context, async client => {
      await client.query("SELECT set_config('app.hon_source',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)", [context.source]);
      await client.query("SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'; SET TRANSACTION READ ONLY");
      const result = await client.query<{ data: unknown }>(
        'SELECT hon.read_testing_scorecard($1,$2::uuid,$3::uuid) AS data', [context.externalSubject, testingCandidateId, testingEventId],
      );
      if (!result.rows[0]) throw new Error('HON testing scorecard projection did not return a result.');
      return result.rows[0].data;
    });
  }

  async recordTestingScorecardEvaluation(
    context: TestingCertificateRuntimeContext, testingCandidateId: string, testingEventId: string, input: object,
  ): Promise<unknown> {
    return this.withTenantTransaction(context, async client => {
      await client.query("SELECT set_config('app.hon_source',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)", [context.source]);
      await client.query("SET LOCAL statement_timeout='15s'; SET LOCAL lock_timeout='5s'");
      const result = await client.query<{ data: unknown }>(
        'SELECT hon.record_testing_scorecard_evaluation($1,$2::uuid,$3::uuid,$4::jsonb,$5,$6::uuid,$7::uuid) AS data',
        [context.externalSubject, testingCandidateId, testingEventId, JSON.stringify(input), context.idempotencyKey, context.requestId, context.correlationId],
      );
      if (!result.rows[0]) throw new Error('HON testing scorecard record did not return a receipt.');
      return result.rows[0].data;
    });
  }

  async readStaffSearch(externalSubject: string, organizationId: string, schoolId: string,
    q: string, types: StaffSearchKind[], entityId?: string): Promise<StaffSearchResponse> {
    await this.assertRuntimePosture();
    const client = await this.getPool().connect();
    try {
      await client.query('BEGIN READ ONLY');
      await client.query("SET LOCAL statement_timeout = '2000ms'");
      const result = await client.query<{ data: StaffSearchResponse }>(
        'SELECT hon.search_school($1,$2::uuid,$3::uuid,$4,$5::text[],$6::uuid) AS data',
        [externalSubject, organizationId, schoolId, q, types, entityId ?? null],
      );
      await client.query('COMMIT');
      if (!result.rows[0]) throw new Error('HON search projection did not return a result.');
      return result.rows[0].data;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  async resolveHqOperatorScope(
    externalSubject: string,
    permissionCode: string,
  ): Promise<ResolvedHqOperatorScope | undefined> {
    await this.assertRuntimePosture();
    const result = await this.getPool().query<ResolvedHqOperatorScope>(
      `SELECT principal_id AS "principalId", hq_role AS "hqRole"
       FROM hon.resolve_hq_operator_scope($1, $2)`,
      [externalSubject, permissionCode],
    );
    return result.rows[0];
  }

  /**
   * One fixed, selector-free HQ aggregate projection. The database function
   * independently resolves the exact HQ scope; no tenant/principal GUC or
   * caller-provided role is established here. READ ONLY prevents every audit,
   * outbox, work, Action Engine, provider, usage, financial, membership, school,
   * or communication side effect even if a future implementation drifts.
   */
  async readHqPlatformOverview(externalSubject: string): Promise<HqPlatformOverview> {
    await this.assertRuntimePosture();
    const client = await this.getPool().connect();
    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await client.query("SET LOCAL statement_timeout = '5s'; SET LOCAL lock_timeout = '3s'; SET LOCAL log_parameter_max_length_on_error = 0");
      const result = await client.query<{ data: HqPlatformOverview }>(
        'SELECT hon.read_hq_platform_overview($1) AS data',
        [externalSubject],
      );
      await client.query('COMMIT');
      if (!result.rows[0]) throw new Error('HON HQ overview projection did not return a result.');
      return result.rows[0].data;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * One fixed, selector-free HQ customer-account projection. The database
   * independently resolves live HQ authority; the READ ONLY snapshot makes
   * audit, outbox, work, provider, payment, messaging, and domain effects
   * impossible at this boundary.
   */
  async readHqSchoolDirectory(externalSubject: string): Promise<HqSchoolDirectory> {
    await this.assertRuntimePosture();
    const client = await this.getPool().connect();
    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await client.query("SET LOCAL statement_timeout = '5s'; SET LOCAL lock_timeout = '3s'; SET LOCAL log_parameter_max_length_on_error = 0");
      const result = await client.query<{ data: HqSchoolDirectory }>(
        'SELECT hon.read_hq_school_directory($1) AS data',
        [externalSubject],
      );
      await client.query('COMMIT');
      if (!result.rows[0]) throw new Error('HON HQ school-directory projection did not return a result.');
      return result.rows[0].data;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** Minimal subject-only choices; no tenant GUC, table read, or command effect. */
  async readParentPlannedAbsenceRequestContext(externalSubject: string): Promise<unknown> {
    await this.assertRuntimePosture();
    const client = await this.getPool().connect();
    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await client.query("SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'; SET LOCAL log_parameter_max_length_on_error=0");
      const result = await client.query<{ data: unknown }>('SELECT hon.read_parent_planned_absence_request_context($1) AS data', [externalSubject]);
      if (!result.rows[0]) throw new Error('HON parent absence context unavailable.');
      await client.query('COMMIT');
      return result.rows[0].data;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  async resolveParentJourneyScopes(externalSubject: string): Promise<ResolvedParentFamilyScope[]> {
    await this.assertRuntimePosture();
    const result = await this.getPool().query<ResolvedParentFamilyScope>(
      `SELECT principal_id AS "principalId", organization_id AS "organizationId", school_id AS "schoolId",
              family_id AS "familyId", access_level::text AS "accessLevel"
       FROM hon.resolve_parent_journey_scopes($1)`, [externalSubject],
    );
    return result.rows;
  }

  /**
   * The fixed database projection resolves its own exact current guardian-family
   * scope. A repeatable-read, read-only transaction prevents accidental audit,
   * outbox, provider, or billing mutation effects at this boundary.
   */
  async readParentTestingStatus(externalSubject: string): Promise<unknown> {
    await this.assertRuntimePosture();
    const client = await this.getPool().connect();
    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await client.query("SET LOCAL statement_timeout = '5s'; SET LOCAL lock_timeout = '3s'");
      const result = await client.query<{ data: unknown }>(
        'SELECT hon.read_parent_testing_status($1) AS data', [externalSubject],
      );
      await client.query('COMMIT');
      if (!result.rows[0]) throw new Error('HON parent testing status projection did not return a result.');
      return result.rows[0].data;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * The fixed database projection resolves its own exact current guardian-family
   * scope. A repeatable-read, read-only transaction prevents audit, outbox,
   * schedule, attendance, provider, or billing mutation effects at this boundary.
   */
  async readParentPlannedAbsenceHistory(externalSubject: string): Promise<unknown> {
    await this.assertRuntimePosture();
    const client = await this.getPool().connect();
    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await client.query("SET LOCAL statement_timeout = '5s'; SET LOCAL lock_timeout = '3s'");
      const result = await client.query<{ data: unknown }>(
        'SELECT hon.read_parent_planned_absence_history($1) AS data', [externalSubject],
      );
      await client.query('COMMIT');
      if (!result.rows[0]) throw new Error('HON parent planned-absence history projection did not return a result.');
      return result.rows[0].data;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * The fixed projection resolves its own exact current guardian-family scope.
   * Repeatable-read + READ ONLY makes queue, consent, provider, audit, outbox,
   * action, AI, voice, automation, and payment mutation impossible here.
   */
  async readParentMessageHistory(externalSubject: string): Promise<unknown> {
    await this.assertRuntimePosture();
    const client = await this.getPool().connect();
    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await client.query("SET LOCAL statement_timeout = '5s'; SET LOCAL lock_timeout = '3s'");
      const result = await client.query<{ data: unknown }>(
        'SELECT hon.read_parent_message_history($1) AS data', [externalSubject],
      );
      await client.query('COMMIT');
      if (!result.rows[0]) throw new Error('HON parent message-history projection did not return a result.');
      return result.rows[0].data;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * The fixed database projection resolves its own exact current guardian-family
   * scope. A repeatable-read, read-only transaction prevents accidental audit,
   * outbox, provider, or billing mutation effects at this boundary.
   */
  async readParentBillingView(externalSubject: string): Promise<unknown> {
    await this.assertRuntimePosture();
    const client = await this.getPool().connect();
    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await client.query("SET LOCAL statement_timeout = '5s'; SET LOCAL lock_timeout = '3s'");
      const result = await client.query<{ data: unknown }>(
        'SELECT hon.read_parent_billing_view($1) AS data', [externalSubject],
      );
      await client.query('COMMIT');
      if (!result.rows[0]) throw new Error('HON parent billing projection did not return a result.');
      return result.rows[0].data;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** Selector-free, independent live guardian resolver; no tenant GUC or raw table query. */
  async readParentClassPassView(externalSubject: string): Promise<unknown> {
    await this.assertRuntimePosture();
    const client = await this.getPool().connect();
    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await client.query("SET LOCAL statement_timeout = '5s'; SET LOCAL lock_timeout = '3s'");
      const result = await client.query<{ data: unknown }>(
        'SELECT hon.read_parent_classpass_view($1) AS data', [externalSubject],
      );
      await client.query('COMMIT');
      if (!result.rows[0]) throw new Error('HON parent ClassPass projection did not return a result.');
      return result.rows[0].data;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async resolveParentFamilyScopes(externalSubject: string, schoolId: string): Promise<ResolvedParentFamilyScope[]> {
    await this.assertRuntimePosture();
    const result = await this.getPool().query<ResolvedParentFamilyScope>(
      `SELECT principal_id AS "principalId", organization_id AS "organizationId", school_id AS "schoolId",
              family_id AS "familyId", access_level::text AS "accessLevel"
       FROM hon.resolve_parent_family_scope($1, $2::uuid)`,
      [externalSubject, schoolId],
    );
    return result.rows;
  }

  async resolveTestingRegistrationReviewScopes(externalSubject: string): Promise<ResolvedPrincipalScope[]> {
    await this.assertRuntimePosture();
    const result = await this.getPool().query<ResolvedPrincipalScope>(
      `SELECT principal_id AS "principalId", organization_id AS "organizationId", school_id AS "schoolId"
       FROM hon.resolve_testing_registration_review_scopes($1)`, [externalSubject],
    );
    return result.rows;
  }

  async provisionSchoolFromHq(command: HqSchoolProvisioningCommand): Promise<HqSchoolProvisioningResult> {
    await this.assertRuntimePosture();
    const result = await this.getPool().query<{ data: HqSchoolProvisioningResult }>(
      `SELECT hon.provision_school_from_hq_human($1, $2::uuid, $3, $4, $5, $6, $7, $8::hon.plan_tier, $9, $10, $11::uuid, $12::uuid) AS data`,
      [
        command.externalSubject,
        command.expectedPrincipalId,
        command.legalName,
        command.displayName,
        command.schoolName,
        command.schoolSlug,
        command.timezone,
        command.initialTier,
        command.idempotencyKey,
        command.requestFingerprint,
        command.requestId,
        command.correlationId,
      ],
    );
    const provisioned = result.rows[0]?.data;
    if (!provisioned) throw new Error('HON HQ tenant provisioning did not return a result.');
    return provisioned;
  }

  async readAiControlPlaneFromHq(externalSubject: string): Promise<AiControlPlaneSnapshot> {
    await this.assertRuntimePosture();
    const result = await this.getPool().query<{ data: AiControlPlaneSnapshot }>(
      'SELECT hon.hq_ai_control_plane_read($1) AS data', [externalSubject],
    );
    return result.rows[0]!.data;
  }

  /** Separate HQ path: selectors never become tenant context or actor authority. */
  async transitionOrganizationEntitlementFromHq(externalSubject: string, organizationId: string,
    input: HqEntitlementTransitionInput, key: string, fingerprint: string, requestId: string, correlationId: string): Promise<HqEntitlementTransitionReceipt> {
    await this.assertRuntimePosture();
    const client = await this.getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='3s'");
      const result = await client.query<{ data: HqEntitlementTransitionReceipt }>(
        'SELECT hon.transition_organization_entitlement_from_hq($1,$2::uuid,$3,$4::integer,$5::uuid,$6,$7::uuid,$8::uuid) AS data',
        [externalSubject,organizationId,input.targetTier,input.expectedVersion,key,fingerprint,requestId,correlationId]);
      await client.query('COMMIT');
      if (!result.rows[0]) throw new Error('HQ_ENTITLEMENT_UNAVAILABLE');
      return result.rows[0].data;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  async writeAiControlPlaneFromHq(externalSubject: string, kind: AiControlPlaneKind, payload: AiProviderConnectionWrite | AiCatalogEntryWrite | AiRoutingPolicyWrite | AiTaskProfileWrite, idempotencyKey: string, requestId: string): Promise<{ recordId: string; version: number; replayed: boolean }> {
    await this.assertRuntimePosture();
    const result = await this.getPool().query<{ data: { recordId: string; version: number; replayed: boolean } }>(
      'SELECT hon.hq_ai_control_plane_write($1, $2, $3::jsonb, $4::uuid, $5::uuid) AS data',
      [externalSubject, kind, JSON.stringify(payload), idempotencyKey, requestId],
    );
    return result.rows[0]!.data;
  }

  async resolveAiRoutingRegistryFromHq(externalSubject: string, policyId: string): Promise<AiRoutingRegistry> {
    await this.assertRuntimePosture();
    const result = await this.getPool().query<{ data: AiRoutingRegistry }>(
      'SELECT hon.hq_ai_routing_registry($1, $2::uuid) AS data', [externalSubject, policyId],
    );
    return result.rows[0]!.data;
  }

  async resolveAiTaskProfileRegistryFromHq(externalSubject: string, profileId: string): Promise<AiTaskProfileRegistry> {
    await this.assertRuntimePosture();
    const result = await this.getPool().query<{ data: AiTaskProfileRegistry }>(
      'SELECT hon.hq_ai_task_profile_registry($1, $2::uuid) AS data', [externalSubject, profileId],
    );
    return result.rows[0]!.data;
  }
  async withTenantTransaction<T>(
    context: TenantTransactionContext,
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    await this.assertRuntimePosture();
    const client = await this.getPool().connect();
    try {
      return await withTenantTransaction(client, context, work);
    } finally {
      client.release();
    }
  }

  /**
   * Starts read-only before establishing tenant GUCs. PostgreSQL rejects
   * `SET TRANSACTION READ ONLY` after any context-setting query, so read-only
   * staff projections must use this boundary rather than changing transaction
   * mode inside an already initialized tenant transaction.
   */
  async withTenantReadOnlyTransaction<T>(
    context: TenantTransactionContext,
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    await this.assertRuntimePosture();
    const client = await this.getPool().connect();
    try {
      await client.query('BEGIN READ ONLY');
      await client.query(
        `SELECT
          set_config('app.hon_organization_id', $1, true),
          set_config('app.hon_school_id', $2, true),
          set_config('app.hon_principal_id', $3, true),
          set_config('app.hon_principal_type', $4, true),
          set_config('app.hon_request_id', $5, true)`,
        [context.organizationId, context.schoolId, context.principalId, context.principalType, context.requestId],
      );
      await client.query('SELECT hon.require_tenant_context()');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Champions Club: one fixed, subject-only SECURITY DEFINER call per operation. The SQL text
   * comes only from the closed CHAMPIONS_CLUB_CALLS table; no tenant GUC is ever set (the
   * database refuses one), and reads run in a READ ONLY snapshot.
   */
  async callChampionsClub(operation: ChampionsClubOperation, params: readonly (string | null)[]): Promise<unknown> {
    const call = CHAMPIONS_CLUB_CALLS[operation];
    if (!call || params.length !== call.arity) throw new Error('CHAMPIONS_UNAVAILABLE');
    return this.callFixedSubjectFunction(call, params, 'CHAMPIONS_UNAVAILABLE');
  }

  /** HON subscription catalog (B1): same fixed, subject-only, context-free call discipline as Champions Club. */
  async callSaasBilling(operation: SaasBillingOperation, params: readonly (string | null)[]): Promise<unknown> {
    const call = SAAS_BILLING_CALLS[operation];
    if (!call || params.length !== call.arity) throw new Error('SAAS_UNAVAILABLE');
    return this.callFixedSubjectFunction(call, params, 'SAAS_UNAVAILABLE');
  }

  async callLanguage(operation: LanguageOperation, params: readonly (string | null)[]): Promise<unknown> {
    const call = LANGUAGE_CALLS[operation];
    if (!call || params.length !== call.arity) throw new Error('LANGUAGE_UNAVAILABLE');
    return this.callFixedSubjectFunction(call, params, 'LANGUAGE_UNAVAILABLE');
  }

  async callSchoolAccount(operation: 'invite'|'revoke'|'accept'|'list', params: readonly (string|null)[]): Promise<unknown> {
    const calls = {
      invite: {sql: "SELECT hon.manage_school_owner_invitation($1,'INVITE',$2::jsonb,$3::uuid) data",arity:3},
      revoke: {sql: "SELECT hon.manage_school_owner_invitation($1,'REVOKE',$2::jsonb,$3::uuid) data",arity:3},
      accept: {sql: 'SELECT hon.accept_school_owner_invitation($1,$2,$3::jsonb,$4::uuid) data',arity:4},
      list: {sql: 'SELECT hon.read_school_owner_invitations($1,$2::uuid) data',arity:2},
    } as const;
    const call=calls[operation];
    if(!call||params.length!==call.arity) throw new Error('ACCOUNT_UNAVAILABLE');
    return this.callFixedSubjectFunction({...call,readOnly:false},params,'ACCOUNT_UNAVAILABLE');
  }

  /** B-ID-4 (0223 proposed): school ownership handoff reads and HQ-owner commands. */
  async callSchoolOwnership(operation: SchoolOwnershipOperation, params: readonly (string|null)[]): Promise<unknown> {
    const calls = {
      hqRead: {sql: 'SELECT hon.read_school_ownership_from_hq($1,$2::uuid) data',arity:2},
      setPrimary: {sql: "SELECT hon.manage_school_ownership($1,'SET_PRIMARY',$2::jsonb,$3::uuid) data",arity:3},
      ownerRead: {sql: 'SELECT hon.read_school_ownership($1,$2::uuid) data',arity:2},
    } as const;
    const call=calls[operation];
    if(!call||params.length!==call.arity) throw new Error('ACCOUNT_UNAVAILABLE');
    return this.callFixedSubjectFunction({...call,readOnly:false},params,'ACCOUNT_UNAVAILABLE');
  }

  async callSchoolStaffAccount(operation: 'invite'|'revoke'|'accept'|'list'|'roles', params: readonly (string|null)[]): Promise<unknown> {
    const calls = {
      invite: {sql: "SELECT hon.manage_school_staff_invitation($1,'INVITE',$2::jsonb,$3::uuid) data",arity:3},
      revoke: {sql: "SELECT hon.manage_school_staff_invitation($1,'REVOKE',$2::jsonb,$3::uuid) data",arity:3},
      accept: {sql: 'SELECT hon.accept_school_staff_invitation($1,$2,$3::jsonb,$4::uuid) data',arity:4},
      list: {sql: 'SELECT hon.read_school_staff_invitations($1,$2::uuid) data',arity:2},
      roles: {sql: 'SELECT hon.read_school_staff_invitation_roles($1,$2::uuid) data',arity:2},
    } as const;
    const call=calls[operation];
    if(!call||params.length!==call.arity) throw new Error('ACCOUNT_UNAVAILABLE');
    return this.callFixedSubjectFunction({...call,readOnly:false},params,'ACCOUNT_UNAVAILABLE');
  }

  async callSchoolFamilyAccount(operation: 'invite'|'revoke'|'end'|'accept'|'list', params: readonly (string|null)[]): Promise<unknown> {
    const calls = {
      invite: {sql: "SELECT hon.manage_school_family_access_invitation($1,'INVITE',$2::jsonb,$3::uuid) data",arity:3},
      revoke: {sql: "SELECT hon.manage_school_family_access_invitation($1,'REVOKE',$2::jsonb,$3::uuid) data",arity:3},
      end: {sql: "SELECT hon.manage_school_family_access_invitation($1,'END',$2::jsonb,$3::uuid) data",arity:3},
      accept: {sql: 'SELECT hon.accept_school_family_access_invitation($1,$2,$3::jsonb,$4::uuid) data',arity:4},
      list: {sql: 'SELECT hon.read_school_family_access_invitations($1,$2::uuid) data',arity:2},
    } as const;
    const call=calls[operation];
    if(!call||params.length!==call.arity) throw new Error('ACCOUNT_UNAVAILABLE');
    return this.callFixedSubjectFunction({...call,readOnly:false},params,'ACCOUNT_UNAVAILABLE');
  }

  /** B-CRM-1a person record: the subject is the verified session subject; the database decides school authority. */
  async callSchoolPersonRecord(operation: 'read'|'update'|'birthDate', params: readonly (string|null)[]): Promise<unknown> {
    const calls = {
      read: {sql: 'SELECT hon.read_school_person($1,$2::uuid,$3::uuid) data',arity:3,readOnly:true},
      update: {sql: 'SELECT hon.update_school_person($1,$2::jsonb,$3::uuid) data',arity:3,readOnly:false},
      birthDate: {sql: 'SELECT hon.update_school_student_birth_date($1,$2::jsonb,$3::uuid) data',arity:3,readOnly:false},
    } as const;
    const call=calls[operation];
    if(!call||params.length!==call.arity) throw new Error('PERSON_UNAVAILABLE');
    return this.callFixedSubjectFunction(call,params,'PERSON_UNAVAILABLE');
  }

  private async callFixedSubjectFunction(call: { sql: string; readOnly: boolean }, params: readonly (string | null)[], unavailable: string): Promise<unknown> {
    await this.assertRuntimePosture();
    const client = await this.getPool().connect();
    try {
      await client.query(call.readOnly ? 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN');
      await client.query("SET LOCAL statement_timeout = '10s'; SET LOCAL lock_timeout = '3s'; SET LOCAL log_parameter_max_length_on_error = 0");
      const result = await client.query<{ data: unknown }>(call.sql, [...params]);
      await client.query('COMMIT');
      if (!result.rows[0]) throw new Error(unavailable);
      return result.rows[0].data;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool?.end();
  }
}
