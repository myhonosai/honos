import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, NotFoundException, PayloadTooLargeException, ServiceUnavailableException } from '@nestjs/common';
import {
  validateSaveSchoolTemplateInput, validateSchoolTemplatesQuery, validateSetSchoolTemplateStatusInput, verifySchoolTemplateList,
  verifySchoolTemplateReceipt, type SchoolTemplateList, type SchoolTemplateReceipt,
} from '@hon/contracts';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import type { MembershipLifecycleContext } from '../billing/membership.service.js';

const HUMAN_SETTINGS = "SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_external_subject',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)";
const READ_LIMITS = "SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'; SET LOCAL log_parameter_max_length_on_error=0";
const WRITE_LIMITS = "SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='5s'; SET LOCAL log_parameter_max_length_on_error=0";

// Exact 0586 error codes; every unknown database failure is unavailable, never success.
const ERRORS: Record<string, { states: string[]; make: (code: string) => HttpException }> = {
  VALIDATION_FAILED: { states: ['22023'], make: code => new BadRequestException({ code }) },
  MESSAGE_TEMPLATE_FORBIDDEN: { states: ['42501'], make: code => new ForbiddenException({ code }) },
  MESSAGE_TEMPLATE_NOT_FOUND: { states: ['P0002'], make: code => new NotFoundException({ code }) },
  MESSAGE_TEMPLATE_ARCHIVED: { states: ['55000'], make: code => new ConflictException({ code, detail: 'Restore this template before changing it.' }) },
  MESSAGE_TEMPLATE_STATUS_UNCHANGED: { states: ['55000'], make: code => new ConflictException({ code, detail: 'The template is already in that state.' }) },
  MESSAGE_TEMPLATE_NAME_TAKEN: { states: ['23505'], make: code => new ConflictException({ code, detail: 'Another template for this channel already has that name.' }) },
  MESSAGE_TEMPLATE_LIMIT: { states: ['54000'], make: code => new PayloadTooLargeException({ code, detail: 'This school has reached the template limit. Archive one first.' }) },
  VERSION_CONFLICT: { states: ['40001'], make: code => new ConflictException({ code, detail: 'The template has changed. Reload it and try again with a new Idempotency-Key.' }) },
  IDEMPOTENCY_KEY_REUSED: { states: ['23505'], make: code => new ConflictException({ code, detail: 'The idempotency key was already used for a different command.' }) },
  IDEMPOTENCY_IN_PROGRESS: { states: ['40001'], make: code => new ConflictException({ code, detail: 'The matching command is being processed.' }) },
};
function translate(error: unknown): never {
  if (error instanceof HttpException) throw error;
  const sqlState = (error as { code?: string })?.code ?? '';
  const message = (error as { message?: string })?.message ?? '';
  const known = ERRORS[message];
  if (known && known.states.includes(sqlState)) throw known.make(message);
  if (sqlState === '42501') throw new ForbiddenException({ code: 'MESSAGE_TEMPLATE_FORBIDDEN' });
  if (['40001', '40P01', '55P03', '23505'].includes(sqlState)) throw new ConflictException({ code: 'MESSAGE_TEMPLATE_CONFLICT' });
  if (['22023', '22P02', '22003', '23514'].includes(sqlState)) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
  throw new ServiceUnavailableException({ code: 'MESSAGE_TEMPLATE_UNAVAILABLE', detail: 'No verified template answer is available.' });
}

/**
 * 0586 (TE2) the school's text and email templates for the Texts and Email pages. Each read and command is one protected
 * definer call that re-proves the direct human subject and communication.template.read or .manage. Templates are text
 * only: nothing here sends, queues or changes consent.
 */
@Injectable()
export class SchoolMessageTemplatesService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  async list(context: MembershipLifecycleContext, query: unknown): Promise<SchoolTemplateList> {
    this.assertHuman(context, false);
    let input;
    try { input = validateSchoolTemplatesQuery(query); } catch { throw new BadRequestException({ code: 'VALIDATION_FAILED' }); }
    try {
      return await this.database.withTenantReadOnlyTransaction(context, async client => {
        await client.query(READ_LIMITS);
        await client.query(HUMAN_SETTINGS, [context.externalSubject]);
        const result = await client.query<{ data: unknown }>('SELECT hon.read_school_message_templates($1,$2::jsonb) AS data', [context.externalSubject, JSON.stringify(input)]);
        if (result.rows.length !== 1) throw new Error('Unverified template list.');
        return verifySchoolTemplateList(result.rows[0]!.data, input);
      });
    } catch (error) { return translate(error); }
  }

  async save(context: MembershipLifecycleContext, value: unknown): Promise<SchoolTemplateReceipt> {
    this.assertHuman(context, true);
    let input;
    try { input = validateSaveSchoolTemplateInput(value); } catch { throw new BadRequestException({ code: 'VALIDATION_FAILED' }); }
    return this.command(context, 'SELECT hon.save_school_message_template($1,$2::jsonb,$3,$4::uuid,$5::uuid) AS data', input,
      data => verifySchoolTemplateReceipt(data, { version: input.expectedVersion + 1, templateId: input.templateId, channel: input.channel, status: 'ACTIVE' }));
  }

  async setStatus(context: MembershipLifecycleContext, value: unknown): Promise<SchoolTemplateReceipt> {
    this.assertHuman(context, true);
    let input;
    try { input = validateSetSchoolTemplateStatusInput(value); } catch { throw new BadRequestException({ code: 'VALIDATION_FAILED' }); }
    return this.command(context, 'SELECT hon.set_school_message_template_status($1,$2::jsonb,$3,$4::uuid,$5::uuid) AS data', input,
      data => verifySchoolTemplateReceipt(data, { version: input.expectedVersion + 1, templateId: input.templateId, status: input.status }));
  }

  private async command(context: MembershipLifecycleContext, statement: string, input: object, verify: (data: unknown) => SchoolTemplateReceipt): Promise<SchoolTemplateReceipt> {
    try {
      return await this.database.withTenantTransaction(context, async client => {
        await client.query(WRITE_LIMITS);
        await client.query(HUMAN_SETTINGS, [context.externalSubject]);
        const result = await client.query<{ data: unknown }>(statement,
          [context.externalSubject, JSON.stringify(input), context.idempotencyKey, context.requestId, context.correlationId]);
        if (result.rows.length !== 1) throw new Error('Unverified template receipt.');
        return verify(result.rows[0]!.data);
      });
    } catch (error) { return translate(error); }
  }

  private assertHuman(context: MembershipLifecycleContext, command: boolean): void {
    if (context.principalType !== 'HUMAN_USER' || context.source !== 'HUMAN_UI' || context.actionRequestId || context.delegatedByPrincipalId) {
      throw new ForbiddenException({ code: 'HUMAN_COMMAND_REQUIRED', detail: 'Templates accept only direct human commands.' });
    }
    const subject = context.externalSubject;
    if (typeof subject !== 'string' || !subject || subject.length > 200 || subject.trim() !== subject) throw new ForbiddenException({ code: 'MESSAGE_TEMPLATE_FORBIDDEN' });
    if (!command) {
      if (context.idempotencyKey !== '') throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
      return;
    }
    if (!context.idempotencyKey || context.idempotencyKey !== context.idempotencyKey.trim() || context.idempotencyKey.length > 200) {
      throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'A unique Idempotency-Key header is required.' });
    }
  }
}
