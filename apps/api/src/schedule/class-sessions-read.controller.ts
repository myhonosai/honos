import { Controller, ForbiddenException, Get, Header, Param, ParseUUIDPipe, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { CurrentSchoolClassSessionsReadContext } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { ClassSessionsReadHumanUiGuard } from './class-sessions-read-human-ui.guard.js';
import { ClassSessionsReadService } from './class-sessions-read.service.js';

@Controller('organizations/:organizationId/schools/:schoolId/schedule/sessions')
@UseGuards(HonIdentityGuard, ClassSessionsReadHumanUiGuard)
export class ClassSessionsReadController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly sessions: ClassSessionsReadService) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @Header('X-Robots-Tag', 'noindex, nofollow')
  async read(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Req() request: HonRequest,
  ): Promise<{ data: Awaited<ReturnType<ClassSessionsReadService['read']>>; meta: { requestId: string; correlationId: string } }> {
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException({ code: 'IDENTITY_REQUIRED' });
    // This selector check is deliberately independent from the named projection's
    // own direct-human/current-school/permission/entitlement reauthorization.
    const scope = await this.database.resolveAuthorizedScope(identity.externalSubject, schoolId, 'schedule.session.read');
    if (!scope || scope.organizationId !== organizationId || scope.schoolId !== schoolId) {
      throw new ForbiddenException({ code: 'CLASS_SESSIONS_READ_FORBIDDEN' });
    }
    const requestId = randomUUID();
    const context: CurrentSchoolClassSessionsReadContext = {
      ...scope,
      externalSubject: identity.externalSubject,
      principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId, correlationId: requestId, idempotencyKey: '',
    };
    return { data: await this.sessions.read(context), meta: { requestId, correlationId: requestId } };
  }
}
