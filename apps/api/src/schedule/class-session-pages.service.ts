import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { verifyClassSessionDatabasePage, type ClassSessionPageItem, type CurrentSchoolClassSessionsReadContext } from '@hon/contracts';
import { decodeListCursor, encodeListCursor } from '../foundation/list-cursor.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';

const HUMAN_SETTINGS = "SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_external_subject',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)";
const READ_LIMITS = "SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'; SET LOCAL log_parameter_max_length_on_error=0";
/** A position is the last row's published millisecond startsAt (as a microsecond instant) and id; bound to school and from. */
const CLASS_SESSION_PAGE_CURSOR = ['instant', 'uuid'] as const;

function translate(error: unknown): never {
  if (error instanceof HttpException) throw error;
  const sqlState = (error as { code?: string })?.code ?? '';
  const message = (error as { message?: string })?.message ?? '';
  if (sqlState === '42501') throw new ForbiddenException({ code: 'CLASS_SESSIONS_READ_FORBIDDEN' });
  if (message === 'SCHOOL_TIMEZONE_INVALID') throw new ConflictException({ code: message, detail: 'The school timezone is not a valid IANA timezone.' });
  if (sqlState === '22023' && message === 'VALIDATION_FAILED') throw new BadRequestException({ code: 'VALIDATION_FAILED' });
  if (sqlState === '57014') throw new ServiceUnavailableException({ code: 'CLASS_SESSIONS_READ_TIMEOUT' });
  throw new ServiceUnavailableException({ code: 'CLASS_SESSIONS_READ_UNAVAILABLE' });
}

/**
 * Forward-paging class-session list (0221). One protected definer function re-proves the direct human subject,
 * schedule.session.read live at the current school, the organization/school lifecycle and the entitlement on every page
 * (the same private helper as the bounded 0147 read), and returns the sessions from a school-local date in published order.
 */
@Injectable()
export class ClassSessionPagesService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  async list(
    context: CurrentSchoolClassSessionsReadContext,
    page: { from?: string | undefined; limit?: number | undefined; cursor?: string | undefined },
  ): Promise<{ items: ClassSessionPageItem[]; nextCursor: string | null; limit: number; schoolTimezone: string; localToday: string; fromDate: string }> {
    if (context.principalType !== 'HUMAN_USER' || context.source !== 'HUMAN_UI' || context.actionRequestId || context.delegatedByPrincipalId) {
      throw new ForbiddenException({ code: 'HUMAN_COMMAND_REQUIRED', detail: 'Class sessions are listed only for a direct human operator.' });
    }
    const subject = context.externalSubject;
    if (typeof subject !== 'string' || !subject || subject.trim() !== subject || subject.length > 200) throw new ForbiddenException({ code: 'CLASS_SESSIONS_READ_FORBIDDEN' });
    const limit = page.limit ?? 50;
    const from = page.from ?? null;
    const after = decodeListCursor(page.cursor, 'schedule.session.list', context.schoolId, { from }, CLASS_SESSION_PAGE_CURSOR);
    const input: Record<string, unknown> = { limit };
    if (from) input.fromDate = from;
    if (after) { input.afterStartsAt = after[0]; input.afterId = after[1]; }
    try {
      return await this.database.withTenantReadOnlyTransaction(context, async (client) => {
        await client.query(READ_LIMITS);
        await client.query(HUMAN_SETTINGS, [subject]);
        const result = await client.query<{ data: unknown }>('SELECT hon.read_school_class_session_page($1,$2::jsonb) AS data', [subject, JSON.stringify(input)]);
        if (result.rows.length !== 1) throw new Error('Unverified class-session page.');
        const data = verifyClassSessionDatabasePage(result.rows[0]!.data, limit);
        const last = data.hasMore ? data.items[data.items.length - 1] : undefined;
        return {
          items: data.items.map(({ cursorStartsAt: _cursorStartsAt, ...item }) => item),
          // The function applies the date bound to the first page only: every row after the position is on or after that
          // page's start, so a list keeps paging across the school's local midnight.
          nextCursor: last ? encodeListCursor('schedule.session.list', context.schoolId, { from }, CLASS_SESSION_PAGE_CURSOR, [last.cursorStartsAt, last.sessionId]) : null,
          limit,
          schoolTimezone: data.schoolTimezone,
          localToday: data.localToday,
          fromDate: data.fromDate,
        };
      });
    } catch (error) { return translate(error); }
  }
}
