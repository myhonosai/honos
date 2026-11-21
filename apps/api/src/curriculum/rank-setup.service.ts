import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { isRankSetupId, isValidRankSetupInput, verifyRankSetupProgram, verifyStaffRankSetup,
  type CurriculumResourceContext, type RankSetupOperation, type RankSetupProgram, type StaffRankSetup } from '@hon/contracts';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';

/** Errors the page explains in plain words; anything else maps to the generic classes below. */
const NAMED = ['PROGRAM_NAME_TAKEN', 'RANK_NAME_TAKEN', 'RANK_AT_END', 'PROGRAM_LIMIT', 'RANK_LIMIT'];
function human(c: CurriculumResourceContext) {
 if (c.principalType !== 'HUMAN_USER' || c.source !== 'HUMAN_UI' || c.actionRequestId || c.delegatedByPrincipalId) throw new ForbiddenException({ code: 'HUMAN_COMMAND_REQUIRED' });
 if (![c.organizationId, c.schoolId, c.principalId, c.requestId, c.correlationId].every(isRankSetupId) || typeof c.externalSubject !== 'string' || !c.externalSubject.trim() || c.externalSubject.length > 200)
  throw new ForbiddenException({ code: 'RANK_SETUP_SCOPE_DENIED' });
}
export function rankSetupDatabaseError(e: unknown): never {
 if (e instanceof HttpException) throw e;
 const { code, message } = e as { code?: string; message?: string };
 if (message && NAMED.includes(message)) {
  if (message.endsWith('_LIMIT')) throw new BadRequestException({ code: message });
  throw new ConflictException({ code: message });
 }
 if (code === '42501') throw new ForbiddenException({ code: 'RANK_SETUP_FORBIDDEN' });
 if (code === 'P0002') throw new NotFoundException({ code: 'RANK_SETUP_TARGET_NOT_FOUND' });
 if (message === 'IDEMPOTENCY_KEY_REUSED') throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REUSED' });
 if (['40001', '23505', '55P03', '40P01'].includes(code ?? '')) throw new ConflictException({ code: 'VERSION_CONFLICT' });
 if (['22023', '22P02', '23514', '23503', '22003', '22001'].includes(code ?? '')) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
 if (code === '57014') throw new ServiceUnavailableException({ code: 'RANK_SETUP_TIMEOUT' });
 throw e;
}

@Injectable()
export class RankSetupService {
 constructor(private readonly database: RuntimeDatabaseService) {}
 async read(c: CurriculumResourceContext): Promise<StaffRankSetup> {
  human(c);
  try { return await this.database.withTenantTransaction(c, async (client) => {
   await client.query("SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)");
   await client.query("SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'");
   return verifyStaffRankSetup((await client.query('SELECT hon.read_staff_rank_setup($1) data', [c.externalSubject])).rows[0]?.data);
  }); } catch (e) { return rankSetupDatabaseError(e); }
 }
 async command(c: CurriculumResourceContext, op: RankSetupOperation, programId: string | null, rankId: string | null, input: object): Promise<{ record: RankSetupProgram; replayed: boolean }> {
  human(c);
  if (!isValidRankSetupInput(op, input)) throw new BadRequestException({ code: 'VALIDATION_FAILED', detail: 'Use the closed rank setup fields and the current version.' });
  if ((programId === null) !== (op === 'PROGRAM_CREATE') || (rankId === null) !== (op !== 'RANK_UPDATE' && op !== 'RANK_MOVE')
   || (programId !== null && !isRankSetupId(programId)) || (rankId !== null && !isRankSetupId(rankId))) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
  if (typeof c.idempotencyKey !== 'string' || !c.idempotencyKey || c.idempotencyKey.length > 200 || c.idempotencyKey.trim() !== c.idempotencyKey || /[\u0000-\u001f\u007f]/.test(c.idempotencyKey))
   throw new BadRequestException({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
  try { return await this.database.withTenantTransaction(c, async (client) => {
   await client.query("SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)");
   await client.query("SET LOCAL statement_timeout='15s'; SET LOCAL lock_timeout='5s'");
   const data = (await client.query('SELECT hon.mutate_rank_setup($1,$2,$3::uuid,$4::uuid,$5::jsonb,$6,$7::uuid,$8::uuid) data',
    [c.externalSubject, op, programId, rankId, JSON.stringify(input), c.idempotencyKey, c.requestId, c.correlationId])).rows[0]?.data as { record?: unknown; replayed?: unknown } | undefined;
   if (!data || typeof data !== 'object' || Object.keys(data).sort().join(',') !== 'record,replayed' || typeof data.replayed !== 'boolean') throw new Error('Invalid rank setup receipt.');
   const record = verifyRankSetupProgram(data.record);
   if (programId !== null && record.id !== programId) throw new Error('Rank setup receipt names another program.');
   return { record, replayed: data.replayed };
  }); } catch (e) { return rankSetupDatabaseError(e); }
 }
}
