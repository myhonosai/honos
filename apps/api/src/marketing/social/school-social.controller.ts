import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Header, Headers, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { HonIdentityGuard } from '../../foundation/hon-identity.guard.js';
import type { HonRequest } from '../../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../../foundation/runtime-database.service.js';
import { SchoolSocialChangeHumanUiGuard, SchoolSocialCompleteHumanUiGuard, SchoolSocialConnectHumanUiGuard, SchoolSocialReadHumanUiGuard } from './school-social.guard.js';
import { SchoolSocialService, type SchoolSocialContext } from './school-social.service.js';

const READ = 'marketing.social.read', MANAGE = 'marketing.social.manage';

/** School social connections (0347). Route ids are never authority: scope comes from the verified session and the database re-proves it. */
@Controller('organizations/:organizationId/schools/:schoolId/marketing/social')
@UseGuards(HonIdentityGuard)
export class SchoolSocialController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly social: SchoolSocialService) {}

  @Get('accounts')
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @UseGuards(SchoolSocialReadHumanUiGuard)
  async list(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined, @Req() request: HonRequest) {
    if (idempotencyKey !== undefined) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
    const context = await this.context(request, organizationId, schoolId, '', READ);
    return { data: await this.social.list(context), meta: { requestId: context.requestId, correlationId: context.correlationId } };
  }

  @Post('connect')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @UseGuards(SchoolSocialConnectHumanUiGuard)
  async connect(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined, @Body() input: unknown, @Req() request: HonRequest) {
    const context = await this.context(request, organizationId, schoolId, this.key(idempotencyKey), MANAGE);
    return { data: await this.social.start(context, input), meta: { requestId: context.requestId, correlationId: context.correlationId } };
  }

  @Post('connect/complete')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @UseGuards(SchoolSocialCompleteHumanUiGuard)
  async complete(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined, @Body() input: unknown, @Req() request: HonRequest) {
    const context = await this.context(request, organizationId, schoolId, this.key(idempotencyKey), MANAGE);
    return { data: await this.social.complete(context, input), meta: { requestId: context.requestId, correlationId: context.correlationId } };
  }

  @Post('accounts/:accountId')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @UseGuards(SchoolSocialChangeHumanUiGuard)
  async change(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('accountId', new ParseUUIDPipe()) accountId: string, @Headers('idempotency-key') idempotencyKey: string | undefined, @Body() input: unknown, @Req() request: HonRequest) {
    const context = await this.context(request, organizationId, schoolId, this.key(idempotencyKey), MANAGE);
    const { replayed, ...result } = await this.social.change(context, accountId, input);
    return { data: result, meta: { requestId: context.requestId, correlationId: context.correlationId, replayed } };
  }

  private key(idempotencyKey: string | undefined): string {
    if (!idempotencyKey || idempotencyKey.length > 200 || idempotencyKey.trim() !== idempotencyKey) throw new BadRequestException({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
    return idempotencyKey;
  }

  private async context(request: HonRequest, organizationId: string, schoolId: string, idempotencyKey: string, permission: string): Promise<SchoolSocialContext> {
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException('HON identity context is missing.');
    if (Object.keys(request.query ?? {}).length) throw new BadRequestException({ code: 'SOCIAL_INVALID' });
    const scope = await this.database.resolveAuthorizedScope(identity.externalSubject, schoolId, permission);
    if (!scope || scope.organizationId !== organizationId || scope.schoolId !== schoolId) throw new ForbiddenException({ code: 'SOCIAL_FORBIDDEN' });
    const requestId = randomUUID();
    return { ...scope, principalType: 'HUMAN_USER', requestId, correlationId: requestId, idempotencyKey, source: 'HUMAN_UI', externalSubject: identity.externalSubject };
  }
}
