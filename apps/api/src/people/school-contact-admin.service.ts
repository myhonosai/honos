import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import {
  validateSchoolContactArchiveInput, validateSchoolContactMergeInput, verifySchoolContactArchiveReceipt, verifySchoolContactArchiveState,
  verifySchoolContactMergePreview, verifySchoolContactMergeReceipt, SCHOOL_CONTACT_ARCHIVE_BLOCKERS, SCHOOL_CONTACT_MERGE_BLOCKERS, SCHOOL_CONTACT_RESTORE_BLOCKERS,
  type SchoolContactArchiveReceipt, type SchoolContactArchiveState, type SchoolContactMergePreview, type SchoolContactMergeReceipt,
} from '@hon/contracts';
import type { PoolClient } from 'pg';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import type { MembershipLifecycleContext } from '../billing/membership.service.js';

const HUMAN_SETTINGS = "SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_external_subject',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)";
const READ_LIMITS = "SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='3s'; SET LOCAL log_parameter_max_length_on_error=0";
const WRITE_LIMITS = "SET LOCAL statement_timeout='15s'; SET LOCAL lock_timeout='5s'; SET LOCAL log_parameter_max_length_on_error=0";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KNOWN_BLOCKERS = new Set<string>([...SCHOOL_CONTACT_ARCHIVE_BLOCKERS, ...SCHOOL_CONTACT_RESTORE_BLOCKERS, ...SCHOOL_CONTACT_MERGE_BLOCKERS]);

/** The database's blocker list (its HINT) as known codes only; anything else becomes an empty list. */
function blockers(hint: unknown): string[] {
  try {
    const parsed: unknown = typeof hint === 'string' ? JSON.parse(hint) : null;
    return Array.isArray(parsed) && parsed.length <= 8 && parsed.every(x => typeof x === 'string' && KNOWN_BLOCKERS.has(x)) ? parsed as string[] : [];
  } catch { return []; }
}

function translate(error: unknown): never {
  if (error instanceof HttpException) throw error;
  const sqlState = (error as { code?: string })?.code ?? '';
  const message = (error as { message?: string })?.message ?? '';
  if (sqlState === '42501') throw new ForbiddenException({ code: 'SCHOOL_CONTACT_ADMIN_FORBIDDEN' });
  if (sqlState === 'P0002' && message === 'SCHOOL_CONTACT_NOT_FOUND') throw new NotFoundException({ code: 'SCHOOL_CONTACT_NOT_FOUND' });
  if (sqlState === '55000' && message === 'SCHOOL_CONTACT_BLOCKED') {
    throw new ConflictException({ code: 'SCHOOL_CONTACT_BLOCKED', blockers: blockers((error as { hint?: unknown }).hint) });
  }
  if (sqlState === '40001' && message === 'SCHOOL_CONTACT_VERSION_CONFLICT') throw new ConflictException({ code: 'SCHOOL_CONTACT_VERSION_CONFLICT', detail: 'This contact changed. Reload and try again.' });
  if (sqlState === '40001' && message === 'SCHOOL_CONTACT_PREVIEW_STALE') throw new ConflictException({ code: 'SCHOOL_CONTACT_PREVIEW_STALE', detail: 'What would move changed. Review the merge again.' });
  if (sqlState === '23505' && message === 'IDEMPOTENCY_KEY_REUSED') throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REUSED' });
  if (['40001', '40P01', '55P03', '23505'].includes(sqlState)) throw new ConflictException({ code: 'SCHOOL_CONTACT_CONFLICT' });
  if (['22023', '22P02'].includes(sqlState)) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
  throw new ServiceUnavailableException({ code: 'SCHOOL_CONTACTS_UNAVAILABLE' });
}

/**
 * C3 (0387): archive (delete), restore and merge for the session school. Each call re-proves the direct human subject and
 * live people.archive or people.merge in the database; the commands repeat the exact versions shown by the read.
 */
