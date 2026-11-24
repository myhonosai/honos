import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, NotFoundException, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import {
  validateConversationListQuery, validateCreateConversationLeadInput, validateLinkConversationInput, validateMarkConversationReadInput,
  validateReplyConversationInput, validateUpdateConversationInput, verifyConversationDetail, verifyConversationLinkReceipt, verifyConversationList,
  verifyConversationReadMark, verifyConversationReplyReceipt, verifyConversationUpdateReceipt,
  type ConversationDetail, type ConversationLinkReceipt, type ConversationList, type ConversationReadMark, type ConversationReplyReceipt,
  type ConversationUpdateReceipt,
} from '@hon/contracts';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import type { MembershipLifecycleContext } from '../billing/membership.service.js';

const HUMAN_SETTINGS = "SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_external_subject',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)";
const READ_LIMITS = "SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'; SET LOCAL log_parameter_max_length_on_error=0";
const WRITE_LIMITS = "SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='5s'; SET LOCAL log_parameter_max_length_on_error=0";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** State refusals a person can act on: why the reply or change cannot happen yet. */
const STATE_DETAIL: Record<string, string> = {
  CONVERSATION_NOT_LINKED: 'Link this conversation to a person, or create a lead from it, before replying.',
  CONVERSATION_ADDRESS_MISMATCH: 'The linked person\'s mobile number is not this conversation\'s number.',
  CONVERSATION_NO_SENDER: 'This school has no active texting number yet.',
  CONVERSATION_CONSENT_REQUIRED: 'This person has not agreed to receive texts from the school. Record their texting consent first.',
  CONVERSATION_CHANNEL_UNSUPPORTED: 'Replies on this channel are not available yet.',
  CONVERSATION_ASSIGNEE_INVALID: 'That staff member cannot see conversations at this school.',
  CONVERSATION_LINK_INVALID: 'That person or lead does not belong to this conversation\'s number at this school.',
  CONVERSATION_ALREADY_LINKED: 'This conversation is already linked to a person.',
  CONVERSATION_PIPELINE_INVALID: 'Choose an open stage of one of this school\'s pipelines.',
};

function translate(error: unknown): never {
  if (error instanceof HttpException) throw error;
  const sqlState = (error as { code?: string })?.code ?? '';
  const message = (error as { message?: string })?.message ?? '';
  if (sqlState === '55000' && STATE_DETAIL[message]) throw new UnprocessableEntityException({ code: message, detail: STATE_DETAIL[message] });
  if (sqlState === '42501') throw new ForbiddenException({ code: 'CONVERSATION_FORBIDDEN' });
  if (sqlState === 'P0002' && message === 'CONVERSATION_NOT_FOUND') throw new NotFoundException({ code: message, detail: 'That conversation is not available.' });
  if (sqlState === '40001' && message === 'CONVERSATION_VERSION_CONFLICT') throw new ConflictException({ code: message, detail: 'The conversation changed. Reload it and try again.' });
  if (sqlState === '23505' && message === 'IDEMPOTENCY_KEY_REUSED') throw new ConflictException({ code: message, detail: 'The idempotency key was already used for a different command.' });
  if (sqlState === '40001' && message === 'IDEMPOTENCY_IN_PROGRESS') throw new ConflictException({ code: message, detail: 'The matching command is being processed.' });
  if (['40001', '40P01', '55P03', '23505'].includes(sqlState)) throw new ConflictException({ code: 'CONVERSATION_CONFLICT' });
  if (['22023', '22P02', '23514'].includes(sqlState)) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
  throw new ServiceUnavailableException({ code: 'CONVERSATION_UNAVAILABLE', detail: 'No verified conversation result is available.' });
}
function subjectOk(subject: unknown): subject is string {
  return typeof subject === 'string' && subject.length > 0 && subject.length <= 200 && subject.trim() === subject;
}
function keyOk(key: unknown): key is string {
  return typeof key === 'string' && key.length > 0 && key.trim() === key && key.length <= 200 && !/[\u0000-\u001f\u007f]/.test(key);
}
function bodyObject(value: unknown): Record<string, unknown> {
  // The conversation comes from the route only; a body that names one is refused, never merged.
  if (!value || typeof value !== 'object' || Array.isArray(value) || 'conversationId' in value) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
  return value as Record<string, unknown>;
}

/**
 * 0364 school conversations. The guarded route scope plus the live conversation.read / conversation.manage permission,
 * re-proved by every database call. Replies only queue a consent-gated SMS; the 0243 worker delivers it.
 */
