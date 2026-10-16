import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import type { ClassPassAction, ClassPassContext, ClassPassInput, ClassPassReadKind, ClassPassProjection, ClassPassReceipt } from '@hon/contracts';
import { CLASSPASS_UUID, validateClassPassInput } from '@hon/domain';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { markAttendanceHuman, requireAttendanceHuman } from '../schedule/attendance-policy.service.js';
import { attendanceDatabaseError } from '../schedule/attendance-database-error.js';
@Injectable()
export class ClassPassService {
 constructor(private readonly database: RuntimeDatabaseService) {}
 async read(context: ClassPassContext, kind: ClassPassReadKind, id: string): Promise<ClassPassProjection> {
  requireAttendanceHuman(context);
  if (!['PRODUCT','PASS','BOOKING'].includes(kind) || !CLASSPASS_UUID.test(id)) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
  try { return await this.database.withTenantReadOnlyTransaction(context, async client => {
   await markAttendanceHuman(client, context);
   const result = await client.query<{ data: ClassPassProjection }>('SELECT hon.read_classpass($1,$2,$3::uuid) data', [context.externalSubject,kind,id]);
   if (!result.rows[0]) throw new Error('ClassPass exact read unavailable.');
   return result.rows[0].data;
  }); } catch (error) { return attendanceDatabaseError(error); }
 }
 async command(context: ClassPassContext, action: ClassPassAction, target: string, input: ClassPassInput): Promise<ClassPassReceipt> {
  requireAttendanceHuman(context);
  try { validateClassPassInput(action,target,input); } catch { throw new BadRequestException({ code: 'VALIDATION_FAILED' }); }
  if (!context.idempotencyKey || context.idempotencyKey.length > 200 || context.idempotencyKey.trim() !== context.idempotencyKey || /[\x00-\x1f\x7f-\x9f]/.test(context.idempotencyKey)) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
  try { return await this.database.withTenantTransaction(context, async client => {
   await markAttendanceHuman(client, context);
   const result = await client.query<{ data: ClassPassReceipt }>('SELECT hon.command_classpass($1,$2,$3::uuid,$4::jsonb,$5,$6::uuid,$7::uuid) data', [context.externalSubject,action,target,JSON.stringify(input),context.idempotencyKey,context.requestId,context.correlationId]);
   if (!result.rows[0]) throw new Error('ClassPass command receipt unavailable. No outcome assumed.');
   return result.rows[0].data;
  }); } catch (error) { return attendanceDatabaseError(error); }
 }
}
