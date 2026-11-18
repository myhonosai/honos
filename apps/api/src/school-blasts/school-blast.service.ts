import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import {
  validateCancelSchoolBlast, validateSaveSchoolBlast, validateSendSchoolBlast, verifySchoolBlast, verifySchoolBlastAudience, verifySchoolBlastList,
  verifySchoolBlastReceipt, type SchoolBlast, type SchoolBlastAudiencePreview, type SchoolBlastReceipt, type SchoolBlastSummary,
} from '@hon/contracts';
import type { PoolClient } from 'pg';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import type { MembershipLifecycleContext } from '../billing/membership.service.js';

const HUMAN_SETTINGS = "SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_external_subject',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)";
const READ_LIMITS = "SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='3s'; SET LOCAL log_parameter_max_length_on_error=0";
const WRITE_LIMITS = "SET LOCAL statement_timeout='30s'; SET LOCAL lock_timeout='5s'; SET LOCAL log_parameter_max_length_on_error=0";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Exact 0524 error codes; every unknown database failure is unavailable, never success.
const ERRORS: Record<string, { states: string[]; make: (code: string) => HttpException }> = {
  VALIDATION_FAILED: { states: ['22023'], make: code => new BadRequestException({ code }) },
  BLAST_TEXT_TOO_LONG: { states: ['22023'], make: code => new BadRequestException({ code, detail: 'A filled-in message is too long. Shorten the text.' }) },
  SCHOOL_BLAST_FORBIDDEN: { states: ['42501'], make: code => new ForbiddenException({ code }) },
  BLAST_NOT_FOUND: { states: ['P0002'], make: code => new NotFoundException({ code }) },
  BLAST_NOT_DRAFT: { states: ['55000'], make: code => new ConflictException({ code, detail: 'This blast was already sent or cancelled.' }) },
  BLAST_NOT_CANCELLABLE: { states: ['55000'], make: code => new ConflictException({ code, detail: 'Only a scheduled blast can be cancelled, before its time.' }) },
  BLAST_NO_RECIPIENTS: { states: ['55000'], make: code => new ConflictException({ code, detail: 'Nobody in this audience can receive it.' }) },
  BLAST_AUDIENCE_TOO_LARGE: { states: ['55000'], make: code => new ConflictException({ code, detail: 'More than 2,000 people would receive it. Narrow the audience.' }) },
  BLAST_DAILY_LIMIT: { states: ['55000'], make: code => new ConflictException({ code, detail: 'This school already sent 10 blasts in the last 24 hours.' }) },
  VERSION_CONFLICT: { states: ['40001'], make: code => new ConflictException({ code, detail: 'This changed. Reload and try again with a new Idempotency-Key.' }) },
  IDEMPOTENCY_KEY_REUSED: { states: ['23505'], make: code => new ConflictException({ code, detail: 'The idempotency key was already used for a different command.' }) },
  IDEMPOTENCY_IN_PROGRESS: { states: ['40001'], make: code => new ConflictException({ code, detail: 'The matching command is being processed.' }) },
};
function translate(error: unknown): never {
  if (error instanceof HttpException) throw error;
  const sqlState = (error as { code?: string })?.code ?? '';
  const message = (error as { message?: string })?.message ?? '';
  const known = ERRORS[message];
  if (known && known.states.includes(sqlState)) throw known.make(message);
  if (sqlState === '42501') throw new ForbiddenException({ code: 'SCHOOL_BLAST_FORBIDDEN' });
  if (['40001', '40P01', '55P03', '23505'].includes(sqlState)) throw new ConflictException({ code: 'SCHOOL_BLAST_CONFLICT' });
  if (['22023', '22P02', '22003', '22007', '22008', '23514'].includes(sqlState)) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
  throw new ServiceUnavailableException({ code: 'SCHOOL_BLAST_UNAVAILABLE' });
}
function unverified(): never { throw new Error('Unverified school blast answer.'); }
function invalidInput(): never { throw new BadRequestException({ code: 'VALIDATION_FAILED' }); }

/**
 * 0524: school email and text blasts. Each read and command is one protected definer call that re-proves the direct human
 * subject and the live permission. The database resolves the audience, fills merge tags and queues the 0243 messages; this
 * service never sees an address and never talks to a provider.
 */
