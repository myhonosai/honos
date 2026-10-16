import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ownerLaunchRecord, verifyOwnerLaunchProjection, verifyRegisterStudentInput, verifyStudentRegistrationReceipt, type OwnerLaunchContext } from '@hon/contracts';
import { assertOwnerLaunchHuman } from '@hon/domain';
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
    if (e.message==='REGISTRATION_NEEDS_STAFF') throw new BadRequestException({code:'REGISTRATION_NEEDS_STAFF',detail:'Needs staff: child/guardian, existing identity, program age or class eligibility cannot be safely inferred. No registration was saved.'});
    if (['22023','22007','22008','22P02'].includes(e.code??'')) throw new BadRequestException({code:'VALIDATION_FAILED',detail:'Only exact bounded new-adult student input is accepted.'});
    throw new ServiceUnavailableException({code:'REGISTRATION_UNAVAILABLE',detail:'Registration outcome is unavailable. Reload saved receipts or retry the same input and key; do not assume success.'});
  }
  async read(context: OwnerLaunchContext) {
    this.human(context);
    try { return verifyOwnerLaunchProjection(await this.database.ownerLaunchCommand(context)); } catch (error) { return this.failure(error); }
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
}
