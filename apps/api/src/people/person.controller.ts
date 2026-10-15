import { Body, ConflictException, Controller, ForbiddenException, Get, Headers, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import type { CommandContext } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { CreatePersonDto, ListPeopleDto } from './person.dto.js';
import { PersonService } from './person.service.js';

@Controller('organizations/:organizationId/schools/:schoolId/people')
@UseGuards(HonIdentityGuard)
export class PersonController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly people: PersonService) {}

  @Get()
  async list(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string, @Query() query: ListPeopleDto, @Req() request: HonRequest) {
    const identity = request.honIdentity; if (!identity) throw new ForbiddenException('HON identity context is missing.');
    const scope = await this.database.resolveAuthorizedScope(identity.externalSubject, schoolId, 'people.read');
    if (!scope || scope.organizationId !== organizationId) throw new ForbiddenException('HON people directory access is not authorized for this school.');
    const requestId = randomUUID();
    const context: CommandContext = { organizationId: scope.organizationId, schoolId: scope.schoolId, principalId: scope.principalId, principalType: 'HUMAN_USER', requestId, correlationId: requestId, idempotencyKey: `read:${requestId}`, source: 'HUMAN_UI' };
    return { data: await this.people.list(context, query.query), meta: { requestId, correlationId: requestId } };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string, @Headers('idempotency-key') idempotencyKey: string | undefined, @Body() input: CreatePersonDto, @Req() request: HonRequest, @Res({ passthrough: true }) response: Response) {
    if (!idempotencyKey || idempotencyKey.length > 200) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'A unique Idempotency-Key header is required for person creation.' });
    const identity = request.honIdentity; if (!identity) throw new ForbiddenException('HON identity context is missing.');
    const scope = await this.database.resolveAuthorizedScope(identity.externalSubject, schoolId, 'people.create');
    if (!scope || scope.organizationId !== organizationId) throw new ForbiddenException('HON person creation is not authorized for this school.');
    const requestId = randomUUID();
    const context: CommandContext = { organizationId: scope.organizationId, schoolId: scope.schoolId, principalId: scope.principalId, principalType: 'HUMAN_USER', requestId, correlationId: requestId, idempotencyKey, source: 'HUMAN_UI' };
    const result = await this.people.create(context, input); response.status(result.replayed ? HttpStatus.OK : HttpStatus.CREATED);
    return { data: result.person, meta: { requestId, correlationId: requestId, replayed: result.replayed } };
  }
}
