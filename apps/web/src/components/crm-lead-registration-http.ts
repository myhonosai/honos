import { CRM_LEAD_REGISTRATION_UUID, validateRegisterCrmLeadInput, verifyCrmLeadRegistrationResult, type CrmLeadRegistrationResult, type RegisterCrmLeadInput } from '@hon/contracts';
export class CrmLeadRegistrationUncertainError extends Error {}
export class CrmLeadRegistrationRejectedError extends Error {}
export type PreparedCrmLeadRegistration = Readonly<{ path: string; organizationId: string; schoolId: string; leadId: string; key: string; body: string }>;
export type CrmLeadRegistrationCommandResult = { result: CrmLeadRegistrationResult; replayed: boolean };
function invalid(): never { throw new Error('Unverified CRM registration contract. No registration, family, enrollment, membership, billing, payment, consent, booking, attendance, notification, or provider outcome is assumed.'); }
function uuid(value: unknown): asserts value is string { if (typeof value !== 'string' || !CRM_LEAD_REGISTRATION_UUID.test(value)) invalid(); }
function closed(value: unknown, keys: string[]): asserts value is Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value,key))) invalid(); }
export function crmLeadRegistrationPath(organizationId: string, schoolId: string, leadId: string): string { uuid(organizationId); uuid(schoolId); uuid(leadId); return `/api/v1/organizations/${organizationId.toLowerCase()}/schools/${schoolId.toLowerCase()}/crm/leads/${leadId.toLowerCase()}/register`; }
export function prepareCrmLeadRegistration(organizationId: string, schoolId: string, leadId: string, input: RegisterCrmLeadInput, key: string): PreparedCrmLeadRegistration { uuid(key); uuid(leadId); validateRegisterCrmLeadInput(input); return Object.freeze({path:crmLeadRegistrationPath(organizationId,schoolId,leadId),organizationId:organizationId.toLowerCase(),schoolId:schoolId.toLowerCase(),leadId:leadId.toLowerCase(),key,body:JSON.stringify(input)}); }
export function parseCrmLeadRegistrationResult(value: unknown, request: PreparedCrmLeadRegistration): CrmLeadRegistrationCommandResult {
  closed(value,['data','meta']); closed(value.meta,['requestId','correlationId','replayed']); uuid(value.meta.requestId); uuid(value.meta.correlationId);
  if(value.meta.requestId!==value.meta.correlationId || typeof value.meta.replayed!=='boolean') invalid();
  const input: unknown=JSON.parse(request.body); validateRegisterCrmLeadInput(input);
  return {result:verifyCrmLeadRegistrationResult(value.data,request.leadId,input),replayed:value.meta.replayed};
}
/** The caller retains this exact frozen request only when outcome transport is uncertain. */
export async function submitCrmLeadRegistration(request: PreparedCrmLeadRegistration): Promise<CrmLeadRegistrationCommandResult> {
  closed(request,['path','organizationId','schoolId','leadId','key','body']); uuid(request.key); if(request.path!==crmLeadRegistrationPath(request.organizationId,request.schoolId,request.leadId)) invalid(); validateRegisterCrmLeadInput(JSON.parse(request.body));
  let response: Response; try { response=await fetch(request.path,{method:'POST',mode:'same-origin',credentials:'same-origin',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer',headers:{Accept:'application/json','Content-Type':'application/json','Idempotency-Key':request.key,'X-HON-Human-Command':'crm-lead-register'},body:request.body}); }
  catch { throw new CrmLeadRegistrationUncertainError('Registration request outcome is uncertain. Retry only the exact retained request or return to the authorized lead row; no success is assumed.'); }
  if([400,401,403,404,409,413,415,422].includes(response.status)) throw new CrmLeadRegistrationRejectedError('Registration command was rejected or current human/school authority, lead gate, source state, or bounded review is unavailable. No registration was assumed.');
  try { if(response.status!==200 || !response.ok || response.redirected || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type')??'')) invalid(); const raw=await response.text(); if(raw.length>12000) invalid(); return parseCrmLeadRegistrationResult(JSON.parse(raw),request); }
  catch { throw new CrmLeadRegistrationUncertainError('No verified registration response. Retry only the exact retained request or return to the authorized lead row; no success is assumed.'); }
}
