import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, NotFoundException, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import {
  validateContactEmailResendInput, validateContactHistoryQuery, verifyContactEmailResendReceipt, verifyContactEmailView, verifyContactHistory,
  type ContactEmailResendReceipt, type ContactEmailView, type ContactHistory,
} from '@hon/contracts';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import type { MembershipLifecycleContext } from '../billing/membership.service.js';

const HUMAN_SETTINGS = "SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_external_subject',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)";
const READ_LIMITS = "SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'; SET LOCAL log_parameter_max_length_on_error=0";
const WRITE_LIMITS = "SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='5s'; SET LOCAL log_parameter_max_length_on_error=0";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Why a resend cannot happen now: a person can act on each. Nothing was queued. */
const STATE_DETAIL: Record<string, string> = {
  CONTACT_RESEND_NOT_SENT: 'Only an email that was queued can be sent again.',
  CONTACT_RESEND_EMAIL_MISSING: 'This person has no saved email address. Add one first.',
  CONTACT_RESEND_CONSENT_REQUIRED: 'This person has not agreed to receive email from the school, or unsubscribed. Record their email consent first.',
  CONTACT_RESEND_LIMIT_REACHED: 'This email was already sent again 3 times today, or this person was sent 10 resends today.',
};

function translate(error: unknown): never {
  if (error instanceof HttpException) throw error;
  const sqlState = (error as { code?: string })?.code ?? '';
  const message = (error as { message?: string })?.message ?? '';
  if (sqlState === '55000' && STATE_DETAIL[message]) throw new UnprocessableEntityException({ code: message, detail: STATE_DETAIL[message] });
  if (sqlState === '42501') throw new ForbiddenException({ code: 'CONVERSATION_FORBIDDEN' });
  if (sqlState === 'P0002' && (message === 'CONTACT_NOT_FOUND' || message === 'CONTACT_MESSAGE_NOT_FOUND')) {
    throw new NotFoundException({ code: message, detail: message === 'CONTACT_NOT_FOUND' ? 'That person is not available.' : 'That email is not available.' });
  }
  if (sqlState === '23505' && message === 'IDEMPOTENCY_KEY_REUSED') throw new ConflictException({ code: message, detail: 'The idempotency key was already used for a different command.' });
  if (sqlState === '40001' && message === 'IDEMPOTENCY_IN_PROGRESS') throw new ConflictException({ code: message, detail: 'The matching command is being processed.' });
  if (['40001', '40P01', '55P03', '23505'].includes(sqlState)) throw new ConflictException({ code: 'CONTACT_HISTORY_CONFLICT' });
  if (['22023', '22P02', '23514'].includes(sqlState)) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
  throw new ServiceUnavailableException({ code: 'CONTACT_HISTORY_UNAVAILABLE', detail: 'No verified message history result is available.' });
}
function subjectOk(subject: unknown): subject is string {
  return typeof subject === 'string' && subject.length > 0 && subject.length <= 200 && subject.trim() === subject;
}
function keyOk(key: unknown): key is string {
  return typeof key === 'string' && key.length > 0 && key.trim() === key && key.length <= 200 && !/[\u0000-\u001f\u007f]/.test(key);
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value.toLowerCase())) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
  return value.toLowerCase();
}

/**
 * 0424 one person's messages (CA1b). The guarded route scope plus the live conversation.read permission (reading) or
 * conversation.manage and communication.message.queue (resending), re-proved by every database call. A resend only queues
 * a consent-gated email through the 0047 queue; the 0243 worker sends it to the person's saved address.
 */
@Injectable()
export class ContactMessagesService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  async history(context: MembershipLifecycleContext, personId: string, query: unknown): Promise<ContactHistory> {
    this.assertStaff(context, false);
    const person = id(personId);
    let input;
    try { input = validateContactHistoryQuery(query); } catch { throw new BadRequestException({ code: 'VALIDATION_FAILED' }); }
    return this.read(context, 'SELECT hon.read_contact_message_history($1,$2::uuid,$3::jsonb) AS data', [context.externalSubject, person, JSON.stringify(input)],
      data => verifyContactHistory(data, person));
  }

  async email(context: MembershipLifecycleContext, personId: string, messageId: string): Promise<ContactEmailView> {
    this.assertStaff(context, false);
    const expected = { personId: id(personId), messageId: id(messageId) };
    return this.read(context, 'SELECT hon.read_contact_message_email($1,$2::uuid,$3::uuid) AS data', [context.externalSubject, expected.personId, expected.messageId],
      data => verifyContactEmailView(data, expected));
  }

  async resend(context: MembershipLifecycleContext, personId: string, messageId: string, body: unknown): Promise<{ receipt: ContactEmailResendReceipt; replayed: boolean }> {
    // The person and message come from the route only; the body must be an empty object.
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    let input;
    try { input = validateContactEmailResendInput({ personId: id(personId), messageId: id(messageId) }); } catch (error) {
      if (error instanceof HttpException) throw error; throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    }
    this.assertStaff(context, true);
    try {
      return await this.database.withTenantTransaction(context, async client => {
        await client.query(WRITE_LIMITS);
        await client.query(HUMAN_SETTINGS, [context.externalSubject]);
        const result = await client.query<{ data: Record<string, unknown> }>('SELECT hon.resend_contact_message_email($1,$2::jsonb,$3,$4::uuid,$5::uuid) AS data',
          [context.externalSubject, JSON.stringify(input), context.idempotencyKey, context.requestId, context.correlationId]);
        const data = result.rows[0]?.data;
        if (result.rows.length !== 1 || !data || Object.keys(data).sort().join(',') !== 'receipt,replayed' || typeof data.replayed !== 'boolean') {
          throw new Error('Unverified resend receipt.');
        }
        return { receipt: verifyContactEmailResendReceipt(data.receipt, input), replayed: data.replayed };
      });
    } catch (error) { return translate(error); }
  }

  private async read<T>(context: MembershipLifecycleContext, statement: string, values: unknown[], verify: (data: unknown) => T): Promise<T> {
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
      throw new ForbiddenException({ code: 'HUMAN_COMMAND_REQUIRED', detail: 'Message history accepts only direct human commands.' });
    }
    if (!subjectOk(context.externalSubject)) throw new ForbiddenException({ code: 'CONVERSATION_FORBIDDEN' });
    if (!command) {
      if (context.idempotencyKey !== '') throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
      return;
    }
    if (!keyOk(context.idempotencyKey)) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'A unique Idempotency-Key header is required.' });
  }

  private async one(client: PoolClient, statement: string, values: unknown[]): Promise<unknown> {
    const result = await client.query<{ data: unknown }>(statement, values);
    if (result.rows.length !== 1) throw new Error('Unverified message history read.');
    return result.rows[0]!.data;
  }
}
