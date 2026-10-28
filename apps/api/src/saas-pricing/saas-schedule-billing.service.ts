import { BadRequestException, Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
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
    disclosureVersion:r.disclosureVersion, disclosureText:r.disclosureText, currency:r.currency, initialAmountMinor:r.initialAmountMinor,
    renewalAmountMinor:r.renewalAmountMinor, billingInterval:r.billingInterval, introductoryPaidPeriods:r.introductoryPaidPeriods,
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
    if (intent.binding.status !== 'PENDING_PROVIDER_BINDING') return intent;
    let observation;
    try {
      observation = await this.provider.bindOrFindSchedule({ bindingId:intent.binding.bindingId, bindingKey:intent.binding.bindingKey,
        requirementsDigest:intent.binding.requirementsDigest, requirements:providerRequirements(intent.binding.requirements) });
    } catch {
      // The intent is durable. The exact caller can retry the same command so the adapter first finds by binding key.
      throw new ServiceUnavailableException({ code: 'SAAS_SCHEDULE_PROVIDER_UNAVAILABLE', detail: 'Retry the identical request with the same key; do not assume a provider binding took effect.' });
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

  /** Internal only: caller must already have verified raw provider bytes and selected the fixed TEST adapter. */
  ingestVerifiedTestEvidence(event: unknown, digest: unknown) {
    if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) throw new BadRequestException({ code: 'INVALID_SAAS_INPUT' });
    return this.billing.call('ingestScheduleEvidence',[JSON.stringify(event),digest],validateSaasScheduleEvidenceReceipt);
  }
}
