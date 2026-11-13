import { BadRequestException, ConflictException, ForbiddenException, HttpException, HttpStatus, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  validateReplyFamilyMessageInput, validateSendFamilyMessageInput, verifyFamilyMessageInbox, verifyFamilyMessageReadMark, verifyFamilyMessageReceipt,
  verifyFamilyMessageThread, verifyParentFamilyMessages,
  type FamilyMessageInbox, type FamilyMessageReadMark, type FamilyMessageReceipt, type FamilyMessageThread, type ParentFamilyMessages,
} from '@hon/contracts';
import { RuntimeDatabaseService, type ResolvedParentFamilyScope } from '../foundation/runtime-database.service.js';
import type { MembershipLifecycleContext } from '../billing/membership.service.js';

const HUMAN_SETTINGS = "SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_external_subject',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)";
const READ_LIMITS = "SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'; SET LOCAL log_parameter_max_length_on_error=0";
const WRITE_LIMITS = "SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='5s'; SET LOCAL log_parameter_max_length_on_error=0";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const ERRORS: Record<string, (code: string) => HttpException> = {
  VALIDATION_FAILED: code => new BadRequestException({ code }),
  FAMILY_MESSAGES_FORBIDDEN: code => new ForbiddenException({ code }),
  FAMILY_MESSAGES_NOT_FOUND: code => new NotFoundException({ code, detail: 'That conversation is not available.' }),
  FAMILY_MESSAGES_RATE_LIMITED: code => new HttpException({ code, detail: 'Too many messages were sent in the last hour. Please try again later.' }, HttpStatus.TOO_MANY_REQUESTS),
  IDEMPOTENCY_KEY_REUSED: code => new ConflictException({ code, detail: 'The idempotency key was already used for a different command.' }),
  IDEMPOTENCY_IN_PROGRESS: code => new ConflictException({ code, detail: 'The matching command is being processed.' }),
};
function translate(error: unknown): never {
  if (error instanceof HttpException) throw error;
  const sqlState = (error as { code?: string })?.code ?? '';
  const message = (error as { message?: string })?.message ?? '';
  const known = ERRORS[message];
  if (known && ['22023', '42501', 'P0002', '40001', '23505', '53400'].includes(sqlState)) throw known(message);
  if (sqlState === '42501') throw new ForbiddenException({ code: 'FAMILY_MESSAGES_FORBIDDEN' });
  if (['40001', '40P01', '55P03', '23505'].includes(sqlState)) throw new ConflictException({ code: 'FAMILY_MESSAGES_CONFLICT' });
  if (['22023', '22P02', '23514'].includes(sqlState)) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
  throw new ServiceUnavailableException({ code: 'FAMILY_MESSAGES_UNAVAILABLE', detail: 'No verified message result is available.' });
}
function subjectOk(subject: unknown): subject is string {
  return typeof subject === 'string' && subject.length > 0 && subject.length <= 200 && subject.trim() === subject;
}
function keyOk(key: unknown): key is string {
  return typeof key === 'string' && key.length > 0 && key.trim() === key && key.length <= 200 && !/[\u0000-\u001f\u007f]/.test(key);
}
function receiptShape(data: Record<string, unknown> | undefined, rows: number): asserts data is { receipt: unknown; replayed: boolean } {
  if (rows !== 1 || !data || Object.keys(data).sort().join(',') !== 'receipt,replayed' || typeof data.replayed !== 'boolean') throw new Error('Unverified family message receipt.');
}

/**
 * 0330 family messages. Parents: the one live family grant decides the tenant, with no school or family selector trusted.
 * Staff: the guarded route scope plus the live family_messages.manage permission, re-proved by every database call.
 * Nothing here texts, emails or pushes a message.
 */
