/** D11-A is governance metadata only. These contracts do not authorize signup, access or spending. */
import { championsDrift as drift, championsInvalid as invalid, championsRecord as record,
 championsExactKeys as keys, championsIsInt as int, championsIsUuid as uuid, championsIsTimestamp as timestamp } from './champions-club.js';
export const TRIAL_DURATION_CHOICES = [7,14,30,60,90] as const;
export const TRIAL_PROFILES = ['CORE','COMPLETE'] as const;
export const TRIAL_ELIGIBILITIES = ['NEW_ORGANIZATIONS_ONLY','HQ_REVIEW_REQUIRED'] as const;
export const TRIAL_LINK_MODES = ['PUBLIC','PRIVATE_INVITATION','PROMOTIONAL'] as const;
export const TRIAL_POLICY_CONFIRMATION = 'APPROVE_CUSTOMER_TRIAL_POLICY_ONLY' as const;
export const TRIAL_PUBLICATION_CONFIRMATION = 'PUBLISH_TRIAL_CAMPAIGN_DEFINITION_ONLY' as const;
export interface TrialPromoLimits { maxCreditsPerEnrollment:number; maxCreditExpiryDays:number; maxDailyCreditCap:number; maxPerRequestCreditCap:number; maxCampaignCostMinor:number; maxTotalCampaignCostMinor:number }
export interface TrialPromoBudget { currency:'USD'; creditsPerEnrollment:number; creditExpiryDays:number; dailyCreditCap:number; perRequestCreditCap:number; maximumCampaignCostMinor:number }
export interface TrialPolicyTerms {
 allowedDurationsDays:number[]; allowedCapabilityProfiles:string[]; allowedEligibilityCodes:string[]; allowedLinkModes:string[];
 maxEnrollmentCapacity:number; maxEnrollmentWindowDays:number; maxPublishedCampaigns:number; maxTotalEnrollmentCapacity:number;
 termsReference:string; promotionalLimits:TrialPromoLimits|null;
}
export interface TrialCampaignDefinition {
 name:string; durationDays:number; capabilityProfile:'CORE'|'COMPLETE'; eligibility:'NEW_ORGANIZATIONS_ONLY'|'HQ_REVIEW_REQUIRED';
 linkMode:'PUBLIC'|'PRIVATE_INVITATION'|'PROMOTIONAL'; enrollmentOpensAt:string; enrollmentClosesAt:string;
 maximumEnrollments:number; termsReference:string; promotionalBudget:TrialPromoBudget|null;
}
export interface TrialPolicyProposalInput { expectedVersion:number; terms:TrialPolicyTerms; reason:string }
export type TrialPolicyDecisionInput = { decision:'APPROVED'; policyId:string; expectedRevision:number; validFrom:string; validUntil:string; reason:string; confirmation:typeof TRIAL_POLICY_CONFIRMATION }
 | { decision:'WITHDRAWN'|'REVOKED'; expectedRevision:number; reason:string };
