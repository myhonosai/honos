import type { KioskClaimInput, KioskClaimResult, KioskTerminalInput, KioskTerminalResult } from '@hon/contracts';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SECRET=/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
export function newKioskSecret(): string {
 const bytes=crypto.getRandomValues(new Uint8Array(32));
 return btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
}
export async function submitKiosk(terminalSession: string,claim: string): Promise<void> {
 if(!SECRET.test(terminalSession)||!SECRET.test(claim))return;
 try {
  // This is the only guest request. Never send session cookies, identity, scope or a referrer.
  await fetch('/api/v1/kiosk/handoffs',{method:'POST',credentials:'omit',mode:'same-origin',cache:'no-store',referrerPolicy:'no-referrer',redirect:'error',headers:{'Content-Type':'application/json'},body:JSON.stringify({terminalSession,claim})});
 } catch {/* same needs-staff outcome, including unknown network outcome */}
}
export interface KioskScope {organizationId:string;schoolId:string}
export function kioskStaffPath(scope:KioskScope,kind:'terminals'|'claims',id:string,action?:'activate'|'retire'|'provision') {
 if(![scope.organizationId,scope.schoolId,id].every(v=>UUID.test(v)))throw new Error('Kiosk unavailable.');
 return `/api/v1/organizations/${scope.organizationId}/schools/${scope.schoolId}/kiosk/${kind}/${id}${action?'/'+action:''}`;
}
function object(v:unknown):Record<string,unknown> {if(!v||typeof v!=='object'||Array.isArray(v))throw new Error('Kiosk unavailable.');return v as Record<string,unknown>;}
export function parseKioskStaffResponse(value:unknown,id:string,kind:'terminals'|'claims'): KioskClaimResult|KioskTerminalResult {
 const envelope=object(value);if(Object.keys(envelope).length!==1||!('data' in envelope))throw new Error('Kiosk unavailable.');
 const data=object(envelope.data);
 const fields=kind==='terminals'?['terminalId','terminalSessionId','state','createdAt','expiresAt','retiredAt']:['claimId','studentProfileId','classSessionId','state','issuedAt','expiresAt','consumedAt','handoff'];
 if(Object.keys(data).some(k=>!fields.includes(k))||data[kind==='terminals'?'terminalId':'claimId']!==id)throw new Error('Kiosk unavailable.');
 for(const [k,v] of Object.entries(data)) {
  if(k.endsWith('Id')&&(!UUID.test(String(v))))throw new Error('Kiosk unavailable.');
  if(k.endsWith('At')&&v!==null&&!Number.isFinite(Date.parse(String(v))))throw new Error('Kiosk unavailable.');
 }
 if(!(kind==='terminals'?['ACTIVE','RETIRED']:['ISSUED','CONSUMED','EXPIRED']).includes(String(data.state)))throw new Error('Kiosk unavailable.');
 if(data.handoff!==undefined&&data.handoff!==null){const h=object(data.handoff);if(Object.keys(h).length!==4||Object.keys(h).some(k=>!['id','terminalSessionId','state','createdAt'].includes(k))||!UUID.test(String(h.id))||!UUID.test(String(h.terminalSessionId))||h.state!=='PENDING_STAFF_REVIEW'||!Number.isFinite(Date.parse(String(h.createdAt))))throw new Error('Kiosk unavailable.');}
 return data as unknown as KioskClaimResult|KioskTerminalResult;
}
export async function kioskStaffRequest(scope:KioskScope,kind:'terminals'|'claims',id:string,action?:'activate'|'retire'|'provision',input?:KioskTerminalInput|KioskClaimInput|Record<string,never>) {
 const response=await fetch(kioskStaffPath(scope,kind,id,action),{method:action?'POST':'GET',credentials:'same-origin',mode:'same-origin',cache:'no-store',referrerPolicy:'no-referrer',redirect:'error',headers:{'X-HON-Human-Command':'kiosk',...(action?{'Content-Type':'application/json'}:{})},...(action?{body:JSON.stringify(input)}:{})});
 if(!response.ok)throw new Error('Kiosk unavailable. No admission or other outcome is assumed.');
 return parseKioskStaffResponse(await response.json(),id,kind);
}
