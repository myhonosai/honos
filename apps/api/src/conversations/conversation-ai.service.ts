import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, NotFoundException, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import {
  saasUuid,
  validateConversationAiItemInput, validateConversationAiItemStatusInput, validateConversationAiProgram, validateConversationAiProgramInput,
  validateConversationAiProgramReceipt, validateConversationAiSettingsInput, validateConversationAiUploadInput,
  verifyConversationAiFileContent, verifyConversationAiItemReceipt, verifyConversationAiKnowledge, verifyConversationAiOverview,
  verifyConversationAiSettingsReceipt, verifyConversationAiUploadReceipt,
  type ConversationAiFileContent, type ConversationAiItemReceipt, type ConversationAiKnowledge, type ConversationAiOverview,
  type ConversationAiSettingsReceipt, type ConversationAiUploadReceipt,
} from '@hon/contracts';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import type { MembershipLifecycleContext } from '../billing/membership.service.js';
import { SaasBillingService } from '../saas-billing/saas-billing.service.js';

const HUMAN_SETTINGS = "SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_external_subject',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)";
const READ_LIMITS = "SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'; SET LOCAL log_parameter_max_length_on_error=0";
const WRITE_LIMITS = "SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='5s'; SET LOCAL log_parameter_max_length_on_error=0";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** State refusals a person can act on. */
const STATE_DETAIL: Record<string, string> = {
  CONVERSATION_AI_FILE_TYPE_MISMATCH: 'The file\'s contents do not match its type. Choose a text, CSV, Markdown, PDF, Word, PNG, JPEG or WebP file.',
  CONVERSATION_AI_LIBRARY_FULL: 'The training library holds 200 items. Delete one before adding another.',
};

function translate(error: unknown): never {
  if (error instanceof HttpException) throw error;
  const sqlState = (error as { code?: string })?.code ?? '';
  const message = (error as { message?: string })?.message ?? '';
  if (sqlState === '55000' && STATE_DETAIL[message]) throw new UnprocessableEntityException({ code: message, detail: STATE_DETAIL[message] });
  if (sqlState === '42501') throw new ForbiddenException({ code: 'CONVERSATION_AI_FORBIDDEN' });
  if (sqlState === 'P0002' && message === 'CONVERSATION_AI_ITEM_NOT_FOUND') throw new NotFoundException({ code: message, detail: 'That training item or file is not available.' });
  if (sqlState === '40001' && message === 'CONVERSATION_VERSION_CONFLICT') throw new ConflictException({ code: message, detail: 'This changed since you opened it. Reload and try again.' });
  if (sqlState === '23505' && message === 'IDEMPOTENCY_KEY_REUSED') throw new ConflictException({ code: message, detail: 'The idempotency key was already used for a different command.' });
  if (sqlState === '40001' && message === 'IDEMPOTENCY_IN_PROGRESS') throw new ConflictException({ code: message, detail: 'The matching command is being processed.' });
  if (['40001', '40P01', '55P03', '23505'].includes(sqlState)) throw new ConflictException({ code: 'CONVERSATION_AI_CONFLICT' });
  if (['22023', '22P02', '23514'].includes(sqlState)) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
  throw new ServiceUnavailableException({ code: 'CONVERSATION_AI_UNAVAILABLE', detail: 'No verified conversation AI result is available.' });
}
function subjectOk(subject: unknown): subject is string {
  return typeof subject === 'string' && subject.length > 0 && subject.length <= 200 && subject.trim() === subject;
}
function keyOk(key: unknown): key is string {
  return typeof key === 'string' && key.length > 0 && key.trim() === key && key.length <= 200 && !/[\u0000-\u001f\u007f]/.test(key);
}

/**
 * 0420 Train AI. The guarded route scope plus the live conversation.read (reads) or conversation.ai.configure (changes,
 * knowledge preview, original files) permission, re-proved by every database call. Nothing here calls an AI provider.
 */