export interface TrialCampaignDraftInput { campaignId:string|null; expectedVersion:number; definition:TrialCampaignDefinition; reason:string }
export interface TrialCampaignPublishInput { versionId:string; expectedRevision:number; previewDigest:string; confirmation:typeof TRIAL_PUBLICATION_CONFIRMATION; reason:string }
export interface TrialCampaignWithdrawInput { expectedRevision:number; reason:string }
export interface TrialPolicyVersion { policyId:string; version:number; status:'PROPOSED'; terms:TrialPolicyTerms; reason:string; actorPrincipalId:string; recordedAt:string }
export interface TrialPolicyDecision { decisionId:string; revision:number; policyId:string; decision:'APPROVED'|'WITHDRAWN'|'REVOKED'; validFrom:string; validUntil:string; reason:string; actorPrincipalId:string; recordedAt:string }
export interface TrialCampaignVersion { versionId:string; campaignId:string; version:number; definition:TrialCampaignDefinition; reason:string; actorPrincipalId:string; recordedAt:string }
export interface TrialPublication { publicationId:string; campaignId:string; revision:number; kind:'PUBLISHED'|'WITHDRAWN'; versionId:string; policyDecisionId:string; previewDigest:string|null; reason:string; actorPrincipalId:string; recordedAt:string; activationAvailable:false }
export interface TrialPublicationPreview {
 campaignId:string; versionId:string; version:number; expectedRevision:number; policyDecisionId:string|null; policyId:string|null;
 digest:string; ready:boolean; blockers:string[]; activationAvailable:false; promotionalCreditsAvailable:false;
 plannedExposure:{enrollments:number; promotionalCostMinor:number; currency:'USD'}; asOf:string;
}
export interface TrialGovernanceView {
 scope:'CUSTOMER_TRIAL_GOVERNANCE_ONLY'; program:{status:'INACTIVE';signupEnabled:false;enrollmentEnabled:false;promotionalIssuanceEnabled:false};
 policyVersions:TrialPolicyVersion[]; policyDecisions:TrialPolicyDecision[]; campaignVersions:TrialCampaignVersion[]; publications:TrialPublication[];
 limit:100; hasMore:{policyVersions:boolean;policyDecisions:boolean;campaignVersions:boolean;publications:boolean};
 existingPrograms:{paidAccess:'INACTIVE'|'ACTIVE';aiCredits:'INACTIVE'|'ACTIVE';payments:'DISABLED'|'TEST_MODE'};asOf:string;
}
export interface TrialCampaignView { campaignId:string; versions:TrialCampaignVersion[]; publications:TrialPublication[]; limit:100; hasMore:{versions:boolean;publications:boolean};activationAvailable:false;asOf:string }
const reason=(v:unknown)=>typeof v==='string'&&v===v.trim()&&v.length>=10&&v.length<=500;
const reference=(v:unknown)=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:/-]{4,199}$/.test(v);
const text=(v:unknown)=>typeof v==='string'&&v===v.trim()&&v.length>=1&&v.length<=120&&!/[\x00-\x1f\x7f]/.test(v);
const choices=(v:unknown,list:readonly unknown[])=>Array.isArray(v)&&v.length>0&&v.length<=list.length&&new Set(v).size===v.length&&v.every(x=>list.includes(x));
const hex=(v:unknown)=>typeof v==='string'&&/^[0-9a-f]{64}$/.test(v);
const rev=(v:unknown)=>int(v,0,999_999_998);
function policyTerms(value:unknown,fail:()=>never):TrialPolicyTerms {
 const r=record(value,fail);keys(r,['allowedDurationsDays','allowedCapabilityProfiles','allowedEligibilityCodes','allowedLinkModes','maxEnrollmentCapacity','maxEnrollmentWindowDays','maxPublishedCampaigns','maxTotalEnrollmentCapacity','termsReference','promotionalLimits'],fail);
 if(!choices(r.allowedDurationsDays,TRIAL_DURATION_CHOICES)||!choices(r.allowedCapabilityProfiles,TRIAL_PROFILES)||!choices(r.allowedEligibilityCodes,TRIAL_ELIGIBILITIES)||!choices(r.allowedLinkModes,TRIAL_LINK_MODES)
  ||!int(r.maxEnrollmentCapacity,1,1_000_000)||!int(r.maxEnrollmentWindowDays,1,3660)||!int(r.maxPublishedCampaigns,1,10_000)||!int(r.maxTotalEnrollmentCapacity,1,1_000_000_000)
  ||(r.maxTotalEnrollmentCapacity as number)<(r.maxEnrollmentCapacity as number)||!reference(r.termsReference))fail();
 if(r.promotionalLimits!==null){const p=record(r.promotionalLimits,fail);keys(p,['maxCreditsPerEnrollment','maxCreditExpiryDays','maxDailyCreditCap','maxPerRequestCreditCap','maxCampaignCostMinor','maxTotalCampaignCostMinor'],fail);
  for(const k of ['maxCreditsPerEnrollment','maxDailyCreditCap','maxPerRequestCreditCap'])if(!int(p[k],1,1_000_000))fail();
  if(!int(p.maxCreditExpiryDays,1,90)||!int(p.maxCampaignCostMinor,1,1_000_000_000)||!int(p.maxTotalCampaignCostMinor,1,1_000_000_000)
   ||(p.maxPerRequestCreditCap as number)>(p.maxDailyCreditCap as number)||(p.maxDailyCreditCap as number)>(p.maxCreditsPerEnrollment as number)||(p.maxCampaignCostMinor as number)>(p.maxTotalCampaignCostMinor as number))fail();
 }
 return r as unknown as TrialPolicyTerms;
}
function campaignDefinition(value:unknown,fail:()=>never):TrialCampaignDefinition {
 const r=record(value,fail);keys(r,['name','durationDays','capabilityProfile','eligibility','linkMode','enrollmentOpensAt','enrollmentClosesAt','maximumEnrollments','termsReference','promotionalBudget'],fail);
 if(!text(r.name)||!TRIAL_DURATION_CHOICES.includes(r.durationDays as 7)||!TRIAL_PROFILES.includes(r.capabilityProfile as 'CORE')||!TRIAL_ELIGIBILITIES.includes(r.eligibility as 'HQ_REVIEW_REQUIRED')
  ||!TRIAL_LINK_MODES.includes(r.linkMode as 'PUBLIC')||!timestamp(r.enrollmentOpensAt)||!timestamp(r.enrollmentClosesAt)||Date.parse(r.enrollmentClosesAt as string)<=Date.parse(r.enrollmentOpensAt as string)
  ||Date.parse(r.enrollmentClosesAt as string)-Date.parse(r.enrollmentOpensAt as string)>3660*86400_000||!int(r.maximumEnrollments,1,1_000_000)||!reference(r.termsReference))fail();
 if(r.promotionalBudget!==null){const p=record(r.promotionalBudget,fail);keys(p,['currency','creditsPerEnrollment','creditExpiryDays','dailyCreditCap','perRequestCreditCap','maximumCampaignCostMinor'],fail);
  for(const k of ['creditsPerEnrollment','dailyCreditCap','perRequestCreditCap'])if(!int(p[k],1,1_000_000))fail();
  if(p.currency!=='USD'||!int(p.creditExpiryDays,1,90)||(p.creditExpiryDays as number)>(r.durationDays as number)||!int(p.maximumCampaignCostMinor,1,1_000_000_000)
   ||(p.perRequestCreditCap as number)>(p.dailyCreditCap as number)||(p.dailyCreditCap as number)>(p.creditsPerEnrollment as number))fail();
 }
 return r as unknown as TrialCampaignDefinition;
}
export function validateTrialPolicyProposalInput(v:unknown):TrialPolicyProposalInput {const r=record(v,invalid);keys(r,['expectedVersion','terms','reason'],invalid);if(!rev(r.expectedVersion)||!reason(r.reason))invalid();policyTerms(r.terms,invalid);return r as unknown as TrialPolicyProposalInput;}
export function validateTrialPolicyDecisionInput(v:unknown):TrialPolicyDecisionInput {const r=record(v,invalid),approve=r.decision==='APPROVED';keys(r,['decision','expectedRevision','reason',...(approve?['policyId','validFrom','validUntil','confirmation']:[])],invalid);
 if(!['APPROVED','WITHDRAWN','REVOKED'].includes(r.decision as string)||!rev(r.expectedRevision)||!reason(r.reason)||(approve&&(!uuid(r.policyId)||!timestamp(r.validFrom)||!timestamp(r.validUntil)||Date.parse(r.validUntil as string)<=Date.parse(r.validFrom as string)||r.confirmation!==TRIAL_POLICY_CONFIRMATION)))invalid();return r as unknown as TrialPolicyDecisionInput;}
