import { Controller, ForbiddenException, Get, Header, Param, ParseUUIDPipe, Query, Req, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { randomUUID } from 'node:crypto';
import type { AttendanceCommandContext } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { MAX_LIST_CURSOR_LENGTH } from '../foundation/list-cursor.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { ClassSessionRosterService } from './class-session-roster.service.js';

export class ClassSessionRosterQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100)
  limit?: number;

  /** Opaque signed cursor from the previous page's meta.nextCursor. */
  @IsOptional() @IsString() @MaxLength(MAX_LIST_CURSOR_LENGTH)
  cursor?: string;
}

/** U5: read-only roster and attendance of one exact class session of the verified school. */
@Controller('organizations/:organizationId/schools/:schoolId/schedule/sessions')
@UseGuards(HonIdentityGuard)
export class ClassSessionRosterController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly roster: ClassSessionRosterService) {}

  @Get(':sessionId/roster')
  @Header('Cache-Control', 'private, no-store')
  async read(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('sessionId', new ParseUUIDPipe()) sessionId: string,
    @Query() query: ClassSessionRosterQueryDto,
    @Req() request: HonRequest,
  ) {
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException('HON identity context is missing.');
    // Route identifiers are not authority: the scope comes from the verified session identity and is re-decided live
    // inside the read transaction.
    const scope = await this.database.resolveAuthorizedScope(identity.externalSubject, schoolId, 'attendance.record');
    if (!scope || scope.organizationId !== organizationId || scope.schoolId !== schoolId) throw new ForbiddenException('The class roster is not authorized for this school.');
    const requestId = randomUUID();
    const context: AttendanceCommandContext = { ...scope, externalSubject: identity.externalSubject, principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId, correlationId: requestId, idempotencyKey: '' };
    const { entries, session, nextCursor, limit } = await this.roster.read(context, sessionId.toLowerCase(), { limit: query.limit, cursor: query.cursor });
    return { data: entries, meta: { requestId, correlationId: requestId, limit, nextCursor, session } };
  }
}
