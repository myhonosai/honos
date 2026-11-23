import { BadRequestException, ConflictException, ForbiddenException, HttpException, HttpStatus, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  validatePublishSchoolAnnouncementInput, validateWithdrawSchoolAnnouncementInput, verifyParentSchoolAnnouncements, verifySchoolAnnouncementReceipt,
  verifySchoolAnnouncements, type ParentSchoolAnnouncements, type SchoolAnnouncementReceipt, type SchoolAnnouncements,
} from '@hon/contracts';
import { RuntimeDatabaseService, type ResolvedParentFamilyScope } from '../foundation/runtime-database.service.js';
import type { MembershipLifecycleContext } from '../billing/membership.service.js';

const HUMAN_SETTINGS = "SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_external_subject',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)";
const READ_LIMITS = "SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'; SET LOCAL log_parameter_max_length_on_error=0";
const WRITE_LIMITS = "SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='5s'; SET LOCAL log_parameter_max_length_on_error=0";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const ERRORS: Record<string, (code: string) => HttpException> = {
  VALIDATION_FAILED: code => new BadRequestException({ code }),
  SCHOOL_ANNOUNCEMENTS_FORBIDDEN: code => new ForbiddenException({ code }),
  SCHOOL_ANNOUNCEMENTS_NOT_FOUND: code => new NotFoundException({ code, detail: 'That announcement is not available.' }),
  SCHOOL_ANNOUNCEMENTS_RATE_LIMITED: code => new HttpException({ code, detail: 'Your school posted 20 announcements in the last day. Please try again later.' }, HttpStatus.TOO_MANY_REQUESTS),
  VERSION_CONFLICT: code => new ConflictException({ code, detail: 'This announcement changed. Refresh to see the latest.' }),
  IDEMPOTENCY_KEY_REUSED: code => new ConflictException({ code, detail: 'The idempotency key was already used for a different command.' }),
  IDEMPOTENCY_IN_PROGRESS: code => new ConflictException({ code, detail: 'The matching command is being processed.' }),
};
export function translateSchoolAnnouncementError(error: unknown): never {
  if (error instanceof HttpException) throw error;
  const sqlState = (error as { code?: string })?.code ?? '';
  const message = (error as { message?: string })?.message ?? '';
  const known = ERRORS[message];
  if (known && ['22023', '42501', 'P0002', '40001', '23505', '53400'].includes(sqlState)) throw known(message);
  if (sqlState === '42501') throw new ForbiddenException({ code: 'SCHOOL_ANNOUNCEMENTS_FORBIDDEN' });
  if (['40001', '40P01', '55P03', '23505'].includes(sqlState)) throw new ConflictException({ code: 'SCHOOL_ANNOUNCEMENTS_CONFLICT' });
  if (['22023', '22P02', '23514'].includes(sqlState)) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
  throw new ServiceUnavailableException({ code: 'SCHOOL_ANNOUNCEMENTS_UNAVAILABLE', detail: 'No verified announcement result is available.' });
}
function subjectOk(subject: unknown): subject is string {
  return typeof subject === 'string' && subject.length > 0 && subject.length <= 200 && subject.trim() === subject;
}
function keyOk(key: unknown): key is string {
  return typeof key === 'string' && key.length > 0 && key.trim() === key && key.length <= 200 && !/[\u0000-\u001f\u007f]/.test(key);
}
function receiptShape(data: Record<string, unknown> | undefined, rows: number): asserts data is { receipt: unknown; replayed: boolean } {
  if (rows !== 1 || !data || Object.keys(data).sort().join(',') !== 'receipt,replayed' || typeof data.replayed !== 'boolean') throw new Error('Unverified announcement receipt.');
}

/**
 * 0576 school announcements. Parents: the one live family grant decides the school, with no selector trusted. Staff: the
 * guarded route scope plus the live family_messages.manage permission, re-proved by every database call. Nothing is sent.
 */
