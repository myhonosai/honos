import { ownerLaunchId, ownerLaunchRecord, verifyOwnerLaunchProjection, verifyStudentRegistrationReceipt, verifyLaunchProgramReceipt, verifyLaunchClassReceipt, verifyRegisterStudentInput, verifyRegisterGuardianChildInput, verifyGuardianChildRegistrationReceipt, type OwnerLaunchProjection, type RegisterStudentInput } from '@hon/contracts';
export class OwnerLaunchAccessError extends Error { constructor(message:string,readonly status:number) { super(message); } }
export function ownerLaunchPath(context: Pick<OwnerLaunchProjection,'organizationId'|'schoolId'>, operation: 'program'|'class'|'student'|'guardian-child'): string {
  const suffix={program:'programs',class:'schedule/sessions',student:'student-registrations','guardian-child':'guardian-child-registrations'}[operation];
  if (!suffix) throw new Error('Unsupported launch operation.');
  return `/api/v1/organizations/${ownerLaunchId(context.organizationId)}/schools/${ownerLaunchId(context.schoolId)}/${suffix}`;
}
async function request(path:string, options:RequestInit): Promise<Record<string,unknown>> {
  const response=await fetch(path,{...options,credentials:'same-origin',cache:'no-store',referrerPolicy:'no-referrer'});
  if (!response.ok) {
    const message=response.status===401?'Sign in with your verified human school session. Saved context was cleared.':response.status===403?'School authority or tier is unavailable. Saved context was cleared.':response.status===409?'Stale versions or retry conflict. Reload saved receipts; do not create a second student.':response.status===400?'Needs staff or invalid input: potential existing identity, guardian/child ages and uncertain eligibility require conventional staff help. No success is claimed.':'Outcome unavailable. Reload saved receipts or retry exactly the same input and key; do not assume success.';
    throw new OwnerLaunchAccessError(message,response.status);
  }
  const value:unknown=await response.json();
  if (!value || typeof value!=='object' || Array.isArray(value)) throw new Error('Unverified launch envelope.');
  const root=value as Record<string,unknown>;
  if (Object.keys(root).some(k=>!['data','meta'].includes(k)) || !Object.hasOwn(root,'data')) throw new Error('Unverified launch envelope.');
  return root;
}
export async function loadOwnerLaunch():Promise<OwnerLaunchProjection> {
  const envelope=await request('/api/v1/owner-launch',{method:'GET',headers:{Accept:'application/json'}});
  return verifyOwnerLaunchProjection(envelope.data);
}
export async function postOwnerLaunch(context:OwnerLaunchProjection, operation:'program'|'class'|'student'|'guardian-child', value:unknown, key:string) {
  if (!/^[0-9a-f-]{36}$/i.test(key)) throw new Error('A generated retry key is required.');
  let input:unknown;
  if (operation==='guardian-child') input=verifyRegisterGuardianChildInput(value);
  else if (operation==='student') input=verifyRegisterStudentInput(value);
  else if (operation==='program') {
    const row=ownerLaunchRecord(value,['name']); if (typeof row.name!=='string' || !row.name.trim() || row.name.length>160) throw new Error('Program name required.'); input={name:row.name.trim()};
  } else {
    const row=ownerLaunchRecord(value,['programId','name','startsAt','endsAt','capacity','bookingPolicy']);
    if (!context.program || ownerLaunchId(row.programId)!==context.program.id || typeof row.name!=='string' || !row.name.trim() || row.name.length>160 || typeof row.capacity!=='number' || !Number.isSafeInteger(row.capacity) || row.capacity<1 || row.bookingPolicy!=='OPTIONAL_BOOKING' || typeof row.startsAt!=='string' || typeof row.endsAt!=='string' || !Number.isFinite(Date.parse(row.startsAt)) || !Number.isFinite(Date.parse(row.endsAt)) || Date.parse(row.endsAt)<=Date.parse(row.startsAt)) throw new Error('Exact saved program and valid class input required.');
    input={programId:row.programId,name:row.name.trim(),startsAt:row.startsAt,endsAt:row.endsAt,capacity:row.capacity,bookingPolicy:'OPTIONAL_BOOKING'};
  }
  const result=await request(ownerLaunchPath(context,operation),{method:'POST',headers:{Accept:'application/json','Content-Type':'application/json','Idempotency-Key':key,'X-HON-Human-Command':operation==='guardian-child'?'owner-launch-guardian-child-registration':'owner-launch-student-registration'},body:JSON.stringify(input)});
  if (operation==='guardian-child') return verifyGuardianChildRegistrationReceipt(result.data,input as RegisterStudentInput);
  if (operation==='student') return verifyStudentRegistrationReceipt(result.data,input as RegisterStudentInput);
  if (!result.data || typeof result.data!=='object' || Array.isArray(result.data)) throw new Error('Unverified creation receipt.');
  const row=result.data as Record<string,unknown>;
  const allowed=operation==='program'?['id','name','description','minimumAgeMonths','maximumAgeMonths','status','version','createdAt']:['id','programId','name','roomName','startsAt','endsAt','capacity','bookingPolicy','status','version','createdAt'];
  if (Object.keys(row).some(k=>!allowed.includes(k))) throw new Error('Unexpected creation receipt fields.');
  if (operation==='program') return verifyLaunchProgramReceipt({id:row.id,status:row.status,version:row.version});
  const receipt=verifyLaunchClassReceipt({id:row.id,programId:row.programId,status:row.status,version:row.version});
  if (receipt.programId!==context.program?.id) throw new Error('Unverified program linkage.');
  return receipt;
}
