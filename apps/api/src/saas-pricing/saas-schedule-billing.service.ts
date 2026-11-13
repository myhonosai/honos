import { BadRequestException, Inject, Injectable, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import type { SaasScheduleBinding } from '@hon/contracts';
import { randomUUID } from 'node:crypto';
import { saasUuid, validateSaasScheduleAccessRetryInput, validateSaasScheduleAccessRetryReceipt, validateSaasScheduleBindingInput,
  validateSaasScheduleBindingReceipt, validateSaasScheduleBindingView, validateSaasScheduleEvidenceReceipt, validateSaasSchedulePastDueList,
  validateSaasSchedulePastDueSuspension, validateSaasScheduleWelcomeCreditInput, validateSaasScheduleWelcomeCreditReceipt,
  validateSaasLifetimeSwitchQuote, validateSaasLifetimeSwitchInput, validateSaasLifetimeSwitchReceipt, validateSaasHqLifetimeSwitchList,
  type SaasScheduleRequirements } from '@hon/contracts';
import { SaasBillingService } from '../saas-billing/saas-billing.service.js';
import { SUBSCRIPTION_SCHEDULE_PROVIDER, type ProviderScheduleRequirements, type ProviderSubscriptionScheduleAdapter } from '../payments/subscription-schedule-provider.js';

const parse = <T>(fn: () => T): T => { try { return fn(); } catch { throw new BadRequestException({ code: 'INVALID_SAAS_INPUT' }); } };

function providerRequirements(r: SaasScheduleRequirements): ProviderScheduleRequirements {
  return Object.freeze({ generationId:r.generationId, generationDigest:r.generationDigest, organizationId:r.organizationId, schoolId:r.schoolId,
    acceptanceId:r.acceptanceId, acceptanceDigest:r.acceptanceDigest, scheduleDigest:r.scheduleDigest, offerId:r.offerId,
    offerSetId:r.offerSetId, offerSetVersion:r.offerSetVersion, acceptedOfferDigest:r.acceptedOfferDigest,
    disclosureVersion:r.disclosureVersion, disclosureText:r.disclosureText, currency:r.currency,
    // One locked price for as long as the school stays subscribed: no introductory phase, renewal equals the first charge.
    initialAmountMinor:r.lockedPriceMinor, renewalAmountMinor:r.lockedPriceMinor, billingInterval:r.billingInterval, introductoryPaidPeriods:0,
    periodCountingRule:r.periodCountingRule, refundTerms:Object.freeze({...r.refundTerms}), cancellationTerms:Object.freeze({...r.cancellationTerms}) });
}

/**
 * B2 uses a two-transaction protocol: DB intent -> test-only idempotent adapter -> DB observation.
 * The default adapter is unconfigured, so this service refuses before any network I/O or billing effect.
 */
@Injectable()
export class SaasScheduleBillingService {
  constructor(private readonly billing: SaasBillingService,
    @Inject(SUBSCRIPTION_SCHEDULE_PROVIDER) private readonly provider: ProviderSubscriptionScheduleAdapter) {}

  async start(subject: string, school: unknown, body: unknown, key: unknown) {
    const [s,input,k] = parse(() => [saasUuid(school), validateSaasScheduleBindingInput(body), saasUuid(key)] as const);
    const intent = await this.billing.call('startScheduleBinding', [subject,s,JSON.stringify(input),k,randomUUID(),randomUUID()], validateSaasScheduleBindingReceipt);
    // An observed binding is the durable result for every later identical command; never re-contact an adapter.
    if (intent.binding.status !== 'PENDING_PROVIDER_BINDING') return intent;
    // The original human command already committed the intent. A replayed pending receipt means its adapter/observation
    // outcome is uncertain, not that a second provider operation is authorized. Preserve the original identity for a
    // separate reconciliation worker rather than calling bindOrFindSchedule again from this browser retry path.
    if (intent.replayed) throw new ServiceUnavailableException({ code: 'SAAS_SCHEDULE_BINDING_RECONCILIATION_REQUIRED', detail: 'The original binding is pending reconciliation; retry did not contact a provider or create another schedule.' });
    let observation;
    try {
      observation = await this.provider.bindOrFindSchedule({ bindingId:intent.binding.bindingId, bindingKey:intent.binding.bindingKey,
        requirementsDigest:intent.binding.requirementsDigest, requirements:providerRequirements(intent.binding.requirements) });
    } catch {
      // The intent is durable but the adapter outcome is unknown. A browser retry preserves the binding and enters
      // reconciliation without adapter I/O; only a future privileged reconciler may inspect the original binding key.
      throw new ServiceUnavailableException({ code: 'SAAS_SCHEDULE_PROVIDER_UNAVAILABLE', detail: 'Do not assume a provider binding took effect; the original binding requires reconciliation before any further provider inspection.' });
    }
    return this.billing.call('recordScheduleBindingObservation', [intent.binding.bindingId,JSON.stringify(observation),randomUUID(),randomUUID()], validateSaasScheduleBindingReceipt);
  }

  read(subject: string, school: unknown, binding: unknown) {
    const [s,b] = parse(() => [saasUuid(school),saasUuid(binding)] as const);
    return this.billing.call('readScheduleBinding',[subject,s,b],validateSaasScheduleBindingView);
  }
  readHq(subject: string, binding: unknown) {
    return this.billing.call('readScheduleBindingHq',[subject,parse(() => saasUuid(binding))],validateSaasScheduleBindingView);
  }

  /** HQ owner only (database-enforced): re-run access activation for an ACTIVE binding whose access is in review. */
  async retryAccess(subject: string, binding: unknown, body: unknown, key: unknown) {
    const [b,input,k] = parse(() => [saasUuid(binding), validateSaasScheduleAccessRetryInput(body), saasUuid(key)] as const);
    return this.billing.call('retryScheduleAccess',[subject,b,JSON.stringify(input),k,randomUUID(),randomUUID()],validateSaasScheduleAccessRetryReceipt);
  }

  /**
   * Privileged worker only (no route). A PENDING binding whose provider outcome is unknown: look the original binding key up
   * (never create), then record exactly one definite answer. UNKNOWN or a provider error records nothing and stays retryable.
   */
  async reconcilePending(binding: SaasScheduleBinding) {
    if (binding.status !== 'PENDING_PROVIDER_BINDING') return { binding, replayed: true };
    const request = { bindingId:binding.bindingId, bindingKey:binding.bindingKey, requirementsDigest:binding.requirementsDigest,
      requirements:providerRequirements(binding.requirements) };
    let found;
    try { found = await this.provider.findByBindingKey(request); }
    catch { throw new ServiceUnavailableException({ code: 'SAAS_SCHEDULE_PROVIDER_UNAVAILABLE' }); }
    if (found.outcome === 'UNKNOWN') throw new ServiceUnavailableException({ code: 'SAAS_SCHEDULE_PROVIDER_UNAVAILABLE' });
    if (found.outcome === 'BOUND' || found.outcome === 'ALREADY_BOUND')
      return this.billing.call('recordScheduleBindingObservation', [binding.bindingId,JSON.stringify(found),randomUUID(),randomUUID()], validateSaasScheduleBindingReceipt);
    return this.billing.call('recordScheduleBindingReconciliation', [binding.bindingId,JSON.stringify(found)], validateSaasScheduleBindingReceipt);
  }

  /**
   * Privileged worker only (no route). A bound binding that was never paid: ask the provider to cancel it, and only a
   * confirmed "cancelled, nothing collected" is recorded. The database still refuses unless the owner-recorded unpaid
   * window has elapsed and no money evidence exists.
   */
  async expireUnpaid(binding: SaasScheduleBinding) {
    if (binding.status !== 'BOUND_TEST_ONLY' || !binding.providerAccountReference || !binding.providerSubscriptionReference || !binding.providerScheduleReference)
      throw new BadRequestException({ code: 'SAAS_SCHEDULE_BINDING_NOT_EXPIRABLE' });
    let observed;
    try {
      observed = await this.provider.cancelUnpaidSchedule({ bindingId:binding.bindingId, accountReference:binding.providerAccountReference,
        subscriptionReference:binding.providerSubscriptionReference, scheduleReference:binding.providerScheduleReference });
    } catch { throw new ServiceUnavailableException({ code: 'SAAS_SCHEDULE_PROVIDER_UNAVAILABLE' }); }
    if (observed.outcome !== 'CANCELLED_NOTHING_COLLECTED') throw new ServiceUnavailableException({ code: 'SAAS_SCHEDULE_BINDING_RECONCILIATION_REQUIRED' });
    return this.billing.call('recordScheduleBindingExpiry', [binding.bindingId,JSON.stringify(observed)], validateSaasScheduleBindingReceipt);
  }

  /**
   * Worker (0324): plans whose 7-day grace after the last paid period has passed with no renewal. Ids only; each one is
   * suspended by its own command, which rechecks everything under the organization and binding locks.
   */
  listPastDue(limit = 50) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new BadRequestException({ code: 'INVALID_SAAS_INPUT' });
    return this.billing.call('listSchedulePastDueBindings', [String(limit)], validateSaasSchedulePastDueList);
  }

  /** Worker (0324): suspend one past-due plan (owner terms v2). The database decides from its own clock; safe to repeat. */
  suspendPastDue(bindingId: unknown) {
    const id = parse(() => saasUuid(bindingId));
    return this.billing.call('recordSchedulePastDueSuspension', [id], validateSaasSchedulePastDueSuspension);
  }

  /**
   * School purchaser, before the first payment (owner OD-4: cancel at no cost). Reads the binding through the school-scoped
   * read (authority + exact school), asks the provider to cancel, and records only a confirmed "cancelled, nothing
   * collected". The database rechecks authority, status and money evidence after its locks.
   */
  async cancelBeforePayment(subject: string, school: unknown, bindingId: unknown, key: unknown) {
    const [s,b,k] = parse(() => [saasUuid(school),saasUuid(bindingId),saasUuid(key)] as const);
    const binding = await this.billing.call('readScheduleBinding',[subject,s,b],validateSaasScheduleBindingView);
    if (binding.status === 'CANCELLED_BEFORE_PAYMENT') return { binding, replayed: true };
    if (binding.status !== 'BOUND_TEST_ONLY' || binding.qualifyingPaidPeriodCount !== 0 || !binding.providerAccountReference
      || !binding.providerSubscriptionReference || !binding.providerScheduleReference)
      throw new UnprocessableEntityException({ code: 'SAAS_SCHEDULE_BINDING_NOT_CANCELLABLE' });
    let observed;
    try {
      observed = await this.provider.cancelUnpaidSchedule({ bindingId:binding.bindingId, accountReference:binding.providerAccountReference,
        subscriptionReference:binding.providerSubscriptionReference, scheduleReference:binding.providerScheduleReference });
    } catch { throw new ServiceUnavailableException({ code: 'SAAS_SCHEDULE_PROVIDER_UNAVAILABLE' }); }
    // A collected or unknown provider answer is never recorded as a no-cost cancellation.
    if (observed.outcome !== 'CANCELLED_NOTHING_COLLECTED') throw new ServiceUnavailableException({ code: 'SAAS_SCHEDULE_BINDING_RECONCILIATION_REQUIRED' });
    return this.billing.call('cancelScheduleBinding',[subject,s,b,JSON.stringify(observed),k,randomUUID(),randomUUID()],validateSaasScheduleBindingReceipt);
  }

  /**
   * 0325, HQ owner only (database-enforced): record one approved welcome credit on the referred school's HON OS plan,
   * then ask the provider to put the same amount on the customer's balance under the credit's key. A provider failure
   * leaves the recorded credit in place; a retry with the same idempotency key replays the record and re-sends the same
   * idempotent provider credit. Until the provider applies it, the next renewal arrives at full price and is held for review.
   */
  async applyWelcomeCredit(subject: string, binding: unknown, body: unknown, key: unknown) {
    const [b,input,k] = parse(() => [saasUuid(binding), validateSaasScheduleWelcomeCreditInput(body), saasUuid(key)] as const);
    const receipt = await this.billing.call('applyScheduleWelcomeCredit',
      [subject,input.rewardEntryId,JSON.stringify({ bindingId:b, expectedEntryVersion:input.expectedEntryVersion }),k,randomUUID(),randomUUID()],
      validateSaasScheduleWelcomeCreditReceipt);
    let observed;
    try {
      observed = await this.provider.creditCustomerBalance({ accountReference:receipt.providerAccountReference, amountMinor:receipt.amountMinor,
        currency:'USD', creditKey:receipt.providerCreditKey });
    } catch {
      throw new ServiceUnavailableException({ code: 'SAAS_SCHEDULE_PROVIDER_UNAVAILABLE', detail: 'The credit is recorded; retry with the same idempotency key to send it to the provider.' });
    }
    if (observed.outcome !== 'CREDITED' || observed.creditKey !== receipt.providerCreditKey || observed.amountMinor !== receipt.amountMinor)
      throw new ServiceUnavailableException({ code: 'SAAS_SCHEDULE_BINDING_RECONCILIATION_REQUIRED' });
    return { ...receipt, providerCredited: true as const };
  }

  /** 0341: the school's switch-to-lifetime quote (credit for the unused whole days of its current paid period). */
  lifetimeSwitchQuote(subject: string, school: unknown) {
    return this.billing.call('readLifetimeSwitchQuote',[subject,parse(() => saasUuid(school))],validateSaasLifetimeSwitchQuote);
  }
  /** 0341: HQ list of switches to lifetime, newest first. */
  hqLifetimeSwitches(subject: string, limit = 100) {
    return this.billing.call('readHqLifetimeSwitches',[subject,String(limit)],validateSaasHqLifetimeSwitchList);
  }

  /**
   * 0341: sign up for a switch to lifetime. Same two-transaction protocol as start() (DB intent -> idempotent TEST adapter
   * -> DB observation), then the fixed switch credit goes on the new customer's provider balance under the switch's own
   * key, so the one-time charge is the lifetime price minus the credit. If that credit fails, the sign-up stays; a retry
   * with the same idempotency key re-sends the same idempotent credit. Until it lands, a full-price payment is held for
   * review, never counted. No refund is ever sent.
   */
  async startLifetimeSwitch(subject: string, school: unknown, body: unknown, key: unknown) {
    const [s,input,k] = parse(() => [saasUuid(school), validateSaasLifetimeSwitchInput(body), saasUuid(key)] as const);
    const intent = await this.billing.call('startLifetimeSwitch',[subject,s,JSON.stringify(input),k,randomUUID(),randomUUID()],validateSaasLifetimeSwitchReceipt);
    let bound = intent;
    if (intent.binding.status === 'PENDING_PROVIDER_BINDING') {
      if (intent.replayed) throw new ServiceUnavailableException({ code: 'SAAS_SCHEDULE_BINDING_RECONCILIATION_REQUIRED', detail: 'The original switch binding is pending reconciliation; retry did not contact a provider or create another schedule.' });
      let observation;
      try {
        observation = await this.provider.bindOrFindSchedule({ bindingId:intent.binding.bindingId, bindingKey:intent.binding.bindingKey,
          requirementsDigest:intent.binding.requirementsDigest, requirements:providerRequirements(intent.binding.requirements) });
      } catch {
        throw new ServiceUnavailableException({ code: 'SAAS_SCHEDULE_PROVIDER_UNAVAILABLE', detail: 'Do not assume a provider binding took effect; the original binding requires reconciliation before any further provider inspection.' });
      }
      const observed = await this.billing.call('recordScheduleBindingObservation', [intent.binding.bindingId,JSON.stringify(observation),randomUUID(),randomUUID()], validateSaasScheduleBindingReceipt);
      bound = { ...intent, binding: observed.binding };
    }
    if (bound.binding.status !== 'BOUND_TEST_ONLY' || bound.lifetimeSwitch.creditMinor === 0 || !bound.binding.providerAccountReference)
      return { ...bound, providerCredited: bound.lifetimeSwitch.creditMinor === 0 };
    let credited;
    try {
      credited = await this.provider.creditCustomerBalance({ accountReference:bound.binding.providerAccountReference, amountMinor:bound.lifetimeSwitch.creditMinor,
        currency:'USD', creditKey:bound.lifetimeSwitch.providerCreditKey });
    } catch {
      throw new ServiceUnavailableException({ code: 'SAAS_SCHEDULE_PROVIDER_UNAVAILABLE', detail: 'The switch is recorded; retry with the same idempotency key to send its credit to the provider.' });
    }
    if (credited.outcome !== 'CREDITED' || credited.creditKey !== bound.lifetimeSwitch.providerCreditKey || credited.amountMinor !== bound.lifetimeSwitch.creditMinor)
      throw new ServiceUnavailableException({ code: 'SAAS_SCHEDULE_BINDING_RECONCILIATION_REQUIRED' });
    return { ...bound, providerCredited: true };
  }

  /**
   * Internal only: caller must already have verified raw provider bytes and selected the fixed TEST adapter.
   * 0341: after a paid switch, the old plan's schedule is stopped with no proration and no refund. The switch is already
   * final in the database; a provider failure here is reported in the receipt and repeated on the provider's redelivery
   * (the stored receipt is replayed and the stop is idempotent). Any old-plan renewal that still arrives is held for review.
   */
  async ingestVerifiedTestEvidence(event: unknown, digest: unknown) {
    if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) throw new BadRequestException({ code: 'INVALID_SAAS_INPUT' });
    const receipt = await this.billing.call('ingestScheduleEvidence',[JSON.stringify(event),digest],validateSaasScheduleEvidenceReceipt);
    if (!receipt.switchedFrom) return receipt;
    const from = receipt.switchedFrom;
    let stopped = false;
    try {
      const r = await this.provider.stopScheduleNoRefund({ bindingId:from.bindingId, accountReference:from.accountReference,
        subscriptionReference:from.subscriptionReference, scheduleReference:from.scheduleReference });
      stopped = r.outcome === 'STOPPED_NO_REFUND' && r.bindingId === from.bindingId && r.refundSent === false;
    } catch { stopped = false; }
    return { ...receipt, oldScheduleStopped: stopped };
  }
}
