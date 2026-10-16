import { Body, Controller, ForbiddenException, Get, Headers, Param, ParseUUIDPipe, Post, Req, Res, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import type { AttendanceCommandContext } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { AttendancePolicyService } from './attendance-policy.service.js';
import { ConfigureAttendancePolicyDto } from './attendance-policy.dto.js';
import { AttendanceHumanUiGuard } from './attendance-human-ui.guard.js';

@Controller('organizations/:organizationId/schools/:schoolId/programs/:programId/attendance-policy')
@UseGuards(HonIdentityGuard, AttendanceHumanUiGuard)
export class AttendancePolicyController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly policies: AttendancePolicyService) {}
  private async context(organizationId: string, schoolId: string, request: HonRequest, key = ''): Promise<AttendanceCommandContext> {
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException('HON identity context is missing.');
    const scope = await this.database.resolveAuthorizedScope(identity.externalSubject, schoolId, 'attendance.policy.manage');
    if (!scope || scope.organizationId !== organizationId || scope.schoolId !== schoolId) throw new ForbiddenException('Attendance policy is not authorized for this school.');
    const requestId = randomUUID();
    return { ...scope, principalType: 'HUMAN_USER', source: 'HUMAN_UI', externalSubject: identity.externalSubject, requestId, correlationId: requestId, idempotencyKey: key };
  }
  @Get()
  async get(@Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string, @Param('programId', new ParseUUIDPipe()) programId: string,
    @Req() request: HonRequest, @Res({ passthrough: true }) response: Response) {
    const context = await this.context(organizationId, schoolId, request);
    response.setHeader('Cache-Control', 'private, no-store');
    return { data: await this.policies.get(context, programId), meta: { requestId: context.requestId, correlationId: context.correlationId } };
  }
  @Post()
  async configure(@Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string, @Param('programId', new ParseUUIDPipe()) programId: string,
    @Headers('idempotency-key') key: string | undefined, @Body() input: ConfigureAttendancePolicyDto,
    @Req() request: HonRequest, @Res({ passthrough: true }) response: Response) {
    const context = await this.context(organizationId, schoolId, request, key ?? '');
    const result = await this.policies.configure(context, programId, input);
    response.setHeader('Cache-Control', 'private, no-store');
    response.status(result.replayed ? 200 : 201);
    return { data: result.policy, meta: { requestId: context.requestId, correlationId: context.correlationId, replayed: result.replayed } };
  }
}
