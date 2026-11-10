import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Header, Headers, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import type { MembershipLifecycleContext } from '../billing/membership.service.js';
import { ClassSeriesCreateHumanUiGuard, ClassSeriesEndHumanUiGuard, ClassSeriesFillHumanUiGuard, ClassSeriesOngoingHumanUiGuard, ClassSeriesReadHumanUiGuard, ClassSeriesReviseHumanUiGuard, ClassSeriesTopUpHumanUiGuard } from './class-series-human-ui.guard.js';
import { CreateClassSeriesDto, EndClassSeriesDto, FillClassSeriesDto, ReviseClassSeriesDto, SetClassSeriesOngoingDto, TopUpClassSeriesDto } from './class-series.dto.js';
import { ClassSeriesService } from './class-series.service.js';

const MANAGE = 'schedule.session.manage';
const READ = 'schedule.session.read';

function definedFields(input: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input ?? {}).filter(([, value]) => value !== undefined));
}

/**
 * B-SCH-1 (0239): weekly class series and the weekly timetable. Route identifiers are never authority: the guarded boundary
 * resolves the route scope from the verified session, and each protected database function re-proves the direct human subject
 * and the live school-scoped permission. No timer, communication, charge or AI is reachable from these routes: the 0251 top-up
 * runs only when a manager's browser sends it.
 */
@Controller('organizations/:organizationId/schools/:schoolId/schedule')
@UseGuards(HonIdentityGuard)
export class ClassSeriesController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly series: ClassSeriesService) {}

  @Get('class-series')
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(ClassSeriesReadHumanUiGuard)
  async list(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined, @Req() request: HonRequest) {
    if (idempotencyKey !== undefined) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
    this.noQuery(request);
    const context = await this.context(request, organizationId, schoolId, MANAGE, '');
    return { data: await this.series.list(context), meta: { requestId: context.requestId, correlationId: context.correlationId } };
  }

  @Get('timetable')
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(ClassSeriesReadHumanUiGuard)
  async timetable(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined, @Query() query: Record<string, unknown>, @Req() request: HonRequest) {
    if (idempotencyKey !== undefined) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
    if (Object.keys(query ?? {}).some(key => key !== 'weekOf') || Object.values(query ?? {}).some(value => typeof value !== 'string')) {
      throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    }
    const context = await this.context(request, organizationId, schoolId, READ, '');
    const data = await this.series.timetable(context, query.weekOf === undefined ? {} : { weekOf: query.weekOf });
    return { data, meta: { requestId: context.requestId, correlationId: context.correlationId } };
  }

  @Post('class-series')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(ClassSeriesCreateHumanUiGuard)
  async create(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined, @Body() input: CreateClassSeriesDto, @Req() request: HonRequest) {
    this.noQuery(request);
    const context = await this.context(request, organizationId, schoolId, MANAGE, this.key(idempotencyKey));
    return this.receipt(context, await this.series.create(context, definedFields(input)));
  }

  @Post('class-series/:seriesId/revise')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(ClassSeriesReviseHumanUiGuard)
  async revise(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('seriesId', new ParseUUIDPipe()) seriesId: string, @Headers('idempotency-key') idempotencyKey: string | undefined, @Body() input: ReviseClassSeriesDto, @Req() request: HonRequest) {
    this.noQuery(request);
    const context = await this.context(request, organizationId, schoolId, MANAGE, this.key(idempotencyKey));
    return this.receipt(context, await this.series.revise(context, seriesId, definedFields(input)));
  }

  @Post('class-series/:seriesId/end')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(ClassSeriesEndHumanUiGuard)
  async end(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('seriesId', new ParseUUIDPipe()) seriesId: string, @Headers('idempotency-key') idempotencyKey: string | undefined, @Body() input: EndClassSeriesDto, @Req() request: HonRequest) {
    this.noQuery(request);
    const context = await this.context(request, organizationId, schoolId, MANAGE, this.key(idempotencyKey));
    return this.receipt(context, await this.series.end(context, seriesId, definedFields(input)));
  }

  @Post('class-series/:seriesId/fill')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(ClassSeriesFillHumanUiGuard)
  async fill(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('seriesId', new ParseUUIDPipe()) seriesId: string, @Headers('idempotency-key') idempotencyKey: string | undefined, @Body() input: FillClassSeriesDto, @Req() request: HonRequest) {
    this.noQuery(request);
    const context = await this.context(request, organizationId, schoolId, MANAGE, this.key(idempotencyKey));
    return this.receipt(context, await this.series.fill(context, seriesId, definedFields(input)));
  }

  @Post('class-series/:seriesId/ongoing')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(ClassSeriesOngoingHumanUiGuard)
  async ongoing(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('seriesId', new ParseUUIDPipe()) seriesId: string, @Headers('idempotency-key') idempotencyKey: string | undefined, @Body() input: SetClassSeriesOngoingDto, @Req() request: HonRequest) {
    this.noQuery(request);
    const context = await this.context(request, organizationId, schoolId, MANAGE, this.key(idempotencyKey));
    return this.receipt(context, await this.series.setOngoing(context, seriesId, definedFields(input)));
  }

  @Post('class-series/top-up')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(ClassSeriesTopUpHumanUiGuard)
  async topUp(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined, @Body() input: TopUpClassSeriesDto, @Req() request: HonRequest) {
    this.noQuery(request);
    const context = await this.context(request, organizationId, schoolId, MANAGE, this.key(idempotencyKey));
    return this.receipt(context, await this.series.topUp(context, definedFields(input)));
  }

  private receipt(context: MembershipLifecycleContext, result: { receipt: unknown; replayed: boolean }) {
    return { data: result.receipt, meta: { requestId: context.requestId, correlationId: context.correlationId, replayed: result.replayed } };
  }

  private noQuery(request: HonRequest): void {
    if (Object.keys(request.query ?? {}).length) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
  }

  private key(idempotencyKey: string | undefined): string {
    const key = idempotencyKey?.trim();
    if (!key || key.length > 200) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'A unique Idempotency-Key header is required.' });
    return key;
  }

  private async context(request: HonRequest, organizationId: string, schoolId: string, permission: string, idempotencyKey: string): Promise<MembershipLifecycleContext> {
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException('HON identity context is missing.');
    const scope = await this.database.resolveAuthorizedScope(identity.externalSubject, schoolId, permission);
    if (!scope || scope.organizationId.toLowerCase() !== organizationId.toLowerCase() || scope.schoolId.toLowerCase() !== schoolId.toLowerCase()) {
      throw new ForbiddenException({ code: permission === READ ? 'CLASS_SESSIONS_READ_FORBIDDEN' : 'CLASS_SERIES_FORBIDDEN' });
    }
    const requestId = randomUUID();
    return { ...scope, principalType: 'HUMAN_USER', requestId, correlationId: requestId, idempotencyKey, source: 'HUMAN_UI', externalSubject: identity.externalSubject };
  }
}