@Injectable()
export class ConversationAiService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  async overview(context: MembershipLifecycleContext): Promise<ConversationAiOverview> {
    this.assertStaff(context, false);
    return this.read(context, 'SELECT hon.read_school_conversation_ai($1) AS data', [context.externalSubject], verifyConversationAiOverview);
  }

  async knowledge(context: MembershipLifecycleContext): Promise<ConversationAiKnowledge> {
    this.assertStaff(context, false);
    return this.read(context, 'SELECT hon.read_school_ai_knowledge($1) AS data', [context.externalSubject], verifyConversationAiKnowledge);
  }

  async file(context: MembershipLifecycleContext, fileId: string): Promise<ConversationAiFileContent> {
    this.assertStaff(context, false);
    if (typeof fileId !== 'string' || !UUID.test(fileId)) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    return this.read(context, 'SELECT hon.read_school_ai_training_file($1,$2::uuid) AS data', [context.externalSubject, fileId],
      data => verifyConversationAiFileContent(data, fileId));
  }

  async settings(context: MembershipLifecycleContext, value: unknown): Promise<{ receipt: ConversationAiSettingsReceipt; replayed: boolean }> {
    const input = this.parse(() => validateConversationAiSettingsInput(value));
    return this.command(context, 'hon.set_school_conversation_ai_settings', input, verifyConversationAiSettingsReceipt);
  }

  async upload(context: MembershipLifecycleContext, value: unknown): Promise<{ receipt: ConversationAiUploadReceipt; replayed: boolean }> {
    const input = this.parse(() => validateConversationAiUploadInput(value));
    return this.command(context, 'hon.upload_school_ai_training_file', input, verifyConversationAiUploadReceipt);
  }

  async saveItem(context: MembershipLifecycleContext, value: unknown): Promise<{ receipt: ConversationAiItemReceipt; replayed: boolean }> {
    const input = this.parse(() => validateConversationAiItemInput(value));
    return this.command(context, 'hon.save_school_ai_training_item', input, data => {
      const receipt = verifyConversationAiItemReceipt(data, input.itemId ? { itemId: input.itemId } : undefined);
      if (receipt.item.status === 'DELETED' || receipt.item.kind !== input.kind) throw new Error('Unverified training item receipt.');
      return receipt;
    });
  }

  async setItemStatus(context: MembershipLifecycleContext, value: unknown): Promise<{ receipt: ConversationAiItemReceipt; replayed: boolean }> {
    const input = this.parse(() => validateConversationAiItemStatusInput(value));
    return this.command(context, 'hon.set_school_ai_training_item_status', input,
      data => verifyConversationAiItemReceipt(data, { itemId: input.itemId, status: input.status }));
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
          throw new Error('Unverified conversation AI receipt.');
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
      throw new ForbiddenException({ code: 'HUMAN_COMMAND_REQUIRED', detail: 'Conversation AI settings accept only direct human commands.' });
    }
    if (!subjectOk(context.externalSubject)) throw new ForbiddenException({ code: 'CONVERSATION_AI_FORBIDDEN' });
    if (!command) {
      if (context.idempotencyKey !== '') throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
      return;
    }
    if (!keyOk(context.idempotencyKey)) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'A unique Idempotency-Key header is required.' });
  }

  private async one(client: PoolClient, statement: string, values: unknown[]): Promise<unknown> {
    const result = await client.query<{ data: unknown }>(statement, values);
    if (result.rows.length !== 1) throw new Error('Unverified conversation AI read.');
    return result.rows[0]!.data;
  }
}

/** HQ side: the program switch. The database alone decides authority (HQ readers read; a human HQ owner changes it). */
@Injectable()
export class ConversationAiProgramService {
  constructor(private readonly billing: SaasBillingService) {}
  async read(subjectId: string) {
    return this.billing.call('readConversationAiProgram', [subjectId], validateConversationAiProgram);
  }
  async command(subjectId: string, body: unknown, key: unknown) {
    let input, idempotencyKey;
    try { input = validateConversationAiProgramInput(body); idempotencyKey = saasUuid(key); } catch { throw new BadRequestException({ code: 'INVALID_SAAS_INPUT' }); }
    return this.billing.call('commandConversationAiProgram', [subjectId, JSON.stringify(input), idempotencyKey], validateConversationAiProgramReceipt);
  }
}