@Injectable()
export class SchoolBlastService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  async list(context: MembershipLifecycleContext): Promise<SchoolBlastSummary[]> {
    this.assertHumanContext(context, false);
    return this.read(context, 'SELECT hon.read_school_blasts($1) AS data', [context.externalSubject], verifySchoolBlastList);
  }

  async get(context: MembershipLifecycleContext, blastId: string): Promise<SchoolBlast> {
    this.assertHumanContext(context, false);
    if (!UUID.test(blastId)) invalidInput();
    return this.read(context, 'SELECT hon.read_school_blast($1,$2::uuid) AS data', [context.externalSubject, blastId], value => {
      const blast = verifySchoolBlast(value);
      if (blast.blastId !== blastId.toLowerCase()) unverified();
      return blast;
    });
  }

  async audience(context: MembershipLifecycleContext, blastId: string): Promise<SchoolBlastAudiencePreview> {
    this.assertHumanContext(context, false);
    if (!UUID.test(blastId)) invalidInput();
    return this.read(context, 'SELECT hon.read_school_blast_audience($1,$2::uuid) AS data', [context.externalSubject, blastId],
      value => verifySchoolBlastAudience(value, { blastId }));
  }

  async save(context: MembershipLifecycleContext, value: unknown): Promise<SchoolBlastReceipt> {
    this.assertHumanContext(context, true);
    let input;
    try { input = validateSaveSchoolBlast(value); } catch { invalidInput(); }
    return this.write(context, 'save_school_blast', input, data => {
      const receipt = verifySchoolBlastReceipt(data, { blastId: input.blastId, version: input.expectedVersion + 1, status: 'DRAFT' });
      if (receipt.blast.channel !== input.channel || receipt.blast.body !== input.body) unverified();
      return receipt;
    });
  }

  async send(context: MembershipLifecycleContext, value: unknown): Promise<SchoolBlastReceipt> {
    this.assertHumanContext(context, true);
    let input;
    try { input = validateSendSchoolBlast(value); } catch { invalidInput(); }
    return this.write(context, 'send_school_blast', input, data => {
      const receipt = verifySchoolBlastReceipt(data, { blastId: input.blastId, version: input.expectedVersion + 1, status: 'QUEUED' });
      if (receipt.blast.sendAt !== input.sendAt) unverified();
      return receipt;
    });
  }

  async cancel(context: MembershipLifecycleContext, value: unknown): Promise<SchoolBlastReceipt> {
    this.assertHumanContext(context, true);
    let input;
    try { input = validateCancelSchoolBlast(value); } catch { invalidInput(); }
    return this.write(context, 'cancel_school_blast', input, data =>
      verifySchoolBlastReceipt(data, { blastId: input.blastId, version: input.expectedVersion + 1, status: 'CANCELLED' }));
  }

  private async read<T>(context: MembershipLifecycleContext, sql: string, params: unknown[], verify: (value: unknown) => T): Promise<T> {
    try {
      return await this.database.withTenantReadOnlyTransaction(context, async (client: PoolClient) => {
        await client.query(READ_LIMITS);
        await client.query(HUMAN_SETTINGS, [context.externalSubject]);
        const result = await client.query<{ data: unknown }>(sql, params);
        if (result.rows.length !== 1) unverified();
        return verify(result.rows[0]!.data);
      });
    } catch (error) { return translate(error); }
  }

  private async write<T>(context: MembershipLifecycleContext, fn: 'save_school_blast' | 'send_school_blast' | 'cancel_school_blast', input: object, verify: (value: unknown) => T): Promise<T> {
    try {
      return await this.database.withTenantTransaction(context, async client => {
        await client.query(WRITE_LIMITS);
        await client.query(HUMAN_SETTINGS, [context.externalSubject]);
        const result = await client.query<{ data: unknown }>(`SELECT hon.${fn}($1,$2::jsonb,$3,$4::uuid,$5::uuid) AS data`,
          [context.externalSubject, JSON.stringify(input), context.idempotencyKey, context.requestId, context.correlationId]);
        if (result.rows.length !== 1) unverified();
        return verify(result.rows[0]!.data);
      });
    } catch (error) { return translate(error); }
  }

  private assertHumanContext(context: MembershipLifecycleContext, command: boolean): void {
    if (context.principalType !== 'HUMAN_USER' || context.source !== 'HUMAN_UI' || context.actionRequestId || context.delegatedByPrincipalId) {
      throw new ForbiddenException({ code: 'HUMAN_COMMAND_REQUIRED', detail: 'Blasts accept only direct human commands.' });
    }
    const subject = context.externalSubject;
    if (typeof subject !== 'string' || !subject || subject.trim() !== subject || subject.length > 2048) throw new ForbiddenException({ code: 'SCHOOL_BLAST_FORBIDDEN' });
    if (!command) {
      if (context.idempotencyKey !== '') throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
      return;
    }
    if (!context.idempotencyKey || context.idempotencyKey !== context.idempotencyKey.trim() || context.idempotencyKey.length > 200) {
      throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'A unique Idempotency-Key header is required.' });
    }
  }
}