@Injectable()
export class FamilyMessagesService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  // Parent side.
  private async parentContext(subject: string) {
    const scopes: ResolvedParentFamilyScope[] = await this.database.resolveParentJourneyScopes(subject);
    if (scopes.length !== 1) throw new ForbiddenException({ code: 'FAMILY_MESSAGES_FORBIDDEN' });
    const scope = scopes[0]!;
    return { organizationId: scope.organizationId, schoolId: scope.schoolId, principalId: scope.principalId, principalType: 'HUMAN_USER', requestId: randomUUID() };
  }

  async parentRead(subject: string): Promise<ParentFamilyMessages> {
    if (!subjectOk(subject)) throw new ForbiddenException({ code: 'FAMILY_MESSAGES_FORBIDDEN' });
    try {
      const context = await this.parentContext(subject);
      return await this.database.withTenantReadOnlyTransaction(context, async client => {
        await client.query(READ_LIMITS);
        await client.query(HUMAN_SETTINGS, [subject]);
        return verifyParentFamilyMessages(await this.one(client, 'SELECT hon.read_parent_family_messages($1) AS data', [subject]));
      });
    } catch (error) { return translate(error); }
  }

  async parentSend(subject: string, value: unknown, key: unknown): Promise<{ receipt: FamilyMessageReceipt; replayed: boolean }> {
    let input;
    try { input = validateSendFamilyMessageInput(value); } catch { throw new BadRequestException({ code: 'VALIDATION_FAILED' }); }
    if (!subjectOk(subject)) throw new ForbiddenException({ code: 'FAMILY_MESSAGES_FORBIDDEN' });
    if (!keyOk(key)) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'A unique Idempotency-Key header is required.' });
    try {
      const context = await this.parentContext(subject);
      return await this.database.withTenantTransaction(context, async client => {
        await client.query(WRITE_LIMITS);
        await client.query(HUMAN_SETTINGS, [subject]);
        const result = await client.query<{ data: Record<string, unknown> }>('SELECT hon.send_parent_family_message($1,$2::jsonb,$3,$4::uuid,$5::uuid) AS data',
          [subject, JSON.stringify(input), key, context.requestId, context.requestId]);
        const data = result.rows[0]?.data;
        receiptShape(data, result.rows.length);
        return { receipt: verifyFamilyMessageReceipt(data.receipt, { from: 'FAMILY', body: input.body }), replayed: data.replayed };
      });
    } catch (error) { return translate(error); }
  }

  // Staff side.
  async inbox(context: MembershipLifecycleContext): Promise<FamilyMessageInbox> {
    this.assertStaff(context, false);
    return this.staffRead(context, 'SELECT hon.read_family_message_inbox($1) AS data', [context.externalSubject], verifyFamilyMessageInbox);
  }

  async thread(context: MembershipLifecycleContext, threadId: string): Promise<FamilyMessageThread> {
    this.assertStaff(context, false);
    if (typeof threadId !== 'string' || !UUID.test(threadId)) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    return this.staffRead(context, 'SELECT hon.read_family_message_thread($1,$2::uuid) AS data', [context.externalSubject, threadId],
      data => verifyFamilyMessageThread(data, threadId));
  }

  async markRead(context: MembershipLifecycleContext, threadId: string): Promise<FamilyMessageReadMark> {
    this.assertStaff(context, false);
    if (typeof threadId !== 'string' || !UUID.test(threadId)) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    try {
      return await this.database.withTenantTransaction(context, async client => {
        await client.query(WRITE_LIMITS);
        await client.query(HUMAN_SETTINGS, [context.externalSubject]);
        const data = await this.one(client, 'SELECT hon.mark_family_message_thread_read($1,$2::jsonb,$3::uuid,$4::uuid) AS data',
          [context.externalSubject, JSON.stringify({ threadId }), context.requestId, context.correlationId]);
        return verifyFamilyMessageReadMark(data, threadId);
      });
    } catch (error) { return translate(error); }
  }

  async reply(context: MembershipLifecycleContext, threadId: string, value: unknown): Promise<{ receipt: FamilyMessageReceipt; replayed: boolean }> {
    this.assertStaff(context, true);
    let input;
    try {
      const body = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
      if (Object.keys(body).join() !== 'body') throw new Error('shape');
      input = validateReplyFamilyMessageInput({ threadId, body: body.body });
    } catch { throw new BadRequestException({ code: 'VALIDATION_FAILED' }); }
    try {
      return await this.database.withTenantTransaction(context, async client => {
        await client.query(WRITE_LIMITS);
        await client.query(HUMAN_SETTINGS, [context.externalSubject]);
        const result = await client.query<{ data: Record<string, unknown> }>('SELECT hon.reply_family_message($1,$2::jsonb,$3,$4::uuid,$5::uuid) AS data',
          [context.externalSubject, JSON.stringify(input), context.idempotencyKey, context.requestId, context.correlationId]);
        const data = result.rows[0]?.data;
        receiptShape(data, result.rows.length);
        return { receipt: verifyFamilyMessageReceipt(data.receipt, { from: 'SCHOOL', body: input.body, threadId }), replayed: data.replayed };
      });
    } catch (error) { return translate(error); }
  }

  private async staffRead<T>(context: MembershipLifecycleContext, statement: string, values: unknown[], verify: (data: unknown) => T): Promise<T> {
    try {
      return await this.database.withTenantReadOnlyTransaction(context, async client => {
        await client.query(READ_LIMITS);
        await client.query(HUMAN_SETTINGS, [context.externalSubject]);
        return verify(await this.one(client, statement, values));
      });
    } catch (error) { return translate(error); }
  }

  private assertStaff(context: MembershipLifecycleContext, command: boolean): void {
    if (context.principalType !== 'HUMAN_USER' || context.source !== 'HUMAN_UI' || context.actionRequestId || context.delegatedByPrincipalId) {
      throw new ForbiddenException({ code: 'HUMAN_COMMAND_REQUIRED', detail: 'Family messages accept only direct human commands.' });
    }
    if (!subjectOk(context.externalSubject)) throw new ForbiddenException({ code: 'FAMILY_MESSAGES_FORBIDDEN' });
    if (!command) {
      if (context.idempotencyKey !== '') throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
      return;
    }
    if (!keyOk(context.idempotencyKey)) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'A unique Idempotency-Key header is required.' });
  }

  private async one(client: PoolClient, statement: string, values: unknown[]): Promise<unknown> {
    const result = await client.query<{ data: unknown }>(statement, values);
    if (result.rows.length !== 1) throw new Error('Unverified family message read.');
    return result.rows[0]!.data;
  }
}
