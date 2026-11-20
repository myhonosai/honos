import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  validateRegisterParentPushDeviceInput, validateUnregisterParentPushDeviceInput, verifyParentPushDeviceReceipt, verifyParentPushUnregisterReceipt,
  type ParentPushDeviceReceipt, type ParentPushStatus, type ParentPushUnregisterReceipt,
} from '@hon/contracts';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';

const HUMAN_SETTINGS = "SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_external_subject',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)";
const WRITE_LIMITS = "SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='5s'; SET LOCAL log_parameter_max_length_on_error=0";
const REGISTER = 'SELECT hon.register_parent_push_device($1,$2::jsonb,$3,$4::uuid,$5::uuid) AS data';
const UNREGISTER = 'SELECT hon.unregister_parent_push_device($1,$2::jsonb,$3,$4::uuid,$5::uuid) AS data';

function translate(error: unknown): never {
  if (error instanceof HttpException) throw error;
  const sqlState = (error as { code?: string })?.code ?? '';
  const message = (error as { message?: string })?.message ?? '';
  if (sqlState === '42501') throw new ForbiddenException({ code: 'PARENT_PUSH_FORBIDDEN' });
  if (message === 'VALIDATION_FAILED' || ['22023', '22P02', '23514'].includes(sqlState)) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
  if (['40001', '40P01', '55P03', '23505'].includes(sqlState)) throw new ConflictException({ code: 'PARENT_PUSH_CONFLICT', detail: 'Please try again.' });
  throw new ServiceUnavailableException({ code: 'PARENT_PUSH_UNAVAILABLE', detail: 'Notifications could not be set up right now.' });
}
function subjectOk(subject: unknown): subject is string {
  return typeof subject === 'string' && subject.length > 0 && subject.length <= 200 && subject.trim() === subject;
}
function keyOk(key: unknown): key is string {
  return typeof key === 'string' && key.length > 0 && key.trim() === key && key.length <= 200 && !/[\u0000-\u001f\u007f]/.test(key);
}

/**
 * 0601: the signed-in family member's phone for announcement notifications. The one live family grant decides the school,
 * with no selector trusted; the database re-proves it after its writes. Registering sends nothing.
 */
@Injectable()
export class ParentPushService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  /** The same owner-approval switch the sender uses; nothing about any school or person. */
  status(): ParentPushStatus { return { sending: process.env.HON_PARENT_PUSH_APPROVED === 'true' }; }

  async register(subject: string, value: unknown, key: string): Promise<ParentPushDeviceReceipt> {
    let input;
    try { input = validateRegisterParentPushDeviceInput(value); } catch { throw new BadRequestException({ code: 'VALIDATION_FAILED' }); }
    const data = await this.command(subject, key, REGISTER, input);
    try { return verifyParentPushDeviceReceipt(data, input.platform); } catch { return translate(new Error('Unverified parent push receipt.')); }
  }

  async unregister(subject: string, value: unknown, key: string): Promise<ParentPushUnregisterReceipt> {
    let input;
    try { input = validateUnregisterParentPushDeviceInput(value); } catch { throw new BadRequestException({ code: 'VALIDATION_FAILED' }); }
    const data = await this.command(subject, key, UNREGISTER, input);
    try { return verifyParentPushUnregisterReceipt(data); } catch { return translate(new Error('Unverified parent push receipt.')); }
  }

  private async command(subject: string, key: string, statement: string, input: unknown): Promise<unknown> {
    if (!subjectOk(subject)) throw new ForbiddenException({ code: 'PARENT_PUSH_FORBIDDEN' });
    if (!keyOk(key)) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'A unique Idempotency-Key header is required.' });
    try {
      const scopes = await this.database.resolveParentJourneyScopes(subject);
      if (scopes.length !== 1) throw new ForbiddenException({ code: 'PARENT_PUSH_FORBIDDEN' });
      const scope = scopes[0]!;
      const requestId = randomUUID();
      const context = { organizationId: scope.organizationId, schoolId: scope.schoolId, principalId: scope.principalId, principalType: 'HUMAN_USER', requestId, correlationId: requestId };
      return await this.database.withTenantTransaction(context, async client => {
        await client.query(WRITE_LIMITS);
        await client.query(HUMAN_SETTINGS, [subject]);
        const result = await client.query<{ data: unknown }>(statement, [subject, JSON.stringify(input), key, requestId, requestId]);
        if (result.rows.length !== 1) throw new Error('Unverified parent push result.');
        return result.rows[0]!.data;
      });
    } catch (error) { return translate(error); }
  }
}
