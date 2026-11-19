import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import {
  validateSchoolMessageHistoryQuery, validateSchoolOptedOutQuery, verifySchoolMessageHistory, verifySchoolOptedOut,
  type SchoolMessageHistory, type SchoolOptedOut,
} from '@hon/contracts';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import type { MembershipLifecycleContext } from '../billing/membership.service.js';

const HUMAN_SETTINGS = "SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_external_subject',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)";
const READ_LIMITS = "SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'; SET LOCAL log_parameter_max_length_on_error=0";

function translate(error: unknown): never {
  if (error instanceof HttpException) throw error;
  const sqlState = (error as { code?: string })?.code ?? '';
  if (sqlState === '42501') throw new ForbiddenException({ code: 'SCHOOL_MESSAGES_FORBIDDEN' });
  if (['22023', '22P02'].includes(sqlState)) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
  throw new ServiceUnavailableException({ code: 'SCHOOL_MESSAGES_UNAVAILABLE', detail: 'No verified message list is available.' });
}

/**
 * 0585 (TE1) the school's History and Opted out lists for the Texts and Email pages. The guarded route scope plus the live
 * communication.message.read (history) or communication.consent.read (opted out) permission, re-proved by the database.
 * Read only: nothing here sends, queues or changes consent.
 */
@Injectable()
export class SchoolMessagesService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  async history(context: MembershipLifecycleContext, query: unknown): Promise<SchoolMessageHistory> {
    this.assertStaff(context);
    let input;
    try { input = validateSchoolMessageHistoryQuery(query); } catch { throw new BadRequestException({ code: 'VALIDATION_FAILED' }); }
    return this.read(context, 'SELECT hon.read_school_message_history($1,$2::jsonb) AS data', [context.externalSubject, JSON.stringify(input)],
      data => verifySchoolMessageHistory(data, input));
  }

  async optedOut(context: MembershipLifecycleContext, query: unknown): Promise<SchoolOptedOut> {
    this.assertStaff(context);
    let input;
    try { input = validateSchoolOptedOutQuery(query); } catch { throw new BadRequestException({ code: 'VALIDATION_FAILED' }); }
    return this.read(context, 'SELECT hon.read_school_opted_out_contacts($1,$2::jsonb) AS data', [context.externalSubject, JSON.stringify(input)],
      data => verifySchoolOptedOut(data, input));
  }

  private async read<T>(context: MembershipLifecycleContext, statement: string, values: unknown[], verify: (data: unknown) => T): Promise<T> {
    try {
      return await this.database.withTenantReadOnlyTransaction(context, async client => {
        await client.query(READ_LIMITS);
        await client.query(HUMAN_SETTINGS, [context.externalSubject]);
        const result = await client.query<{ data: unknown }>(statement, values);
        if (result.rows.length !== 1) throw new Error('Unverified school message read.');
        return verify(result.rows[0]!.data);
      });
    } catch (error) { return translate(error); }
  }

  private assertStaff(context: MembershipLifecycleContext): void {
    if (context.principalType !== 'HUMAN_USER' || context.source !== 'HUMAN_UI' || context.actionRequestId || context.delegatedByPrincipalId) {
      throw new ForbiddenException({ code: 'HUMAN_COMMAND_REQUIRED', detail: 'Message lists accept only direct human commands.' });
    }
    const subject = context.externalSubject;
    if (typeof subject !== 'string' || !subject || subject.length > 200 || subject.trim() !== subject) throw new ForbiddenException({ code: 'SCHOOL_MESSAGES_FORBIDDEN' });
    if (context.idempotencyKey !== '') throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
  }
}