export function validateTrialCampaignDraftInput(v:unknown):TrialCampaignDraftInput {const r=record(v,invalid);keys(r,['campaignId','expectedVersion','definition','reason'],invalid);if(!(r.campaignId===null||uuid(r.campaignId))||!rev(r.expectedVersion)||!reason(r.reason)||(r.campaignId===null&&r.expectedVersion!==0))invalid();campaignDefinition(r.definition,invalid);return r as unknown as TrialCampaignDraftInput;}
export function validateTrialCampaignPublishInput(v:unknown):TrialCampaignPublishInput {const r=record(v,invalid);keys(r,['versionId','expectedRevision','previewDigest','confirmation','reason'],invalid);if(!uuid(r.versionId)||!rev(r.expectedRevision)||!hex(r.previewDigest)||r.confirmation!==TRIAL_PUBLICATION_CONFIRMATION||!reason(r.reason))invalid();return r as unknown as TrialCampaignPublishInput;}
export function validateTrialCampaignWithdrawInput(v:unknown):TrialCampaignWithdrawInput {const r=record(v,invalid);keys(r,['expectedRevision','reason'],invalid);if(!rev(r.expectedRevision)||!reason(r.reason))invalid();return r as unknown as TrialCampaignWithdrawInput;}
export function validateTrialPolicyVersion(v:unknown):TrialPolicyVersion {const r=record(v,drift);keys(r,['policyId','version','status','terms','reason','actorPrincipalId','recordedAt'],drift);if(!uuid(r.policyId)||!int(r.version,1,999_999_999)||r.status!=='PROPOSED'||!reason(r.reason)||!uuid(r.actorPrincipalId)||!timestamp(r.recordedAt))drift();policyTerms(r.terms,drift);return r as unknown as TrialPolicyVersion;}
export function validateTrialPolicyDecision(v:unknown):TrialPolicyDecision {const r=record(v,drift);keys(r,['decisionId','revision','policyId','decision','validFrom','validUntil','reason','actorPrincipalId','recordedAt'],drift);if(!uuid(r.decisionId)||!int(r.revision,1,999_999_999)||!uuid(r.policyId)||!['APPROVED','WITHDRAWN','REVOKED'].includes(r.decision as string)||!timestamp(r.validFrom)||!timestamp(r.validUntil)||Date.parse(r.validUntil as string)<=Date.parse(r.validFrom as string)||!reason(r.reason)||!uuid(r.actorPrincipalId)||!timestamp(r.recordedAt))drift();return r as unknown as TrialPolicyDecision;}
export function validateTrialCampaignVersion(v:unknown):TrialCampaignVersion {const r=record(v,drift);keys(r,['versionId','campaignId','version','definition','reason','actorPrincipalId','recordedAt'],drift);if(!uuid(r.versionId)||!uuid(r.campaignId)||!int(r.version,1,999_999_999)||!reason(r.reason)||!uuid(r.actorPrincipalId)||!timestamp(r.recordedAt))drift();campaignDefinition(r.definition,drift);return r as unknown as TrialCampaignVersion;}
export function validateTrialPublication(v:unknown):TrialPublication {const r=record(v,drift);keys(r,['publicationId','campaignId','revision','kind','versionId','policyDecisionId','previewDigest','reason','actorPrincipalId','recordedAt','activationAvailable'],drift);if(!uuid(r.publicationId)||!uuid(r.campaignId)||!int(r.revision,1,999_999_999)||!['PUBLISHED','WITHDRAWN'].includes(r.kind as string)||!uuid(r.versionId)||!uuid(r.policyDecisionId)||!(r.kind==='PUBLISHED'?hex(r.previewDigest):r.previewDigest===null)||!reason(r.reason)||!uuid(r.actorPrincipalId)||!timestamp(r.recordedAt)||r.activationAvailable!==false)drift();return r as unknown as TrialPublication;}
export function validateTrialPublicationPreview(v:unknown):TrialPublicationPreview {const r=record(v,drift);keys(r,['campaignId','versionId','version','expectedRevision','policyDecisionId','policyId','digest','ready','blockers','activationAvailable','promotionalCreditsAvailable','plannedExposure','asOf'],drift);
 const e=record(r.plannedExposure,drift);keys(e,['enrollments','promotionalCostMinor','currency'],drift);
 if(!uuid(r.campaignId)||!uuid(r.versionId)||!int(r.version,1,999_999_999)||!int(r.expectedRevision,0,999_999_999)||!(r.policyDecisionId===null||uuid(r.policyDecisionId))||!(r.policyId===null||uuid(r.policyId))||!hex(r.digest)||typeof r.ready!=='boolean'||!Array.isArray(r.blockers)||r.blockers.some(x=>typeof x!=='string'||!/^[A-Z_]+$/.test(x))||r.ready!==(r.blockers.length===0)||r.activationAvailable!==false||r.promotionalCreditsAvailable!==false||!int(e.enrollments,1,1_000_000)||!int(e.promotionalCostMinor,0,1_000_000_000)||e.currency!=='USD'||!timestamp(r.asOf))drift();return r as unknown as TrialPublicationPreview;}
