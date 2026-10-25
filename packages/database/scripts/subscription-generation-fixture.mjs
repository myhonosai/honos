/** SYNTHETIC test inputs only. No operational seed/provider evidence or founder acceptance. */
import {randomUUID as K} from 'node:crypto';
import {sampleSchedule} from './price-acceptance-fixture.mjs';
export const generationInput=a=>({acceptanceId:a.acceptanceId,acceptanceDigest:a.acceptanceDigest,
 confirmation:'RECORD_SUBSCRIPTION_GENERATION_ONLY_NO_BILLING'});
export function sampleGeneration(terms){
 const s=sampleSchedule(terms),organizationId=K(),schoolId=K(),id=K();
 const a={acceptanceId:K(),organizationId,schoolId,schedule:s,scheduleDigest:s.scheduleDigest,acceptanceDigest:'d'.repeat(64),
  disclosureVersion:s.disclosureVersion,disclosureText:s.disclosureText,confirmation:'ACCEPT_INITIAL_AND_SCHEDULED_RENEWAL_PRICES',
  founderAllocationId:null,actorPrincipalId:K(),idempotencyKey:K(),acceptedAt:s.recordedAt,paymentStatus:'NOT_AUTHORIZED',
  subscriptionStatus:'NOT_CREATED',accessGranted:false,paidPeriodEvidence:'NOT_IMPLEMENTED_COMMERCIAL_B'};
 return {generationId:id,organizationId,schoolId,acceptance:a,generationDigest:'e'.repeat(64),actorPrincipalId:K(),idempotencyKey:K(),
  recordedAt:s.recordedAt,provider:{identity:'UNCONFIGURED',mode:'TEST',generationReference:id,accountReference:null,
   subscriptionReference:null,scheduleReference:null,bindingStatus:'NOT_BOUND'},checkoutAvailable:false,billingEnabled:false,
  accessGranted:false,paidPeriodEvidence:'NOT_IMPLEMENTED_B2'};
}
