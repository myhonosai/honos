import { Body, ConflictException, Controller, ForbiddenException, Get, Headers, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Req, Res, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { CommandContext } from '@hon/contracts';
import type { Response } from 'express';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/manus-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { AddFamilyMemberDto, CreateFamilyDto } from './family.dto.js';
import { FamilyService } from './family.service.js';

@Controller('organizations/:organizationId/schools/:schoolId/families')
@UseGuards(HonIdentityGuard)
export class FamilyController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly families: FamilyService) {}

  private async context(organizationId: string, schoolId: string, permission: string, request: HonRequest, idempotencyKey?: string): Promise<CommandContext> {
    const identity = request.honIdentity; if (!identity) throw new ForbiddenException('HON identity context is missing.');
    const scope = await this.database.resolveAuthorizedScope(identity.externalSubject, schoolId, permission);
    if (!scope || scope.organizationId !== organizationId) throw new ForbiddenException('HON family access is not authorized for this school.');
    const requestId = randomUUID();
    return { organizationId: scope.organizationId, schoolId: scope.schoolId, principalId: scope.principalId, principalType: 'HUMAN_USER', requestId, correlationId: requestId, idempotencyKey: idempotencyKey ?? `read:${requestId}`, source: 'HUMAN_UI' };
  }

  @Get()
  async list(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string, @Req() request: HonRequest) {
    const context = await this.context(organizationId, schoolId, 'family.read', request);
    return { data: await this.families.list(context), meta: { requestId: context.requestId, correlationId: context.correlationId } };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string, @Headers('idempotency-key') idempotencyKey: string | undefined, @Body() input: CreateFamilyDto, @Req() request: HonRequest, @Res({ passthrough: true }) response: Response) {
    if (!idempotencyKey || idempotencyKey.length > 200) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'A unique Idempotency-Key header is required for family creation.' });
    const context = await this.context(organizationId, schoolId, 'family.create', request, idempotencyKey);
    const result = await this.families.create(context, input); response.status(result.replayed ? HttpStatus.OK : HttpStatus.CREATED);
    return { data: result.family, meta: { requestId: context.requestId, correlationId: context.correlationId, replayed: result.replayed } };
  }

  @Post(':familyId/members')
  @HttpCode(HttpStatus.CREATED)
  async addMember(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string, @Param('familyId', new ParseUUIDPipe()) familyId: string, @Headers('idempotency-key') idempotencyKey: string | undefined, @Body() input: AddFamilyMemberDto, @Req() request: HonRequest, @Res({ passthrough: true }) response: Response) {
    if (!idempotencyKey || idempotencyKey.length > 200) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'A unique Idempotency-Key header is required for family membership.' });
    const context = await this.context(organizationId, schoolId, 'family.member.manage', request, idempotencyKey);
    if (input.memberRole === 'STUDENT') {
      const identity = request.honIdentity;
      if (!identity) throw new ForbiddenException('HON identity context is missing.');
      const studentScope = await this.database.resolveAuthorizedScope(identity.externalSubject, schoolId, 'student.profile.manage');
      if (!studentScope || studentScope.organizationId !== organizationId || studentScope.principalId !== context.principalId) {
        throw new ForbiddenException('HON student profile management is not authorized for this school.');
      }
    }
    const result = await this.families.addMember(context, familyId, input); response.status(result.replayed ? HttpStatus.OK : HttpStatus.CREATED);
    return { data: result.member, meta: { requestId: context.requestId, correlationId: context.correlationId, replayed: result.replayed } };
  }
}
