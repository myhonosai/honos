import { BadRequestException, ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { validateVoiceInput, validateVoiceSession, VOICE_UUID, type VoiceContext, type VoiceOperation, type VoiceReceipt, type VoiceSession } from '@hon/contracts';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';

@Injectable()
export class VoiceService {
  constructor(private readonly database: RuntimeDatabaseService) {}
  private human(context: VoiceContext) {
    if (context.principalType !== 'HUMAN_USER' || context.source !== 'HUMAN_UI' || !context.externalSubject || context.actionRequestId || context.delegatedByPrincipalId) throw new ForbiddenException({ code: 'HUMAN_UI_REQUIRED' });
  }
  private async transaction<T>(context: VoiceContext, work: (client: import('pg').PoolClient) => Promise<T>): Promise<T> {
    this.human(context);
    try {
      return await this.database.withTenantTransaction(context, async client => {
        await client.query("SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='5s'");
        await client.query("SELECT set_config('app.hon_source','HUMAN_UI',true), set_config('app.hon_action_request_id','',true), set_config('app.hon_delegated_by_principal_id','',true)");
        return work(client);
      });
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === '42501') throw new ForbiddenException({ code: 'VOICE_SCOPE_UNAVAILABLE', detail: 'Current Complete human school permission or owned session is unavailable.' });
      if (['22023','22P02','23514'].includes(code ?? '')) throw new BadRequestException({ code: 'VALIDATION_FAILED', detail: 'Use only the closed safe session fields.' });
      if (['40001','40P01','55P03','57014'].includes(code ?? '')) throw new ConflictException({ code: 'VOICE_CONFLICT', detail: 'Version, retry, expiry or concurrent access changed. Reload evidence; no connection or execution is assumed.' });
      throw error;
    }
  }
  async read(context: VoiceContext, id: string): Promise<VoiceSession> {
    if (!VOICE_UUID.test(id)) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    return this.transaction(context, async client => {
      const value = (await client.query<{ result: unknown }>('SELECT hon.read_voice_session($1,$2::uuid) AS result', [context.externalSubject,id])).rows[0]?.result;
      validateVoiceSession(value);
      if (value.id !== id || value.schoolId !== context.schoolId || value.organizationId !== context.organizationId || value.actorPrincipalId !== context.principalId) throw new Error('UNVERIFIED_RESULT');
      return value;
    });
  }
  async mutate(context: VoiceContext, operation: VoiceOperation, id: string | null, input: unknown): Promise<VoiceReceipt> {
    this.human(context);
    try { validateVoiceInput(operation,input); } catch { throw new BadRequestException({ code: 'VALIDATION_FAILED', detail: 'Only closed safe session fields and bounded private draft text are accepted.' }); }
    if (!VOICE_UUID.test(context.idempotencyKey) || (operation === 'create') !== (id === null) || (id !== null && !VOICE_UUID.test(id))) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    return this.transaction(context, async client => {
      const value = (await client.query<{ result: VoiceReceipt }>('SELECT hon.mutate_voice_session($1,$2,$3::uuid,$4::jsonb,$5::uuid,$6::uuid,$7::uuid) AS result', [context.externalSubject,operation,id,JSON.stringify(input),context.idempotencyKey,context.requestId,context.correlationId])).rows[0]?.result;
      if (!value || Object.keys(value).sort().join(',') !== 'receiptVersion,replayed,session' || typeof value.replayed !== 'boolean' || !Number.isInteger(value.receiptVersion) || value.receiptVersion < 1) throw new Error('UNVERIFIED_RESULT');
      validateVoiceSession(value.session);
      if (value.receiptVersion > value.session.version || value.session.organizationId !== context.organizationId || value.session.schoolId !== context.schoolId || value.session.actorPrincipalId !== context.principalId || (id !== null && value.session.id !== id)) throw new Error('UNVERIFIED_RESULT');
      return value;
    });
  }
}
