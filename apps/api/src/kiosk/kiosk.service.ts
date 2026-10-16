import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { KIOSK_OUTCOME, type KioskContext, type KioskClaimInput, type KioskTerminalInput, type KioskClaimResult, type KioskTerminalResult, type KioskPublicInput } from '@hon/contracts';
import { kioskExactInput, KIOSK_UUID } from '@hon/domain';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
@Injectable()
export class KioskService {
 constructor(private readonly database: RuntimeDatabaseService) {}
 private human(context: KioskContext) {
  if (context.principalType !== 'HUMAN_USER' || context.source !== 'HUMAN_UI' || !context.externalSubject || context.actionRequestId || context.delegatedByPrincipalId) throw new ForbiddenException({ code: 'KIOSK_FORBIDDEN' });
 }
 private async staff<T>(context: KioskContext, sql: string, args: unknown[]): Promise<T> {
  this.human(context);
  try {
   return await this.database.withTenantTransaction(context, async client => {
    await client.query("SELECT set_config('app.hon_source',$1,true),set_config('app.hon_external_subject',$2,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)", [context.source,context.externalSubject]);
    // Bind parameters must never be interpolated, audited or logged.
    await client.query("SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='3s'; SET LOCAL log_parameter_max_length_on_error=0");
    const logging = await client.query<{ safe: boolean }>("SELECT current_setting('log_parameter_max_length')='0' safe");
    if (logging.rows[0]?.safe !== true) throw new Error('KIOSK_UNAVAILABLE');
    const result = await client.query<{ data: T }>(sql, args);
    return result.rows[0]!.data;
   });
  } catch (error) {
   if (typeof error === 'object' && error !== null && 'code' in error && error.code === '42501') throw new ForbiddenException({ code: 'KIOSK_FORBIDDEN' });
   throw new BadRequestException({ code: 'KIOSK_UNAVAILABLE' });
  }
 }
 activate(context: KioskContext, id: string, input: KioskTerminalInput): Promise<KioskTerminalResult> {
  this.validate(id,input,['terminalSessionId','terminalSession']);
  return this.staff(context,'SELECT hon.manage_kiosk_terminal($1,\'ACTIVATE\',$2::uuid,$3::uuid,$4) data',[context.externalSubject,id,input.terminalSessionId,input.terminalSession]);
 }
 retire(context: KioskContext, id: string, input: unknown): Promise<KioskTerminalResult> {
  this.validate(id,input,[]);
  return this.staff(context,'SELECT hon.manage_kiosk_terminal($1,\'RETIRE\',$2::uuid,NULL,NULL) data',[context.externalSubject,id]);
 }
 provision(context: KioskContext, id: string, input: KioskClaimInput): Promise<KioskClaimResult> {
  this.validate(id,input,['studentProfileId','classSessionId','claim']);
  return this.staff(context,'SELECT hon.provision_kiosk_claim($1,$2::uuid,$3::uuid,$4::uuid,$5) data',[context.externalSubject,id,input.studentProfileId,input.classSessionId,input.claim]);
 }
 recover(context: KioskContext, id: string): Promise<KioskClaimResult> {
  if (!KIOSK_UUID.test(id)) throw new BadRequestException({code:'KIOSK_INVALID'});
  return this.staff(context,'SELECT hon.read_kiosk_handoff($1,$2::uuid) data',[context.externalSubject,id]);
 }
 private validate(id: string, input: unknown, keys: string[]) {
  try { if (!KIOSK_UUID.test(id)) throw new Error('INVALID'); kioskExactInput(input,keys); }
  catch { throw new BadRequestException({code:'KIOSK_INVALID'}); }
 }
 async submit(input: KioskPublicInput) {
  try { kioskExactInput(input,['terminalSession','claim']); await this.database.submitKioskHandoff(input.terminalSession,input.claim); }
  catch { /* never expose a state, ID, SQL error, secret or persistence oracle */ }
  return { result: KIOSK_OUTCOME };
 }
}