function ordered<T>(values:unknown,validate:(v:unknown)=>T,number:(v:T)=>number){if(!Array.isArray(values)||values.length>100)drift();const rows=(values as unknown[]).map(validate);if(rows.some((r,i)=>i>0&&number(r)>=number(rows[i-1]!)))drift();}
export function validateTrialGovernanceView(v:unknown):TrialGovernanceView {const r=record(v,drift);keys(r,['scope','program','policyVersions','policyDecisions','campaignVersions','publications','limit','hasMore','existingPrograms','asOf'],drift);
 const p=record(r.program,drift);keys(p,['status','signupEnabled','enrollmentEnabled','promotionalIssuanceEnabled'],drift);if(p.status!=='INACTIVE'||p.signupEnabled!==false||p.enrollmentEnabled!==false||p.promotionalIssuanceEnabled!==false)drift();
 const more=record(r.hasMore,drift);keys(more,['policyVersions','policyDecisions','campaignVersions','publications'],drift);if(Object.values(more).some(x=>typeof x!=='boolean'))drift();
 const programs=record(r.existingPrograms,drift);keys(programs,['paidAccess','aiCredits','payments'],drift);if(!['INACTIVE','ACTIVE'].includes(programs.paidAccess as string)||!['INACTIVE','ACTIVE'].includes(programs.aiCredits as string)||!['DISABLED','TEST_MODE'].includes(programs.payments as string))drift();
 if(r.scope!=='CUSTOMER_TRIAL_GOVERNANCE_ONLY'||r.limit!==100||!timestamp(r.asOf))drift();ordered(r.policyVersions,validateTrialPolicyVersion,x=>x.version);ordered(r.policyDecisions,validateTrialPolicyDecision,x=>x.revision);
 for(const [array,validate] of [[r.campaignVersions,validateTrialCampaignVersion],[r.publications,validateTrialPublication]] as const){if(!Array.isArray(array)||array.length>100)drift();array.forEach(validate);}
 return r as unknown as TrialGovernanceView;}
