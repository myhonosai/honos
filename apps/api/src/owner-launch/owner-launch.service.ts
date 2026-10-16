import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ownerLaunchRecord, verifyOwnerLaunchProjection, verifyOwnerLaunchSavedStudentsProjection, verifyRegisterStudentInput, verifyStudentRegistrationReceipt, verifyRegisterGuardianChildInput, verifyGuardianChildRegistrationReceipt, verifyBookOwnerLaunchFirstClassInput, verifyOwnerLaunchFirstClassBookingReceipt, verifyDraftOwnerLaunchMembershipInput, verifyOwnerLaunchMembershipDraftReceipt, verifyOwnerLaunchMembershipDraftConfirmation, verifyOwnerLaunchFirstClassBookingContext, type OwnerLaunchContext } from '@hon/contracts';
import { assertOwnerLaunchHuman, assertGuardianChildDistinct } from '@hon/domain';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
@Injectable()
export class OwnerLaunchService {
  constructor(private readonly database: RuntimeDatabaseService) {}
  private human(context: OwnerLaunchContext) { try { assertOwnerLaunchHuman(context); } catch { throw new ForbiddenException({code:'REGISTRATION_FORBIDDEN',detail:'Only direct human school launch is available.'}); } }
  private failure(error: unknown): never {
    const e = error as {code?:string;message?:string};
    if (e.code==='42501') throw new ForbiddenException({code:'REGISTRATION_FORBIDDEN',detail:'Current direct-human school permission and active tier are required. Clear saved context.'});
    if (e.code==='23505' || e.code==='40001') throw new ConflictException({code:'REGISTRATION_CONFLICT',detail:'The retry key or expected saved versions conflict. Reload saved receipts; do not create a second student.'});
    if (e.code==='P0002') throw new NotFoundException({code:'REGISTRATION_UNAVAILABLE',detail:'The exact current-school program and class are unavailable.'});
    if (e.message==='REGISTRATION_NEEDS_STAFF') throw new BadRequestException({code:'REGISTRATION_NEEDS_STAFF',detail:'Needs staff: potential existing identity, guardian/child age or class eligibility cannot be safely inferred. No registration was saved.'});
    if (['22023','22007','22008','22P02'].includes(e.code??'')) throw new BadRequestException({code:'VALIDATION_FAILED',detail:'Only exact bounded registration input is accepted.'});
    throw new ServiceUnavailableException({code:'REGISTRATION_UNAVAILABLE',detail:'Registration outcome is unavailable. Reload saved receipts or retry the same input and key; do not assume success.'});
  }
  async read(context: OwnerLaunchContext) {
    this.human(context);
    try { return verifyOwnerLaunchProjection(await this.database.ownerLaunchCommand(context)); } catch (error) { return this.failure(error); }
  }
  async readSavedStudents(context: OwnerLaunchContext) {
    this.human(context);
    try { return verifyOwnerLaunchSavedStudentsProjection(await this.database.readOwnerLaunchSavedStudents(context)); } catch (error) { return this.failure(error); }
  }
  async readFirstClassBookingContext(context: OwnerLaunchContext) {
    this.human(context);
    try { return verifyOwnerLaunchFirstClassBookingContext(await this.database.readOwnerLaunchFirstClassBookingContext(context)); }
    catch(error) {
      if ((error as {code?:string}).code === '42501') throw new ForbiddenException({code:'BOOKING_FORBIDDEN',detail:'Current direct-human owner-launch, booking and applicable family authority with an active tier are required. Clear saved booking context.'});
      throw new ServiceUnavailableException({code:'BOOKING_UNAVAILABLE',detail:'Current receipt-linked booking confirmation is unavailable. No attendance, membership, payment, eligibility, parent access or communication is claimed.'});
    }
  }
  async readMembershipDraft(context: OwnerLaunchContext) {
    this.human(context);
    try { return verifyOwnerLaunchMembershipDraftConfirmation(await this.database.readOwnerLaunchMembershipDraft(context)); }
    catch(error) {
      if ((error as {code?:string}).code === '42501') throw new ForbiddenException({code:'MEMBERSHIP_DRAFT_FORBIDDEN',detail:'Current direct-human owner-launch and billing authority with an active tier are required. Clear saved DRAFT context.'});
      throw new ServiceUnavailableException({code:'MEMBERSHIP_DRAFT_UNAVAILABLE',detail:'Current DRAFT confirmation is unavailable. No activation, agreement, payment, invoice, schedule or communication is claimed.'});
    }
  }
  async register(context: OwnerLaunchContext, value: unknown) {
    this.human(context);
    let input;
    try { input=verifyRegisterStudentInput(value); } catch { throw new BadRequestException({code:'VALIDATION_FAILED',detail:'Only exact names, birth date, new-adult attestation and saved program/class versions are accepted.'}); }
    if (!context.idempotencyKey || context.idempotencyKey.trim()!==context.idempotencyKey || context.idempotencyKey.length>200 || /[\x00-\x1f\x7f]/.test(context.idempotencyKey)) throw new ConflictException({code:'IDEMPOTENCY_KEY_REQUIRED',detail:'A bounded Idempotency-Key is required.'});
    try {
      const row=ownerLaunchRecord(await this.database.ownerLaunchCommand(context,input),['receipt','replayed']);
      if (typeof row.replayed!=='boolean') throw new Error('Invalid replay result');
      return {receipt:verifyStudentRegistrationReceipt(row.receipt,input),replayed:row.replayed};
    } catch (error) { return this.failure(error); }
  }
  async registerGuardianChild(context: OwnerLaunchContext, value: unknown) {
    this.human(context);
    let input;
    try { input=verifyRegisterGuardianChildInput(value); } catch { throw new BadRequestException({code:'VALIDATION_FAILED',detail:'Exactly one new guardian/child pair, attestation and saved program/class versions are required.'}); }
    try { assertGuardianChildDistinct(input); } catch { throw new BadRequestException({code:'REGISTRATION_NEEDS_STAFF',detail:'Guardian and child must be different people. No registration was saved.'}); }
    if (!context.idempotencyKey || context.idempotencyKey.trim()!==context.idempotencyKey || context.idempotencyKey.length>200 || /[\x00-\x1f\x7f]/.test(context.idempotencyKey)) throw new ConflictException({code:'IDEMPOTENCY_KEY_REQUIRED',detail:'A bounded Idempotency-Key is required.'});
    try {
      const row=ownerLaunchRecord(await this.database.ownerLaunchGuardianChildCommand(context,input),['receipt','replayed']);
      if(typeof row.replayed!=='boolean') throw new Error('Invalid replay result');
      return {receipt:verifyGuardianChildRegistrationReceipt(row.receipt,input),replayed:row.replayed};
    } catch(error) { return this.failure(error); }
  }
  async bookFirstClass(context: OwnerLaunchContext, value: unknown) {
    this.human(context);
    let input;
    try { input=verifyBookOwnerLaunchFirstClassInput(value); } catch { throw new BadRequestException({code:'VALIDATION_FAILED',detail:'Only one exact saved registration receipt plus expected receipt/class versions is accepted. No student, family, program, class or school selector is available.'}); }
    if (!context.idempotencyKey || context.idempotencyKey.trim()!==context.idempotencyKey || context.idempotencyKey.length>200 || /[\x00-\x1f\x7f]/.test(context.idempotencyKey)) throw new ConflictException({code:'IDEMPOTENCY_KEY_REQUIRED',detail:'A bounded Idempotency-Key is required.'});
    try {
      const row=ownerLaunchRecord(await this.database.bookOwnerLaunchFirstClass(context,input),['registrationId','bookingId','classSessionId','status','bookingVersion','recordedAt','replayed']);
      if(typeof row.replayed!=='boolean') throw new Error('Invalid replay result');
      return {receipt:verifyOwnerLaunchFirstClassBookingReceipt({registrationId:row.registrationId,bookingId:row.bookingId,classSessionId:row.classSessionId,status:row.status,bookingVersion:row.bookingVersion,recordedAt:row.recordedAt},input),replayed:row.replayed};
    } catch (error) {
      const e=error as {code?:string;message?:string};
      if(e.code==='42501') throw new ForbiddenException({code:'BOOKING_FORBIDDEN',detail:'Current direct-human owner-launch and booking authority with an active tier are required. No booking outcome is assumed.'});
      if(e.code==='23505'||e.code==='40001') throw new ConflictException({code:'BOOKING_CONFLICT',detail:'The receipt/class version or retry key is stale or conflicts. Reload the saved receipt; do not assume booking.'});
      if(e.code==='P0002') throw new NotFoundException({code:'BOOKING_UNAVAILABLE',detail:'The current requester-owned saved receipt relation is unavailable. No booking was created.'});
      if(['22023','22007','22008','22P02'].includes(e.code??'')) throw new BadRequestException({code:'BOOKING_NEEDS_STAFF',detail:'Booking needs staff because the exact saved class context is unavailable or no longer safely bookable. No membership, payment, attendance, eligibility or parent-contact outcome is claimed.'});
      throw new ServiceUnavailableException({code:'BOOKING_UNAVAILABLE',detail:'Booking outcome is unavailable. Reload the saved receipt or retry the exact same request and key; do not assume success.'});
    }
  }
  async draftMembership(context: OwnerLaunchContext, value: unknown) {
    this.human(context);
    let input;
    try { input=verifyDraftOwnerLaunchMembershipInput(value); } catch { throw new BadRequestException({code:'VALIDATION_FAILED',detail:'Only a saved receipt, expected receipt version 1, bounded opaque plan code, explicit fixed terms and exact ISO currency are accepted. No price, payer, participant, schedule or activation selector is available.'}); }
    if (!context.idempotencyKey || context.idempotencyKey.trim()!==context.idempotencyKey || context.idempotencyKey.length>200 || /[\x00-\x1f\x7f]/.test(context.idempotencyKey)) throw new ConflictException({code:'IDEMPOTENCY_KEY_REQUIRED',detail:'A bounded Idempotency-Key is required.'});
    try {
      const row=ownerLaunchRecord(await this.database.draftOwnerLaunchMembership(context,input),['registrationId','membershipId','state','membershipVersion','planCode','termStartedAt','termEndsAt','currency','billingAccountCreated','recordedAt','replayed']);
      if(typeof row.replayed!=='boolean') throw new Error('Invalid replay result');
      const {replayed,...receipt}=row;
      return {receipt:verifyOwnerLaunchMembershipDraftReceipt(receipt,input),replayed};
    } catch(error) {
      const e=error as {code?:string;message?:string};
      if(e.code==='42501') throw new ForbiddenException({code:'MEMBERSHIP_DRAFT_FORBIDDEN',detail:'Current direct-human owner-launch, membership-create and account-create authority with an active tier are required.'});
      if(e.code==='23505'||e.code==='40001') throw new ConflictException({code:'MEMBERSHIP_DRAFT_CONFLICT',detail:'The receipt version, declared draft or retry key conflicts. Retry exact input and key; do not create another membership.'});
      if(e.code==='P0002') throw new NotFoundException({code:'MEMBERSHIP_DRAFT_UNAVAILABLE',detail:'The exact current requester-owned receipt relation is unavailable.'});
      if(e.message==='MEMBERSHIP_DRAFT_NEEDS_STAFF') throw new BadRequestException({code:'MEMBERSHIP_DRAFT_NEEDS_STAFF',detail:'Needs staff: billing account or saved draft context is ambiguous or currency differs. No membership, payment or activation success is claimed.'});
      if(['22023','22007','22008','22P02'].includes(e.code??'')) throw new BadRequestException({code:'VALIDATION_FAILED',detail:'Exact bounded receipt, plan, currency and fixed-term input is required.'});
      throw new ServiceUnavailableException({code:'MEMBERSHIP_DRAFT_UNAVAILABLE',detail:'Draft outcome unavailable. Retry the exact same input and key; do not assume success, activation, payment, invoice or communication.'});
    }
  }

}
