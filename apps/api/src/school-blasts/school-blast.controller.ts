import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Header, Headers, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import type { MembershipLifecycleContext } from '../billing/membership.service.js';
import { CancelSchoolBlastDto, SaveSchoolBlastDto, SendSchoolBlastDto } from './school-blast.dto.js';
import { SchoolBlastCancelHumanUiGuard, SchoolBlastReadHumanUiGuard, SchoolBlastSaveHumanUiGuard, SchoolBlastSendHumanUiGuard } from './school-blast-human-ui.guard.js';
import { SchoolBlastService } from './school-blast.service.js';

const READ = 'marketing.blast.read';
const SEND = 'marketing.blast.send';

function definedFields(input: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input ?? {}).filter(([, value]) => value !== undefined));
}

/**
 * 0536: school email and text blasts. Route identifiers are never authority: the boundary resolves the route scope from
 * the verified session, and each protected database function re-proves the direct human subject and the live permission
 * (marketing.blast.read for reads, marketing.blast.send for save, send and cancel). Sending only queues 0243 messages.
 */
@Controller('organizations/:organizationId/schools/:schoolId/marketing/blasts')
@UseGuards(HonIdentityGuard)
export class SchoolBlastController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly blasts: SchoolBlastService) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(SchoolBlastReadHumanUiGuard)
  async list(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: HonRequest,
  ) {
    this.readOnly(request, idempotencyKey);
    const context = await this.context(request, organizationId, schoolId, '', READ);
    const data = await this.blasts.list(context);
    return { data, meta: { requestId: context.requestId, correlationId: context.correlationId } };
  }

  @Get(':blastId')
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(SchoolBlastReadHumanUiGuard)
  async get(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('blastId', new ParseUUIDPipe()) blastId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: HonRequest,
  ) {
    this.readOnly(request, idempotencyKey);
    const context = await this.context(request, organizationId, schoolId, '', READ);
    const data = await this.blasts.get(context, blastId);
    return { data, meta: { requestId: context.requestId, correlationId: context.correlationId } };
  }

  @Get(':blastId/audience')
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(SchoolBlastReadHumanUiGuard)
  async audience(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('blastId', new ParseUUIDPipe()) blastId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: HonRequest,
  ) {
    this.readOnly(request, idempotencyKey);
    const context = await this.context(request, organizationId, schoolId, '', READ);
    const data = await this.blasts.audience(context, blastId);
    return { data, meta: { requestId: context.requestId, correlationId: context.correlationId } };
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(SchoolBlastSaveHumanUiGuard)
  async save(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: SaveSchoolBlastDto,
    @Req() request: HonRequest,
  ) {
    const context = await this.context(request, organizationId, schoolId, this.key(request, idempotencyKey), SEND);
    const result = await this.blasts.save(context, definedFields(input));
    return { data: result.blast, meta: { requestId: context.requestId, correlationId: context.correlationId, replayed: result.replayed } };
  }

  @Post('send')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(SchoolBlastSendHumanUiGuard)
  async send(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: SendSchoolBlastDto,
    @Req() request: HonRequest,
  ) {
    const context = await this.context(request, organizationId, schoolId, this.key(request, idempotencyKey), SEND);
    const result = await this.blasts.send(context, definedFields(input));
    return { data: result.blast, meta: { requestId: context.requestId, correlationId: context.correlationId, replayed: result.replayed } };
  }

  @Post('cancel')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(SchoolBlastCancelHumanUiGuard)
  async cancel(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: CancelSchoolBlastDto,
    @Req() request: HonRequest,
  ) {
    const context = await this.context(request, organizationId, schoolId, this.key(request, idempotencyKey), SEND);
    const result = await this.blasts.cancel(context, definedFields(input));
    return { data: result.blast, meta: { requestId: context.requestId, correlationId: context.correlationId, replayed: result.replayed } };
  }

  private readOnly(request: HonRequest, idempotencyKey: string | undefined): void {
    if (idempotencyKey !== undefined) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
    this.noQuery(request);
  }

  private key(request: HonRequest, idempotencyKey: string | undefined): string {
    this.noQuery(request);
    const key = idempotencyKey?.trim();
    if (!key || key.length > 200) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'A unique Idempotency-Key header is required.' });
    return key;
  }

  private noQuery(request: HonRequest): void {
    if (Object.keys(request.query ?? {}).length) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
  }

  /** The session must hold the permission at exactly this route's school; the database decides again. */
  private async context(request: HonRequest, organizationId: string, schoolId: string, idempotencyKey: string, permission: string): Promise<MembershipLifecycleContext> {
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException('HON identity context is missing.');
    const scope = await this.database.resolveAuthorizedScope(identity.externalSubject, schoolId, permission);
    if (!scope || scope.organizationId.toLowerCase() !== organizationId.toLowerCase() || scope.schoolId.toLowerCase() !== schoolId.toLowerCase()) {
      throw new ForbiddenException({ code: 'SCHOOL_BLAST_FORBIDDEN' });
    }
    const requestId = randomUUID();
    return { ...scope, principalType: 'HUMAN_USER', requestId, correlationId: requestId, idempotencyKey, source: 'HUMAN_UI', externalSubject: identity.externalSubject };
  }
}
