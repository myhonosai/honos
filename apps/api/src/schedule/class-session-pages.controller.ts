import { Controller, ForbiddenException, Get, Header, Injectable, Param, ParseUUIDPipe, Query, Req, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { randomUUID } from 'node:crypto';
import type { CurrentSchoolClassSessionsReadContext } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { MAX_LIST_CURSOR_LENGTH } from '../foundation/list-cursor.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { ClassSessionsReadHumanUiGuard } from './class-sessions-read-human-ui.guard.js';
import { ClassSessionPagesService } from './class-session-pages.service.js';

export class ClassSessionPagesQueryDto {
  /** School-local start date (YYYY-MM-DD); default the school's local today. The database checks it is a real date. */
  @IsOptional() @IsString() @Matches(/^\d{4}-\d{2}-\d{2}$/)
  from?: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100)
  limit?: number;

  /** Opaque signed cursor from the previous page's meta.nextCursor. */
  @IsOptional() @IsString() @MaxLength(MAX_LIST_CURSOR_LENGTH)
  cursor?: string;
}

/** The same strict browser read transport as the bounded session read, accepting only from, limit and cursor. */
@Injectable()
export class ClassSessionPagesHumanUiGuard extends ClassSessionsReadHumanUiGuard {
  protected override readonly allowedQuery: ReadonlySet<string> = new Set(['from', 'limit', 'cursor']);
}

/** 0221: read-only forward-paging class-session list of the verified school. */
@Controller('organizations/:organizationId/schools/:schoolId/schedule/sessions')
@UseGuards(HonIdentityGuard, ClassSessionPagesHumanUiGuard)
export class ClassSessionPagesController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly sessions: ClassSessionPagesService) {}

  @Get('list')
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @Header('X-Robots-Tag', 'noindex, nofollow')
  async list(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Query() query: ClassSessionPagesQueryDto,
    @Req() request: HonRequest,
  ) {
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException({ code: 'IDENTITY_REQUIRED' });
    // Route identifiers are not authority: the scope comes from the verified session identity, and the definer function
    // re-decides it live inside the read.
    const scope = await this.database.resolveAuthorizedScope(identity.externalSubject, schoolId, 'schedule.session.read');
    if (!scope || scope.organizationId !== organizationId || scope.schoolId !== schoolId) {
      throw new ForbiddenException({ code: 'CLASS_SESSIONS_READ_FORBIDDEN' });
    }
    const requestId = randomUUID();
    const context: CurrentSchoolClassSessionsReadContext = { ...scope, externalSubject: identity.externalSubject,
      principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId, correlationId: requestId, idempotencyKey: '' };
    const result = await this.sessions.list(context, { from: query.from, limit: query.limit, cursor: query.cursor });
    return { data: result.items, meta: { requestId, correlationId: requestId, limit: result.limit, nextCursor: result.nextCursor,
      schoolTimezone: result.schoolTimezone, localToday: result.localToday, fromDate: result.fromDate } };
  }
}