export function validateTrialCampaignView(v:unknown):TrialCampaignView {const r=record(v,drift);keys(r,['campaignId','versions','publications','limit','hasMore','activationAvailable','asOf'],drift);const more=record(r.hasMore,drift);keys(more,['versions','publications'],drift);if(!uuid(r.campaignId)||r.limit!==100||r.activationAvailable!==false||!timestamp(r.asOf)||Object.values(more).some(x=>typeof x!=='boolean'))drift();ordered(r.versions,validateTrialCampaignVersion,x=>x.version);ordered(r.publications,validateTrialPublication,x=>x.revision);if((r.versions as TrialCampaignVersion[]).some(x=>x.campaignId!==r.campaignId)||(r.publications as TrialPublication[]).some(x=>x.campaignId!==r.campaignId))drift();return r as unknown as TrialCampaignView;}
export function validateTrialPolicyReceipt(v:unknown){const r=record(v,drift);keys(r,['policyVersion','replayed'],drift);validateTrialPolicyVersion(r.policyVersion);if(typeof r.replayed!=='boolean')drift();return r as unknown as {policyVersion:TrialPolicyVersion;replayed:boolean};}
export function validateTrialDecisionReceipt(v:unknown){const r=record(v,drift);keys(r,['decision','replayed'],drift);validateTrialPolicyDecision(r.decision);if(typeof r.replayed!=='boolean')drift();return r as unknown as {decision:TrialPolicyDecision;replayed:boolean};}
export function validateTrialDraftReceipt(v:unknown){const r=record(v,drift);keys(r,['campaignVersion','replayed'],drift);validateTrialCampaignVersion(r.campaignVersion);if(typeof r.replayed!=='boolean')drift();return r as unknown as {campaignVersion:TrialCampaignVersion;replayed:boolean};}
export function validateTrialPublicationReceipt(v:unknown){const r=record(v,drift);keys(r,['publication','replayed'],drift);validateTrialPublication(r.publication);if(typeof r.replayed!=='boolean')drift();return r as unknown as {publication:TrialPublication;replayed:boolean};}
