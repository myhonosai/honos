import { ACTION_REVIEW_STATUSES, ACTION_REVIEW_UUID, actionReviewFingerprint, safeActionReviewPayload, validateHumanActionDecision, type ActionReviewItem, type ActionReviewQueue, type HumanActionReview, type HumanActionDecision, type HumanActionReceipt, type ActionReviewStatus } from '@hon/contracts';
const base='/api/v1/staff/action-center/approvals';
export class ActionReviewAccessError extends Error {}
function invalid():never { throw new Error('Unverified approval result. No decision or execution is assumed. Retry only the exact retained request or reload.'); }
function closed(v:unknown,keys:string[]):asserts v is Record<string,unknown> { if(!v || typeof v!=='object' || Array.isArray(v) || Object.keys(v).length!==keys.length || keys.some(k=>!Object.hasOwn(v,k))) invalid(); }
function uuid(v:unknown):asserts v is string { if(typeof v!=='string' || !ACTION_REVIEW_UUID.test(v) || v!==v.toLowerCase()) invalid(); }
function time(v:unknown):asserts v is string { if(typeof v!=='string' || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString()!==v) invalid(); }
function integer(v:unknown) { if(!Number.isSafeInteger(v) || Number(v)<0 || Number(v)>2147483647) invalid(); }
function hash(v:unknown) { if(typeof v!=='string' || !/^[a-f0-9]{64}$/.test(v)) invalid(); }
const itemKeys=['id','actionCode','status','requestedByPrincipalId','effectiveAuthorityMode','policyVersion','approvalExpiresAt','createdAt'];
function item(v:unknown):ActionReviewItem {
  closed(v,itemKeys);uuid(v.id);uuid(v.requestedByPrincipalId);time(v.createdAt);integer(v.policyVersion);
  if(v.approvalExpiresAt!==null) time(v.approvalExpiresAt);
  if(typeof v.actionCode!=='string' || !/^[a-z][a-z0-9_.]{1,99}$/.test(v.actionCode) || !ACTION_REVIEW_STATUSES.includes(v.status as ActionReviewStatus) || !['AUTO','CONFIRM','RESTRICTED'].includes(String(v.effectiveAuthorityMode))) invalid();
  return v as unknown as ActionReviewItem;
}
async function request(school:string,path:string,body?:HumanActionDecision,key?:string):Promise<unknown> {
  uuid(school);
  const r=await fetch(`${base}/${school}${path}`,{method:body?'POST':'GET',credentials:'same-origin',cache:'no-store',headers:body?{'Content-Type':'application/json','X-HON-Human-Command':'action-approvals','Idempotency-Key':key!}:{},...(body?{body:JSON.stringify(body)}:{})});
  if(!r.ok) throw new (r.status===401||r.status===403?ActionReviewAccessError:Error)(r.status===401?'Sign in with a verified human staff session.':r.status===403?'Current exact school review permission is unavailable. Sensitive detail has been cleared.':r.status===409?'Proposal, permission, policy, expiry or retry conflict. Reload exact current detail. No decision is assumed.':'Approval service unavailable or invalid input. No decision is assumed.');
  const e:unknown=await r.json();if(!e || typeof e!=='object' || !Object.hasOwn(e,'data')) invalid();return (e as {data:unknown}).data;
}
export async function loadActionReviews(school:string,status:ActionReviewStatus|'ALL',after:string|null=null):Promise<ActionReviewQueue> {
  if(![...ACTION_REVIEW_STATUSES,'ALL'].includes(status)) invalid();if(after!==null) uuid(after);
  const v=await request(school,`?status=${status}${after?`&after=${after}`:''}`);
  closed(v,['organizationId','schoolId','reviewerPrincipalId','reviewerPermission','status','items','nextAfter','executionTriggered']);uuid(v.organizationId);uuid(v.schoolId);uuid(v.reviewerPrincipalId);
  if(v.schoolId!==school || v.reviewerPermission!=='action.approve' || v.status!==status || v.executionTriggered!==false || !Array.isArray(v.items) || v.items.length>50) invalid();
  let previous=after??'';for(const x of v.items){const r=item(x);if(r.id<=previous || (status!=='ALL' && r.status!==status)) invalid();previous=r.id;}
  if(v.nextAfter!==null){uuid(v.nextAfter);if(v.items.length!==50 || v.nextAfter!==previous) invalid();}
  return v as unknown as ActionReviewQueue;
}
export async function readActionReview(school:string,id:string):Promise<HumanActionReview> {
  uuid(id);const v=await request(school,`/${id}`);
  closed(v,[...itemKeys,'organizationId','schoolId','payloadHash','requiredPermission','normalizedPayload','payloadVisibility','reviewerPrincipalId','reviewerPermission','delegatedByPrincipalId','currentPolicyVersion','currentAuthorityMode','reviewBlock','decisions','decisionsTruncated','executionTriggered']);
  item(Object.fromEntries(itemKeys.map(k=>[k,v[k]])));uuid(v.organizationId);uuid(v.schoolId);uuid(v.reviewerPrincipalId);hash(v.payloadHash);integer(v.currentPolicyVersion);
  if(v.delegatedByPrincipalId!==null) uuid(v.delegatedByPrincipalId);
  if(v.id!==id || v.schoolId!==school || v.reviewerPermission!=='action.approve' || v.executionTriggered!==false || typeof v.requiredPermission!=='string' || !/^[a-z][a-z0-9_.]{1,99}$/.test(v.requiredPermission) || (v.reviewBlock!==null && (typeof v.reviewBlock!=='string' || !/^[A-Z_]{1,100}$/.test(v.reviewBlock))) || (v.currentAuthorityMode!==null && !['AUTO','CONFIRM','RESTRICTED'].includes(String(v.currentAuthorityMode)))) invalid();
  if(v.payloadVisibility==='EXACT') {
    if(!safeActionReviewPayload(v.normalizedPayload)) invalid();
    const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(actionReviewFingerprint(v.normalizedPayload)));
    if(Array.from(new Uint8Array(bytes),x=>x.toString(16).padStart(2,'0')).join('')!==v.payloadHash) invalid();
  } else if(v.payloadVisibility!=='WITHHELD_UNSAFE' || v.normalizedPayload!==null || v.reviewBlock===null) invalid();
  if(!Array.isArray(v.decisions) || v.decisions.length>50 || typeof v.decisionsTruncated!=='boolean' || (v.decisionsTruncated && v.decisions.length!==50)) invalid();
  for(const d of v.decisions){closed(d,['reviewerPrincipalId','decision','payloadHash','policyVersion','decidedAt']);uuid(d.reviewerPrincipalId);hash(d.payloadHash);integer(d.policyVersion);time(d.decidedAt);if(!['APPROVED','DENIED','EXPIRED'].includes(String(d.decision)) || d.payloadHash!==v.payloadHash || d.policyVersion!==v.policyVersion) invalid();}
  if(v.reviewBlock===null && (v.status!=='AWAITING_APPROVAL' || v.payloadVisibility!=='EXACT' || v.effectiveAuthorityMode!=='CONFIRM' || v.currentAuthorityMode!=='CONFIRM' || v.currentPolicyVersion!==v.policyVersion || v.requestedByPrincipalId===v.reviewerPrincipalId || v.delegatedByPrincipalId===v.reviewerPrincipalId || v.approvalExpiresAt===null)) invalid();
  return v as unknown as HumanActionReview;
}
export async function decideActionReview(school:string,id:string,input:HumanActionDecision,key:string):Promise<HumanActionReceipt> {
  uuid(id);validateHumanActionDecision(input);if(input.binding.actionRequestId!==id || !key || key.length>200 || key.trim()!==key || /[\u0000-\u001f\u007f]/.test(key)) invalid();
  const v=await request(school,`/${id}/decision`,input,key);closed(v,['actionRequestId','status','actionCode','reviewedAt','payloadHash','policyVersion','executionTriggered']);time(v.reviewedAt);
  if(v.actionRequestId!==id || v.status!==input.decision || v.actionCode!==input.binding.actionCode || v.payloadHash!==input.binding.payloadHash || v.policyVersion!==input.binding.policyVersion || v.executionTriggered!==false) invalid();
  return v as unknown as HumanActionReceipt;
}