@Injectable()
export class SchoolConversationsService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  async list(context: MembershipLifecycleContext, query: unknown): Promise<ConversationList> {
    this.assertStaff(context, false);
    let input;
    try { input = validateConversationListQuery(query); } catch { throw new BadRequestException({ code: 'VALIDATION_FAILED' }); }
    return this.read(context, 'SELECT hon.read_school_conversations($1,$2::jsonb) AS data', [context.externalSubject, JSON.stringify(input)], verifyConversationList);
  }

  async detail(context: MembershipLifecycleContext, conversationId: string, before: string | null): Promise<ConversationDetail> {
    this.assertStaff(context, false);
    if (typeof conversationId !== 'string' || !UUID.test(conversationId) || (before !== null && (typeof before !== 'string' || !UUID.test(before)))) {
      throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    }
    return this.read(context, 'SELECT hon.read_school_conversation($1,$2::uuid,$3::uuid) AS data', [context.externalSubject, conversationId, before],
      data => verifyConversationDetail(data, conversationId));
  }

  async reply(context: MembershipLifecycleContext, conversationId: string, value: unknown): Promise<{ receipt: ConversationReplyReceipt; replayed: boolean }> {
    const input = this.parse(() => validateReplyConversationInput({ ...bodyObject(value), conversationId }));
    return this.command(context, 'hon.reply_school_conversation', input, data => verifyConversationReplyReceipt(data, { conversationId, body: input.body }));
  }

  async update(context: MembershipLifecycleContext, conversationId: string, value: unknown): Promise<{ receipt: ConversationUpdateReceipt; replayed: boolean }> {
    const input = this.parse(() => validateUpdateConversationInput({ ...bodyObject(value), conversationId }));
    return this.command(context, 'hon.update_school_conversation', input, data => verifyConversationUpdateReceipt(data, conversationId));
  }

  async link(context: MembershipLifecycleContext, conversationId: string, value: unknown): Promise<{ receipt: ConversationLinkReceipt; replayed: boolean }> {
    const input = this.parse(() => validateLinkConversationInput({ ...bodyObject(value), conversationId }));
    return this.command(context, 'hon.link_school_conversation', input, data => verifyConversationLinkReceipt(data, conversationId));
  }

  async createLead(context: MembershipLifecycleContext, conversationId: string, value: unknown): Promise<{ receipt: ConversationLinkReceipt; replayed: boolean }> {
    const input = this.parse(() => validateCreateConversationLeadInput({ ...bodyObject(value), conversationId }));
    return this.command(context, 'hon.create_school_conversation_lead', input, data => verifyConversationLinkReceipt(data, conversationId));
  }

  async markRead(context: MembershipLifecycleContext, conversationId: string, value: unknown): Promise<ConversationReadMark> {
    this.assertStaff(context, false);
    const input = this.parse(() => validateMarkConversationReadInput({ ...bodyObject(value), conversationId }));
    try {
      return await this.database.withTenantTransaction(context, async client => {
        await client.query(WRITE_LIMITS);
        await client.query(HUMAN_SETTINGS, [context.externalSubject]);
        const data = await this.one(client, 'SELECT hon.mark_school_conversation_read($1,$2::jsonb,$3::uuid,$4::uuid) AS data',
          [context.externalSubject, JSON.stringify(input), context.requestId, context.correlationId]);
        return verifyConversationReadMark(data, conversationId);
      });
    } catch (error) { return translate(error); }
  }

  private parse<T>(fn: () => T): T {
    try { return fn(); } catch (error) { if (error instanceof HttpException) throw error; throw new BadRequestException({ code: 'VALIDATION_FAILED' }); }
  }

  private async command<T>(context: MembershipLifecycleContext, fn: string, input: unknown, verify: (data: unknown) => T): Promise<{ receipt: T; replayed: boolean }> {
    this.assertStaff(context, true);
    try {
      return await this.database.withTenantTransaction(context, async client => {
        await client.query(WRITE_LIMITS);
        await client.query(HUMAN_SETTINGS, [context.externalSubject]);
        const result = await client.query<{ data: Record<string, unknown> }>(`SELECT ${fn}($1,$2::jsonb,$3,$4::uuid,$5::uuid) AS data`,
          [context.externalSubject, JSON.stringify(input), context.idempotencyKey, context.requestId, context.correlationId]);
        const data = result.rows[0]?.data;
        if (result.rows.length !== 1 || !data || Object.keys(data).sort().join(',') !== 'receipt,replayed' || typeof data.replayed !== 'boolean') {
          throw new Error('Unverified conversation receipt.');
        }
        return { receipt: verify(data.receipt), replayed: data.replayed };
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
      throw new ForbiddenException({ code: 'HUMAN_COMMAND_REQUIRED', detail: 'Conversations accept only direct human commands.' });
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
    if (result.rows.length !== 1) throw new Error('Unverified conversation read.');
    return result.rows[0]!.data;
  }
}
