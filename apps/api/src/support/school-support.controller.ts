import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Header, Headers, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { SchoolSupportMessageHumanUiGuard, SchoolSupportReadHumanUiGuard, SchoolSupportSubmitHumanUiGuard } from './school-support.guard.js';
import { SchoolSupportService, type SchoolSupportContext } from './school-support.service.js';

const PERMISSION = 'support.request';

/** School support requests (0335). Route ids are never authority: scope comes from the verified session and the database re-proves it. */
@Controller('organizations/:organizationId/schools/:schoolId/support-requests')
@UseGuards(HonIdentityGuard)
export class SchoolSupportController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly support: SchoolSupportService) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @UseGuards(SchoolSupportReadHumanUiGuard)
  async list(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined, @Req() request: HonRequest) {
    if (idempotencyKey !== undefined) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
    const context = await this.context(request, organizationId, schoolId, '');
    return { data: await this.support.list(context), meta: { requestId: context.requestId, correlationId: context.correlationId } };
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @UseGuards(SchoolSupportSubmitHumanUiGuard)
  async submit(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined, @Body() input: unknown, @Req() request: HonRequest) {
    const context = await this.context(request, organizationId, schoolId, this.key(idempotencyKey));
    const result = await this.support.submit(context, input);
    return { data: result.request, meta: { requestId: context.requestId, correlationId: context.correlationId, replayed: result.replayed } };
  }

  @Post(':requestId/messages')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @UseGuards(SchoolSupportMessageHumanUiGuard)
  async message(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('requestId', new ParseUUIDPipe()) requestId: string, @Headers('idempotency-key') idempotencyKey: string | undefined, @Body() input: unknown, @Req() request: HonRequest) {
    const context = await this.context(request, organizationId, schoolId, this.key(idempotencyKey));
    const result = await this.support.message(context, requestId, input);
    return { data: result.request, meta: { requestId: context.requestId, correlationId: context.correlationId, replayed: result.replayed } };
  }

  private key(idempotencyKey: string | undefined): string {
    if (!idempotencyKey || idempotencyKey.length > 200 || idempotencyKey.trim() !== idempotencyKey) throw new BadRequestException({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
    return idempotencyKey;
  }

  private async context(request: HonRequest, organizationId: string, schoolId: string, idempotencyKey: string): Promise<SchoolSupportContext> {
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException('HON identity context is missing.');
    if (Object.keys(request.query ?? {}).length) throw new BadRequestException({ code: 'SUPPORT_INVALID' });
    const scope = await this.database.resolveAuthorizedScope(identity.externalSubject, schoolId, PERMISSION);
    if (!scope || scope.organizationId !== organizationId || scope.schoolId !== schoolId) throw new ForbiddenException({ code: 'SUPPORT_FORBIDDEN' });
    const requestId = randomUUID();
    return { ...scope, principalType: 'HUMAN_USER', requestId, correlationId: requestId, idempotencyKey, source: 'HUMAN_UI', externalSubject: identity.externalSubject };
  }
}
