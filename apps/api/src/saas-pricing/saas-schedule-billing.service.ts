import { BadRequestException, Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { SaasScheduleBinding } from '@hon/contracts';
import { randomUUID } from 'node:crypto';
import { saasUuid, validateSaasScheduleBinding, validateSaasScheduleBindingInput, validateSaasScheduleBindingReceipt,
  validateSaasScheduleEvidenceReceipt, type SaasScheduleRequirements } from '@hon/contracts';
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
    return this.billing.call('readScheduleBinding',[subject,s,b],validateSaasScheduleBinding);
  }
  readHq(subject: string, binding: unknown) {
    return this.billing.call('readScheduleBindingHq',[subject,parse(() => saasUuid(binding))],validateSaasScheduleBinding);
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

  /** Internal only: caller must already have verified raw provider bytes and selected the fixed TEST adapter. */
  ingestVerifiedTestEvidence(event: unknown, digest: unknown) {
    if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) throw new BadRequestException({ code: 'INVALID_SAAS_INPUT' });
    return this.billing.call('ingestScheduleEvidence',[JSON.stringify(event),digest],validateSaasScheduleEvidenceReceipt);
  }
}
