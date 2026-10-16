import { ownerLaunchId, ownerLaunchRecord, verifyOwnerLaunchProjection, verifyStudentRegistrationReceipt, verifyLaunchProgramReceipt, verifyLaunchClassReceipt, verifyRegisterStudentInput, verifyRegisterGuardianChildInput, verifyGuardianChildRegistrationReceipt, verifyBookOwnerLaunchFirstClassInput, verifyOwnerLaunchFirstClassBookingReceipt, verifyDraftOwnerLaunchMembershipInput, verifyOwnerLaunchMembershipDraftReceipt, verifyOwnerLaunchMembershipDraftConfirmation, verifyOwnerLaunchFirstClassBookingContext, type OwnerLaunchProjection, type RegisterStudentInput, type BookOwnerLaunchFirstClassInput } from '@hon/contracts';
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

/** One fixed receipt-authorized booking path. No program/class/student/family/school selector is accepted. */
export async function postOwnerLaunchFirstClassBooking(context: OwnerLaunchProjection, value: unknown, key: string) {
  if (!/^[0-9a-f-]{36}$/i.test(key)) throw new Error('A generated retry key is required.');
  const input=verifyBookOwnerLaunchFirstClassInput(value) as BookOwnerLaunchFirstClassInput;
  const saved=context.guardianChildRegistration??context.registration;
  if(!saved || !context.classSession || saved.registrationId!==input.registrationId || saved.classSessionId!==context.classSession.id || input.expectedClassSessionVersion!==context.classSession.version) throw new Error('Only the exact saved registration receipt and current saved class version can be booked.');
  const result=await request('/api/v1/owner-launch/first-class-booking',{method:'POST',headers:{Accept:'application/json','Content-Type':'application/json','Idempotency-Key':key,'X-HON-Human-Command':'owner-launch-first-class-booking'},body:JSON.stringify(input)});
  const receipt=verifyOwnerLaunchFirstClassBookingReceipt(result.data,input);
  if(receipt.classSessionId!==context.classSession.id) throw new Error('Unverified saved class linkage.');
  return receipt;
}

/** One fixed, same-origin receipt-only DRAFT declaration. No activation or payment path. */
export async function postOwnerLaunchMembershipDraft(context: OwnerLaunchProjection, value: unknown, key: string) {
  if (!/^[0-9a-f-]{36}$/i.test(key)) throw new Error('A generated retry key is required.');
  const input=verifyDraftOwnerLaunchMembershipInput(value);
  const saved=context.guardianChildRegistration??context.registration;
  if(!saved || saved.registrationId!==input.registrationId) throw new Error('Only the exact saved registration receipt can declare a DRAFT membership.');
  try {
    const result=await request('/api/v1/owner-launch/membership-draft',{method:'POST',headers:{Accept:'application/json','Content-Type':'application/json','Idempotency-Key':key,'X-HON-Human-Command':'owner-launch-membership-draft'},body:JSON.stringify(input)});
    return verifyOwnerLaunchMembershipDraftReceipt(result.data,input);
  } catch(error) {
    if(error instanceof OwnerLaunchAccessError) {
      const message=[401,403].includes(error.status)?'Direct human school/billing authority or active tier is unavailable. Saved context was cleared.':error.status===400?'Needs staff or invalid input: exact fixed terms and currency are required; ambiguous or different-currency accounts cannot be selected. No draft success is claimed.':error.status===409?'Saved receipt, declared draft or retry key conflicts. Retry exact input and key; do not create a second membership.':'DRAFT outcome unavailable. Retry the exact same input and key; do not assume payment, activation, invoice or communication.';
      throw new OwnerLaunchAccessError(message,error.status);
    }
    throw error;
  }
}

/** Selector-free same-origin no-store GET; no human command marker, body or IDs. */
export async function loadOwnerLaunchMembershipDraft() {
  try {
    const envelope=await request('/api/v1/owner-launch/membership-draft',{method:'GET',headers:{Accept:'application/json'}});
    return verifyOwnerLaunchMembershipDraftConfirmation(envelope.data);
  } catch(error) {
    if(error instanceof OwnerLaunchAccessError) throw new OwnerLaunchAccessError([401,403].includes(error.status)?'Current human school/billing authority is unavailable. Saved DRAFT context was cleared.':'DRAFT confirmation unavailable. No activation, agreement, payment, invoice, schedule or communication is claimed.',error.status);
    throw new Error('Unverified DRAFT confirmation. No saved membership configuration can be shown.');
  }
}

/** Bind independent reads to the launch receipt; never display a stale/foreign confirmation. */
export async function loadOwnerLaunchWithDraft() {
  const context=await loadOwnerLaunch();
  const confirmation=await loadOwnerLaunchMembershipDraft();
  const saved=context.guardianChildRegistration??context.registration;
  if(confirmation.receipt && confirmation.receipt.registrationId!==saved?.registrationId) throw new Error('DRAFT confirmation unavailable: saved receipt context changed. Reload before continuing.');
  return {context,confirmation};
}

/** Fixed GET only: no IDs, query, body, retry key or human-command marker. */
export async function loadOwnerLaunchFirstClassBookingContext() {
  try {
    const envelope=await request('/api/v1/owner-launch/first-class-booking-context',{method:'GET',headers:{Accept:'application/json'}});
    ownerLaunchRecord(envelope,['data']);
    return verifyOwnerLaunchFirstClassBookingContext(envelope.data);
  } catch(error) {
    if(error instanceof OwnerLaunchAccessError) throw new OwnerLaunchAccessError([401,403].includes(error.status)?'Current human school/booking authority is unavailable. Saved booking context was cleared.':'Booking confirmation unavailable. No attendance, membership, payment, eligibility, parent access or communication is claimed.',error.status);
    throw new Error('Unverified booking confirmation. No current saved booking context can be shown.');
  }
}

/** Independent confirmations are bound to the verified saved receipt, never UI selectors. */
export async function loadOwnerLaunchWithConfirmations() {
  const {context,confirmation}=await loadOwnerLaunchWithDraft();
  const bookingConfirmation=await loadOwnerLaunchFirstClassBookingContext();
  const saved=context.guardianChildRegistration??context.registration;
  const booking=bookingConfirmation.context;
  if(booking && (!saved || booking.registrationId!==saved.registrationId || booking.student.studentProfileId!==saved.studentProfileId || booking.classSession.id!==saved.classSessionId || booking.classSession.id!==context.classSession?.id)) throw new Error('Booking confirmation unavailable: saved receipt context changed. Reload before continuing.');
  return {context,confirmation,bookingConfirmation};
}
