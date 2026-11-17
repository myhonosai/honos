import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Header, Headers, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { HonIdentityGuard } from '../../foundation/hon-identity.guard.js';
import type { HonRequest } from '../../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../../foundation/runtime-database.service.js';
import {
  SchoolSocialAdBudgetHumanUiGuard, SchoolSocialAdCancelHumanUiGuard, SchoolSocialAdCreateHumanUiGuard, SchoolSocialAdOperationHumanUiGuard,
  SchoolSocialAdResolveHumanUiGuard, SchoolSocialReadHumanUiGuard,
} from './school-social.guard.js';
import { SchoolSocialAdsService } from './school-social-ads.service.js';
import type { SchoolSocialContext } from './school-social.service.js';

const ADS = 'marketing.social.ads';
const BUDGET = 'marketing.social.ads.budget';

/**
 * School ads (0437). Route ids are never authority: scope comes from the verified session and every database call
 * re-proves the person at the session school (marketing.social.ads, or marketing.social.ads.budget for the cap).
 */
@Controller('organizations/:organizationId/schools/:schoolId/marketing/social/ads')
@UseGuards(HonIdentityGuard)
export class SchoolSocialAdsController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly ads: SchoolSocialAdsService) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @UseGuards(SchoolSocialReadHumanUiGuard)
  async view(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string, @Headers('idempotency-key') idempotencyKey: string | undefined, @Req() request: HonRequest) {
    if (Object.keys(request.query ?? {}).length) throw new BadRequestException({ code: 'SOCIAL_INVALID' });
    if (idempotencyKey !== undefined) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
    const context = await this.context(request, organizationId, schoolId, '', ADS);
    return { data: await this.ads.read(context), meta: this.meta(context) };
  }

  @Post('budget')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @UseGuards(SchoolSocialAdBudgetHumanUiGuard)
  async budget(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined, @Body() input: unknown, @Req() request: HonRequest) {
    const context = await this.command(request, organizationId, schoolId, idempotencyKey, BUDGET);
    const { view, replayed } = await this.ads.budget(context, input);
    return { data: view, meta: { ...this.meta(context), replayed } };
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @UseGuards(SchoolSocialAdCreateHumanUiGuard)
  async create(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined, @Body() input: unknown, @Req() request: HonRequest) {
    const context = await this.command(request, organizationId, schoolId, idempotencyKey, ADS);
    const { ad, replayed } = await this.ads.create(context, input);
    return { data: ad, meta: { ...this.meta(context), replayed } };
  }

  @Post(':adId/operation')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @UseGuards(SchoolSocialAdOperationHumanUiGuard)
  async operation(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string, @Param('adId', new ParseUUIDPipe()) adId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined, @Body() input: unknown, @Req() request: HonRequest) {
    const context = await this.command(request, organizationId, schoolId, idempotencyKey, ADS);
    const { ad, replayed } = await this.ads.operation(context, adId, input);
    return { data: ad, meta: { ...this.meta(context), replayed } };
  }

  @Post(':adId/cancel')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @UseGuards(SchoolSocialAdCancelHumanUiGuard)
  async cancel(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string, @Param('adId', new ParseUUIDPipe()) adId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined, @Body() input: unknown, @Req() request: HonRequest) {
    const context = await this.command(request, organizationId, schoolId, idempotencyKey, ADS);
    const { ad, replayed } = await this.ads.cancel(context, adId, input);
    return { data: ad, meta: { ...this.meta(context), replayed } };
  }

  @Post(':adId/resolve')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @UseGuards(SchoolSocialAdResolveHumanUiGuard)
  async resolve(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string, @Param('adId', new ParseUUIDPipe()) adId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined, @Body() input: unknown, @Req() request: HonRequest) {
    const context = await this.command(request, organizationId, schoolId, idempotencyKey, ADS);
    const { ad, replayed } = await this.ads.resolve(context, adId, input);
    return { data: ad, meta: { ...this.meta(context), replayed } };
  }

  private meta(context: SchoolSocialContext) { return { requestId: context.requestId, correlationId: context.correlationId }; }

  private command(request: HonRequest, organizationId: string, schoolId: string, idempotencyKey: string | undefined, permission: string): Promise<SchoolSocialContext> {
    if (Object.keys(request.query ?? {}).length) throw new BadRequestException({ code: 'SOCIAL_INVALID' });
    if (!idempotencyKey || idempotencyKey.length > 200 || idempotencyKey.trim() !== idempotencyKey) throw new BadRequestException({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
    return this.context(request, organizationId, schoolId, idempotencyKey, permission);
  }

  private async context(request: HonRequest, organizationId: string, schoolId: string, idempotencyKey: string, permission: string): Promise<SchoolSocialContext> {
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException('HON identity context is missing.');
    const scope = await this.database.resolveAuthorizedScope(identity.externalSubject, schoolId, permission);
    if (!scope || scope.organizationId !== organizationId || scope.schoolId !== schoolId) throw new ForbiddenException({ code: 'SOCIAL_FORBIDDEN' });
    const requestId = randomUUID();
    return { ...scope, principalType: 'HUMAN_USER', requestId, correlationId: requestId, idempotencyKey, source: 'HUMAN_UI', externalSubject: identity.externalSubject };
  }
}