@Injectable()
export class SchoolAnnouncementsService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  async parentRead(subject: string): Promise<ParentSchoolAnnouncements> {
    if (!subjectOk(subject)) throw new ForbiddenException({ code: 'SCHOOL_ANNOUNCEMENTS_FORBIDDEN' });
    try {
      const scopes: ResolvedParentFamilyScope[] = await this.database.resolveParentJourneyScopes(subject);
      if (scopes.length !== 1) throw new ForbiddenException({ code: 'SCHOOL_ANNOUNCEMENTS_FORBIDDEN' });
      const scope = scopes[0]!;
      const context = { organizationId: scope.organizationId, schoolId: scope.schoolId, principalId: scope.principalId, principalType: 'HUMAN_USER', requestId: randomUUID() };
      return await this.database.withTenantReadOnlyTransaction(context, async client => {
        await client.query(READ_LIMITS);
        await client.query(HUMAN_SETTINGS, [subject]);
        return verifyParentSchoolAnnouncements(await this.one(client, 'SELECT hon.read_parent_school_announcements($1) AS data', [subject]));
      });
    } catch (error) { return translateSchoolAnnouncementError(error); }
  }

  async list(context: MembershipLifecycleContext): Promise<SchoolAnnouncements> {
    this.assertStaff(context, false);
    try {
      return await this.database.withTenantReadOnlyTransaction(context, async client => {
        await client.query(READ_LIMITS);
        await client.query(HUMAN_SETTINGS, [context.externalSubject]);
        return verifySchoolAnnouncements(await this.one(client, 'SELECT hon.read_school_announcements($1) AS data', [context.externalSubject]));
      });
    } catch (error) { return translateSchoolAnnouncementError(error); }
  }

  async publish(context: MembershipLifecycleContext, value: unknown): Promise<{ receipt: SchoolAnnouncementReceipt; replayed: boolean }> {
    this.assertStaff(context, true);
    let input;
    try { input = validatePublishSchoolAnnouncementInput(value); } catch { throw new BadRequestException({ code: 'VALIDATION_FAILED' }); }
    return this.command(context, 'SELECT hon.publish_school_announcement($1,$2::jsonb,$3,$4::uuid,$5::uuid) AS data', input,
      data => verifySchoolAnnouncementReceipt(data, { title: input.title, body: input.body, status: 'PUBLISHED' }));
  }

  async withdraw(context: MembershipLifecycleContext, announcementId: string, value: unknown): Promise<{ receipt: SchoolAnnouncementReceipt; replayed: boolean }> {
    this.assertStaff(context, true);
    let input;
    try {
      const body = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
      if (Object.keys(body).join() !== 'expectedVersion' || typeof announcementId !== 'string' || !UUID.test(announcementId)) throw new Error('shape');
      input = validateWithdrawSchoolAnnouncementInput({ announcementId, expectedVersion: body.expectedVersion });
    } catch { throw new BadRequestException({ code: 'VALIDATION_FAILED' }); }
    return this.command(context, 'SELECT hon.withdraw_school_announcement($1,$2::jsonb,$3,$4::uuid,$5::uuid) AS data', input,
      data => verifySchoolAnnouncementReceipt(data, { announcementId, status: 'WITHDRAWN' }));
  }

  private async command(context: MembershipLifecycleContext, statement: string, input: unknown, verify: (data: unknown) => SchoolAnnouncementReceipt) {
    try {
      return await this.database.withTenantTransaction(context, async client => {
        await client.query(WRITE_LIMITS);
        await client.query(HUMAN_SETTINGS, [context.externalSubject]);
        const result = await client.query<{ data: Record<string, unknown> }>(statement,
          [context.externalSubject, JSON.stringify(input), context.idempotencyKey, context.requestId, context.correlationId]);
        const data = result.rows[0]?.data;
        receiptShape(data, result.rows.length);
        return { receipt: verify(data.receipt), replayed: data.replayed };
      });
    } catch (error) { return translateSchoolAnnouncementError(error); }
  }

  private assertStaff(context: MembershipLifecycleContext, command: boolean): void {
    if (context.principalType !== 'HUMAN_USER' || context.source !== 'HUMAN_UI' || context.actionRequestId || context.delegatedByPrincipalId) {
      throw new ForbiddenException({ code: 'HUMAN_COMMAND_REQUIRED', detail: 'Announcements accept only direct human commands.' });
    }
    if (!subjectOk(context.externalSubject)) throw new ForbiddenException({ code: 'SCHOOL_ANNOUNCEMENTS_FORBIDDEN' });
    if (!command) {
      if (context.idempotencyKey !== '') throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
      return;
    }
    if (!keyOk(context.idempotencyKey)) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'A unique Idempotency-Key header is required.' });
  }

  private async one(client: PoolClient, statement: string, values: unknown[]): Promise<unknown> {
    const result = await client.query<{ data: unknown }>(statement, values);
    if (result.rows.length !== 1) throw new Error('Unverified announcement read.');
    return result.rows[0]!.data;
  }
}