@Injectable()
export class SchoolContactAdminService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  async archiveState(context: MembershipLifecycleContext, personId: string): Promise<SchoolContactArchiveState> {
    const subject = this.subject(context);
    if (!UUID.test(personId)) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    return this.read(context, subject, 'SELECT hon.read_school_contact_archive($1,$2::jsonb) AS data', { personId }, data => verifySchoolContactArchiveState(data, personId));
  }

  async mergePreview(context: MembershipLifecycleContext, keepPersonId: string, mergePersonId: unknown): Promise<SchoolContactMergePreview> {
    const subject = this.subject(context);
    if (!UUID.test(keepPersonId) || typeof mergePersonId !== 'string' || !UUID.test(mergePersonId) || mergePersonId === keepPersonId) {
      throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    }
    return this.read(context, subject, 'SELECT hon.read_school_contact_merge($1,$2::jsonb) AS data', { keepPersonId, mergePersonId },
      data => verifySchoolContactMergePreview(data, keepPersonId, mergePersonId));
  }

  async archive(context: MembershipLifecycleContext, personId: string, body: unknown, restore: boolean): Promise<{ receipt: SchoolContactArchiveReceipt; replayed: boolean }> {
    const subject = this.subject(context);
    let input;
    try { input = validateSchoolContactArchiveInput({ personId, version: this.only(body, ['version']).version }); }
    catch { throw new BadRequestException({ code: 'VALIDATION_FAILED' }); }
    const fn = restore ? 'restore_school_contact' : 'archive_school_contact';
    return this.write(context, subject, `SELECT hon.${fn}($1,$2::jsonb,$3,$4::uuid,$5::uuid) AS data`, input,
      receipt => verifySchoolContactArchiveReceipt(receipt, input, !restore));
  }

  async merge(context: MembershipLifecycleContext, keepPersonId: string, body: unknown): Promise<{ receipt: SchoolContactMergeReceipt; replayed: boolean }> {
    const subject = this.subject(context);
    let input;
    try {
      const b = this.only(body, ['keepVersion', 'mergePersonId', 'mergeVersion', 'planHash']);
      input = validateSchoolContactMergeInput({ keepPersonId, ...b });
    } catch { throw new BadRequestException({ code: 'VALIDATION_FAILED' }); }
    return this.write(context, subject, 'SELECT hon.merge_school_contacts($1,$2::jsonb,$3,$4::uuid,$5::uuid) AS data', input,
      receipt => verifySchoolContactMergeReceipt(receipt, input));
  }

  /** The body as an object with exactly these keys, else a validation failure. */
  private only(body: unknown, keys: string[]): Record<string, unknown> {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('shape');
    const b = body as Record<string, unknown>;
    if (Object.keys(b).sort().join() !== [...keys].sort().join()) throw new Error('shape');
    return b;
  }

  private async read<T>(context: MembershipLifecycleContext, subject: string, statement: string, input: object, verify: (data: unknown) => T): Promise<T> {
    try {
      return await this.database.withTenantReadOnlyTransaction(context, async client => {
        await client.query(READ_LIMITS);
        await client.query(HUMAN_SETTINGS, [subject]);
        return verify(await this.one(client, statement, [subject, JSON.stringify(input)]));
      });
    } catch (error) { return translate(error); }
  }

  private async write<T>(context: MembershipLifecycleContext, subject: string, statement: string, input: object, verify: (receipt: unknown) => T): Promise<{ receipt: T; replayed: boolean }> {
    try {
      return await this.database.withTenantTransaction(context, async client => {
        await client.query(WRITE_LIMITS);
        await client.query(HUMAN_SETTINGS, [subject]);
        const data = await this.one(client, statement, [subject, JSON.stringify(input), context.idempotencyKey, context.requestId, context.correlationId]);
        if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).sort().join() !== 'receipt,replayed'
          || typeof (data as { replayed?: unknown }).replayed !== 'boolean') throw new Error('Unverified contact change.');
        const d = data as { receipt: unknown; replayed: boolean };
        return { receipt: verify(d.receipt), replayed: d.replayed };
      });
    } catch (error) { return translate(error); }
  }

  private async one(client: PoolClient, statement: string, values: unknown[]): Promise<unknown> {
    const result = await client.query<{ data: unknown }>(statement, values);
    if (result.rows.length !== 1) throw new Error('Unverified contact change.');
    return result.rows[0]!.data;
  }

  private subject(context: MembershipLifecycleContext): string {
    if (context.principalType !== 'HUMAN_USER' || context.source !== 'HUMAN_UI' || context.actionRequestId || context.delegatedByPrincipalId) {
      throw new ForbiddenException({ code: 'HUMAN_COMMAND_REQUIRED', detail: 'Merging and deleting contacts is for a signed-in staff member only.' });
    }
    const subject = context.externalSubject;
    if (typeof subject !== 'string' || !subject || subject.trim() !== subject || subject.length > 200) throw new ForbiddenException({ code: 'SCHOOL_CONTACT_ADMIN_FORBIDDEN' });
    return subject;
  }
}
