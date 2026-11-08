import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { verifySchoolMembershipListDatabasePage, type SchoolMembershipListItem, type SchoolMembershipListState } from '@hon/contracts';
import { decodeListCursor, encodeListCursor } from '../foundation/list-cursor.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import type { MembershipLifecycleContext } from './membership.service.js';

const HUMAN_SETTINGS = "SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_external_subject',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)";
const READ_LIMITS = "SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'; SET LOCAL log_parameter_max_length_on_error=0";
/** A position is the last row's immutable (created_at microsecond, id); the cursor is bound to the school and state filter. */
const MEMBERSHIP_LIST_CURSOR = ['instant', 'uuid'] as const;

function translate(error: unknown): never {
  if (error instanceof HttpException) throw error;
  const sqlState = (error as { code?: string })?.code ?? '';
  const message = (error as { message?: string })?.message ?? '';
  if (sqlState === '42501') throw new ForbiddenException({ code: 'MEMBERSHIP_LIST_FORBIDDEN' });
  if (message === 'SCHOOL_TIMEZONE_INVALID') throw new ConflictException({ code: message, detail: 'The school timezone is not a valid IANA timezone.' });
  if (sqlState === '22023' && message === 'VALIDATION_FAILED') throw new BadRequestException({ code: 'VALIDATION_FAILED' });
  if (sqlState === '57014') throw new ServiceUnavailableException({ code: 'MEMBERSHIP_LIST_TIMEOUT' });
  throw new ServiceUnavailableException({ code: 'MEMBERSHIP_LIST_UNAVAILABLE' });
}

/**
 * U6 (0220) school-wide membership list. One protected definer function re-proves the direct human subject, the live
 * school-scoped permission (billing.membership.read, .activate or .dates.revise), the organization/school lifecycle and
 * the entitlement on every page, and derives each row's reporting status from the private confirmed-date evidence.
 */
@Injectable()
export class SchoolMembershipListService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  async list(
    context: MembershipLifecycleContext,
    page: { limit?: number | undefined; cursor?: string | undefined; state?: SchoolMembershipListState | undefined },
  ): Promise<{ items: SchoolMembershipListItem[]; nextCursor: string | null; limit: number; schoolTimezone: string; localToday: string }> {
    if (context.principalType !== 'HUMAN_USER' || context.source !== 'HUMAN_UI' || context.actionRequestId || context.delegatedByPrincipalId) {
      throw new ForbiddenException({ code: 'HUMAN_COMMAND_REQUIRED', detail: 'Memberships are listed only for a direct human operator.' });
    }
    const subject = context.externalSubject;
    if (typeof subject !== 'string' || !subject || subject.trim() !== subject || subject.length > 200) throw new ForbiddenException({ code: 'MEMBERSHIP_LIST_FORBIDDEN' });
    const limit = page.limit ?? 50;
    const state = page.state ?? null;
    const after = decodeListCursor(page.cursor, 'billing.membership.list', context.schoolId, { state }, MEMBERSHIP_LIST_CURSOR);
    const input: Record<string, unknown> = { limit };
    if (state) input.state = state;
    if (after) { input.afterCreatedAt = after[0]; input.afterId = after[1]; }
    try {
      return await this.database.withTenantReadOnlyTransaction(context, async (client) => {
        await client.query(READ_LIMITS);
        await client.query(HUMAN_SETTINGS, [subject]);
        const result = await client.query<{ data: unknown }>('SELECT hon.read_school_membership_list($1,$2::jsonb) AS data', [subject, JSON.stringify(input)]);
        if (result.rows.length !== 1) throw new Error('Unverified school membership list.');
        const data = verifySchoolMembershipListDatabasePage(result.rows[0]!.data, limit);
        const last = data.hasMore ? data.items[data.items.length - 1] : undefined;
        return {
          items: data.items.map(({ cursorCreatedAt: _cursorCreatedAt, ...item }) => item),
          nextCursor: last ? encodeListCursor('billing.membership.list', context.schoolId, { state }, MEMBERSHIP_LIST_CURSOR, [last.cursorCreatedAt, last.membershipId]) : null,
          limit,
          schoolTimezone: data.schoolTimezone,
          localToday: data.localToday,
        };
      });
    } catch (error) { return translate(error); }
  }
}
