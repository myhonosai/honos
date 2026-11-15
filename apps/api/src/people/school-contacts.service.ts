import { BadRequestException, ForbiddenException, HttpException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { validateSchoolContactCardInput, validateSchoolContactQuery, verifySchoolContactCard, verifySchoolContactList, type SchoolContactCard, type SchoolContactList,
  type SchoolContactQuery } from '@hon/contracts';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { decodeListCursor, encodeListCursor, staleListCursor } from '../foundation/list-cursor.js';
import type { MembershipLifecycleContext } from '../billing/membership.service.js';

const HUMAN_SETTINGS = "SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_external_subject',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)";
const READ_LIMITS = "SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='3s'; SET LOCAL log_parameter_max_length_on_error=0";
const CURSOR = ['uuid'] as const;

function translate(error: unknown): never {
  if (error instanceof HttpException) throw error;
  const sqlState = (error as { code?: string })?.code ?? '';
  const message = (error as { message?: string })?.message ?? '';
  if (sqlState === '42501') throw new ForbiddenException({ code: 'SCHOOL_CONTACTS_FORBIDDEN' });
  if (message === 'SCHOOL_CONTACTS_STALE_CURSOR') staleListCursor();
  if (sqlState === 'P0002' && message === 'SCHOOL_CONTACT_NOT_FOUND') throw new NotFoundException({ code: 'SCHOOL_CONTACT_NOT_FOUND' });
  if (['22023', '22P02'].includes(sqlState)) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
  throw new ServiceUnavailableException({ code: 'SCHOOL_CONTACTS_UNAVAILABLE' });
}

/**
 * C1 (0373): the contacts list for the session school. One protected definer function re-proves the direct human subject
 * and live people.read and returns one page in name order with segment counts. The cursor is signed and bound to the school
 * and every filter. Nothing is written, sent or charged.
 */
@Injectable()
export class SchoolContactsService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  async list(context: MembershipLifecycleContext, value: unknown, cursor: string | undefined): Promise<SchoolContactList> {
    if (context.principalType !== 'HUMAN_USER' || context.source !== 'HUMAN_UI' || context.actionRequestId || context.delegatedByPrincipalId) {
      throw new ForbiddenException({ code: 'HUMAN_COMMAND_REQUIRED', detail: 'The contacts list is for a signed-in staff member only.' });
    }
    const subject = context.externalSubject;
    if (typeof subject !== 'string' || !subject || subject.trim() !== subject || subject.length > 200) throw new ForbiddenException({ code: 'SCHOOL_CONTACTS_FORBIDDEN' });
    let query: SchoolContactQuery;
    try { query = validateSchoolContactQuery(value); } catch { throw new BadRequestException({ code: 'VALIDATION_FAILED' }); }
    // A fixed key order, so the same filters in any query order sign the same cursor.
    const filter = [query.segment ?? 'ALL', query.query ?? null, query.rankId ?? null, query.programId ?? null, query.planId ?? null, query.endsWithinDays ?? null];
    const after = decodeListCursor(cursor, 'people.contacts', context.schoolId, filter, CURSOR);
    const input = { ...query, ...(after ? { afterId: after[0] } : {}) };
    try {
      return await this.database.withTenantReadOnlyTransaction(context, async client => {
        await client.query(READ_LIMITS);
        await client.query(HUMAN_SETTINGS, [subject]);
        const result = await client.query<{ data: unknown }>('SELECT hon.read_school_contact_list($1,$2::jsonb) AS data', [subject, JSON.stringify(input)]);
        if (result.rows.length !== 1) throw new Error('Unverified contact list.');
        const list = verifySchoolContactList(result.rows[0]!.data, query);
        const last = list.rows.at(-1);
        return { ...list, nextCursor: list.hasMore && last ? encodeListCursor('people.contacts', context.schoolId, filter, CURSOR, [last.personId]) : null };
      });
    } catch (error) { return translate(error); }
  }

  /** C2 (0374): one contact's card for the session school. Sections the viewer may not read come back as { allowed: false }. */
  async card(context: MembershipLifecycleContext, personId: unknown): Promise<SchoolContactCard> {
    const subject = this.subject(context);
    let input: { personId: string };
    try { input = validateSchoolContactCardInput(personId); } catch { throw new BadRequestException({ code: 'VALIDATION_FAILED' }); }
    try {
      return await this.database.withTenantReadOnlyTransaction(context, async client => {
        await client.query(READ_LIMITS);
        await client.query(HUMAN_SETTINGS, [subject]);
        const result = await client.query<{ data: unknown }>('SELECT hon.read_school_contact_card($1,$2::jsonb) AS data', [subject, JSON.stringify(input)]);
        if (result.rows.length !== 1) throw new Error('Unverified contact card.');
        return verifySchoolContactCard(result.rows[0]!.data, input.personId);
      });
    } catch (error) { return translate(error); }
  }

  private subject(context: MembershipLifecycleContext): string {
    if (context.principalType !== 'HUMAN_USER' || context.source !== 'HUMAN_UI' || context.actionRequestId || context.delegatedByPrincipalId) {
      throw new ForbiddenException({ code: 'HUMAN_COMMAND_REQUIRED', detail: 'Contacts are for a signed-in staff member only.' });
    }
    const subject = context.externalSubject;
    if (typeof subject !== 'string' || !subject || subject.trim() !== subject || subject.length > 200) throw new ForbiddenException({ code: 'SCHOOL_CONTACTS_FORBIDDEN' });
    return subject;
  }
}
