import { CLASSPASS_ACTIONS, type ClassPassAction, type ClassPassInput, type ClassPassReadKind, type ClassPassProjection, type ClassPassReceipt } from '@hon/contracts';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export interface ClassPassScope { organizationId: string; schoolId: string }
const invalid=():never=>{throw new Error('Exact ClassPass result unavailable. No booking, redemption, attendance or payment outcome is assumed.');};
export function classPassPath(scope:ClassPassScope, operation:ClassPassAction|ClassPassReadKind,id:string):string {
 if (![scope.organizationId,scope.schoolId,id].every(x=>UUID.test(x))) invalid();
 const base=`/api/v1/organizations/${scope.organizationId}/schools/${scope.schoolId}/classpass`;
 if (CLASSPASS_ACTIONS.includes(operation as ClassPassAction)) return `${base}/commands/${operation}/${id}`;
 if (!['PRODUCT','PASS','BOOKING'].includes(operation)) invalid();
 return `${base}/${operation}/${id}`;
}
export function assertClassPassEndpoint(path:string, mutation:boolean):void {
 const u='[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
 const op=mutation?`commands/(?:${CLASSPASS_ACTIONS.join('|')})`:'(?:PRODUCT|PASS|BOOKING)';
 if (!new RegExp(`^/api/v1/organizations/${u}/schools/${u}/classpass/${op}/${u}$`).test(path)) invalid();
}
function object(value:unknown):Record<string,unknown> { if(!value||typeof value!=='object'||Array.isArray(value)) invalid();return value as Record<string,unknown>; }
function number(value:unknown,min=0,max=2147483647):boolean { return Number.isInteger(value)&&Number(value)>=min&&Number(value)<=max; }
export function parseClassPassEnvelope(value:unknown,operation:ClassPassAction|ClassPassReadKind,target:string,input?:ClassPassInput):ClassPassProjection|ClassPassReceipt {
 const envelope=object(value),data=object(envelope.data),meta=object(envelope.meta); const mutation=CLASSPASS_ACTIONS.includes(operation as ClassPassAction);
 if(Object.keys(envelope).some(k=>!['data','meta'].includes(k))||!UUID.test(String(meta.requestId))||!UUID.test(String(meta.correlationId))||Object.keys(meta).some(k=>!['requestId','correlationId',...(mutation?['replayed']:[])].includes(k))||mutation&&typeof meta.replayed!=='boolean') invalid();
 const fields=['id','version','status','programId','name','allowedUses','validityDays','allowedBookingPolicy','productId','studentProfileId','issuanceKind','productVersion','productName','remainingUses','programVersion','programName','minimumAgeMonths','maximumAgeMonths','issuedAt','expiresAt','expired','ledger','passId','decision','booking','classSessionId','bookingKind','paymentProviderOutcome','attendanceOutcome','externalEffects','replayed','parentProjection'];
 if(Object.keys(data).some(k=>!fields.includes(k))||!UUID.test(String(data.id))||!number(data.version,1)||data.paymentProviderOutcome!=='UNAVAILABLE'||data.attendanceOutcome!=='NOT_RECORDED_BY_CLASSPASS') invalid();
 if(mutation) {
  if(data.externalEffects!=='NONE'||data.replayed!==meta.replayed||!input) invalid();
  const i=input as unknown as Record<string,unknown>;
  if(operation==='ISSUE') { if(data.productId!==target||data.studentProfileId!==i.studentProfileId||data.issuanceKind!=='MANUAL_NONFINANCIAL'||data.version!==1) invalid(); }
  else if(operation==='ADMIT'||operation==='REVERSE_REDEMPTION') {
   if(data.passId!==i.passId||data.id!==i.passId) invalid();
   const b=object(data.booking);
   if(!UUID.test(String(b.id))||b.passId!==i.passId||b.bookingKind!=='CLASS_PASS'||!number(b.version,1)) invalid();
   if(operation==='ADMIT'&&(b.classSessionId!==target||!['ADMITTED_REDEEMED','WAITLISTED_NOT_REDEEMED'].includes(String(data.decision))||b.status!==(data.decision==='ADMITTED_REDEEMED'?'BOOKED':'WAITLISTED'))) invalid();
   if(operation==='REVERSE_REDEMPTION'&&(b.id!==target||b.status!=='CANCELLED'||data.decision!=='REDEMPTION_REVERSED')) invalid();
  } else if(data.id!==target) invalid();
 } else if(data.id!==target||data.parentProjection!=='UNAVAILABLE') invalid();
 if('remainingUses' in data&&!number(data.remainingUses,0,1000)) invalid();
 if('allowedUses' in data&&!number(data.allowedUses,1,1000)) invalid();
 if('ledger' in data) {
  if(!Array.isArray(data.ledger)||data.ledger.length>2002) invalid();
  for(const item of data.ledger as unknown[]) { const l=object(item); if(Object.keys(l).some(k=>!['id','kind','useDelta','classBookingId','reversesLedgerId','passVersion','recordedAt'].includes(k))||!UUID.test(String(l.id))||!['ISSUANCE','REDEMPTION','ISSUANCE_REVERSAL','REDEMPTION_REVERSAL'].includes(String(l.kind))||!number(l.useDelta,-1000,1000)||!number(l.passVersion,1)||!Number.isFinite(Date.parse(String(l.recordedAt)))) invalid(); }
 }
 return data as unknown as ClassPassProjection|ClassPassReceipt;
}
async function request(scope:ClassPassScope,operation:ClassPassAction|ClassPassReadKind,id:string,input?:ClassPassInput,key?:string):Promise<ClassPassReceipt|ClassPassProjection> {
 const mutation=CLASSPASS_ACTIONS.includes(operation as ClassPassAction);const path=classPassPath(scope,operation,id);assertClassPassEndpoint(path,mutation);
 if(mutation&&(!key||key.trim()!==key||key.length>200||/[\x00-\x1f\x7f-\x9f]/.test(key))) invalid();
 const response=await fetch(path,{method:mutation?'POST':'GET',credentials:'same-origin',mode:'same-origin',referrerPolicy:'no-referrer',cache:'no-store',redirect:'error',headers:mutation?{'Content-Type':'application/json','X-HON-Human-Command':'classpass','Idempotency-Key':key!}:{},...(mutation?{body:JSON.stringify(input)}:{})});
 if(!response.ok) {const e=new Error(`ClassPass unavailable (${response.status}).`);Object.assign(e,{status:response.status});throw e;}
 return parseClassPassEnvelope(await response.json(),operation,id,input);
}
export const readClassPass=(scope:ClassPassScope,kind:ClassPassReadKind,id:string)=>request(scope,kind,id);
export const commandClassPass=(scope:ClassPassScope,action:ClassPassAction,id:string,input:ClassPassInput,key:string)=>request(scope,action,id,input,key);
