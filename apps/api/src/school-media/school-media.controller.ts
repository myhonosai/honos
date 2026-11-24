import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Header, Headers, HttpCode, HttpStatus, NotFoundException, Param, ParseUUIDPipe, Post, Req, Res, UseGuards } from '@nestjs/common';
import { SCHOOL_MEDIA_TITLE_HEADER } from '@hon/contracts';
import type { Response } from 'express';
import { randomUUID } from 'node:crypto';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import type { MembershipLifecycleContext } from '../billing/membership.service.js';
import { DeleteSchoolMediaDto, RenameSchoolMediaDto } from './school-media.dto.js';
import { SchoolMediaDeleteHumanUiGuard, SchoolMediaReadHumanUiGuard, SchoolMediaRenameHumanUiGuard, SchoolMediaUploadHumanUiGuard } from './school-media-human-ui.guard.js';
import { SchoolMediaService } from './school-media.service.js';

const READ = 'marketing.media.read';
const MANAGE = 'marketing.media.manage';

function definedFields(input: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input ?? {}).filter(([, value]) => value !== undefined));
}
/** The title header is percent-encoded UTF-8; anything that does not decode is refused. */
function decodeTitle(header: string | string[] | undefined): string {
  if (typeof header !== 'string' || header.length < 1 || header.length > 1000 || !/^[A-Za-z0-9%._~!*'()-]+$/.test(header)) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
  try { return decodeURIComponent(header); } catch { throw new BadRequestException({ code: 'VALIDATION_FAILED' }); }
}

/**
 * 0628: the school media library. Route identifiers are never authority: the boundary resolves the route scope from the
 * verified session, and each protected database function re-proves the direct human subject and the live permission
 * (marketing.media.read for the list, marketing.media.manage for upload, rename and delete).
 */
@Controller('organizations/:organizationId/schools/:schoolId/marketing/media')
@UseGuards(HonIdentityGuard)
export class SchoolMediaController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly media: SchoolMediaService) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(SchoolMediaReadHumanUiGuard)
  async list(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: HonRequest,
  ) {
    if (idempotencyKey !== undefined) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
    this.noQuery(request);
    const context = await this.context(request, organizationId, schoolId, '', READ);
    const data = await this.media.library(context);
    return { data, meta: { requestId: context.requestId, correlationId: context.correlationId } };
  }

  /** Raw picture bytes (schoolMediaUploadTransport); the title travels in X-HON-Media-Title. */
  @Post('upload')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(SchoolMediaUploadHumanUiGuard)
  async upload(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers(SCHOOL_MEDIA_TITLE_HEADER) titleHeader: string | undefined,
    @Headers('content-type') contentType: string | undefined,
    @Req() request: HonRequest,
  ) {
    const context = await this.context(request, organizationId, schoolId, this.key(request, idempotencyKey), MANAGE);
    const body = (request as unknown as { body?: unknown }).body;
    const result = await this.media.upload(context, { title: decodeTitle(titleHeader), mediaType: (contentType ?? '').split(';')[0]!.trim().toLowerCase(), bytes: body });
    return { data: result.asset, meta: { requestId: context.requestId, correlationId: context.correlationId, replayed: result.replayed } };
  }

  @Post('rename')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(SchoolMediaRenameHumanUiGuard)
  async rename(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: RenameSchoolMediaDto,
    @Req() request: HonRequest,
  ) {
    const context = await this.context(request, organizationId, schoolId, this.key(request, idempotencyKey), MANAGE);
    const result = await this.media.rename(context, definedFields(input));
    return { data: result.asset, meta: { requestId: context.requestId, correlationId: context.correlationId, replayed: result.replayed } };
  }

  @Post('delete')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(SchoolMediaDeleteHumanUiGuard)
  async delete(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: DeleteSchoolMediaDto,
    @Req() request: HonRequest,
  ) {
    const context = await this.context(request, organizationId, schoolId, this.key(request, idempotencyKey), MANAGE);
    const result = await this.media.delete(context, definedFields(input));
    return { data: { assetId: result.assetId, removed: result.removed }, meta: { requestId: context.requestId, correlationId: context.correlationId, replayed: result.replayed } };
  }

  private key(request: HonRequest, idempotencyKey: string | undefined): string {
    this.noQuery(request);
    const key = idempotencyKey?.trim();
    if (!key || key !== idempotencyKey || key.length > 200) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'A unique Idempotency-Key header is required.' });
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
      throw new ForbiddenException({ code: 'SCHOOL_MEDIA_FORBIDDEN' });
    }
    const requestId = randomUUID();
    return { ...scope, principalType: 'HUMAN_USER', requestId, correlationId: requestId, idempotencyKey, source: 'HUMAN_UI', externalSubject: identity.externalSubject };
  }
}

/**
 * The public picture link (the web serves it as /m/<token>): no session, cookie or tenant id is read. The token alone names
 * the picture and the database decides (READY picture, ACTIVE school and organization). The answer is a redirect to a
 * five-minute signed file link and is never cached, so a deleted picture stops at once.
 */
@Controller('public/media')
export class PublicSchoolMediaController {
  constructor(private readonly media: SchoolMediaService) {}

  @Get(':token')
  @Header('Cache-Control', 'no-store')
  async open(@Param('token') token: string, @Res() response: Response): Promise<void> {
    const url = await this.media.publicLink(token);
    if (!url) throw new NotFoundException({ result: 'INVALID' });
    response.setHeader('Cache-Control', 'no-store');
    response.redirect(302, url);
  }
}
