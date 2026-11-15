import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Header, Headers, HttpCode, HttpStatus, NotFoundException, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import {
  SchoolWebsiteCreateHumanUiGuard,
  SchoolWebsitePublishHumanUiGuard,
  SchoolWebsiteReadHumanUiGuard,
  SchoolWebsiteRollbackHumanUiGuard,
  SchoolWebsiteSaveHumanUiGuard,
  SchoolWebsiteUnpublishHumanUiGuard,
} from './school-website-human-ui.guard.js';
import { SchoolWebsiteService, type SchoolWebsiteContext, type SchoolWebsiteOperation } from './school-website.service.js';

/**
 * School websites (0361). Route identifiers are never authority: the scope is resolved from the verified session, and the
 * database re-proves the direct human subject and the live website permission for each call. Bodies are validated closed
 * in the service and again in the database.
 */
@Controller('organizations/:organizationId/schools/:schoolId/website')
@UseGuards(HonIdentityGuard)
export class SchoolWebsiteController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly websites: SchoolWebsiteService) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @UseGuards(SchoolWebsiteReadHumanUiGuard)
  async read(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined, @Req() request: HonRequest) {
    if (idempotencyKey !== undefined) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
    const context = await this.context(request, organizationId, schoolId, '', 'website.read');
    return { data: await this.websites.read(context), meta: { requestId: context.requestId, correlationId: context.correlationId } };
  }

  @Post() @HttpCode(HttpStatus.OK) @Header('Cache-Control', 'private, no-store') @Header('Referrer-Policy', 'no-referrer') @UseGuards(SchoolWebsiteCreateHumanUiGuard)
  create(@Param('organizationId', new ParseUUIDPipe()) o: string, @Param('schoolId', new ParseUUIDPipe()) s: string, @Headers('idempotency-key') k: string | undefined, @Body() input: unknown, @Req() r: HonRequest) {
    return this.command(r, o, s, k, 'create', input);
  }
  @Post('draft') @HttpCode(HttpStatus.OK) @Header('Cache-Control', 'private, no-store') @Header('Referrer-Policy', 'no-referrer') @UseGuards(SchoolWebsiteSaveHumanUiGuard)
  save(@Param('organizationId', new ParseUUIDPipe()) o: string, @Param('schoolId', new ParseUUIDPipe()) s: string, @Headers('idempotency-key') k: string | undefined, @Body() input: unknown, @Req() r: HonRequest) {
    return this.command(r, o, s, k, 'save', input);
  }
  @Post('publish') @HttpCode(HttpStatus.OK) @Header('Cache-Control', 'private, no-store') @Header('Referrer-Policy', 'no-referrer') @UseGuards(SchoolWebsitePublishHumanUiGuard)
  publish(@Param('organizationId', new ParseUUIDPipe()) o: string, @Param('schoolId', new ParseUUIDPipe()) s: string, @Headers('idempotency-key') k: string | undefined, @Body() input: unknown, @Req() r: HonRequest) {
    return this.command(r, o, s, k, 'publish', input);
  }
  @Post('rollback') @HttpCode(HttpStatus.OK) @Header('Cache-Control', 'private, no-store') @Header('Referrer-Policy', 'no-referrer') @UseGuards(SchoolWebsiteRollbackHumanUiGuard)
  rollback(@Param('organizationId', new ParseUUIDPipe()) o: string, @Param('schoolId', new ParseUUIDPipe()) s: string, @Headers('idempotency-key') k: string | undefined, @Body() input: unknown, @Req() r: HonRequest) {
    return this.command(r, o, s, k, 'rollback', input);
  }
  @Post('unpublish') @HttpCode(HttpStatus.OK) @Header('Cache-Control', 'private, no-store') @Header('Referrer-Policy', 'no-referrer') @UseGuards(SchoolWebsiteUnpublishHumanUiGuard)
  unpublish(@Param('organizationId', new ParseUUIDPipe()) o: string, @Param('schoolId', new ParseUUIDPipe()) s: string, @Headers('idempotency-key') k: string | undefined, @Body() input: unknown, @Req() r: HonRequest) {
    return this.command(r, o, s, k, 'unpublish', input);
  }

  private async command(request: HonRequest, organizationId: string, schoolId: string, idempotencyKey: string | undefined, operation: SchoolWebsiteOperation, input: unknown) {
    const permission = operation === 'create' || operation === 'save' ? 'website.edit' : 'website.publish';
    const context = await this.context(request, organizationId, schoolId, this.key(idempotencyKey), permission);
    const result = await this.websites.mutate(context, operation, input);
    return { data: result.website, meta: { requestId: context.requestId, correlationId: context.correlationId, replayed: result.replayed } };
  }

  private key(idempotencyKey: string | undefined): string {
    const key = idempotencyKey?.trim();
    if (!key || key.length > 200) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'A unique Idempotency-Key header is required.' });
    return key;
  }

  private async context(request: HonRequest, organizationId: string, schoolId: string, idempotencyKey: string, permission: string): Promise<SchoolWebsiteContext> {
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException('HON identity context is missing.');
    if (Object.keys(request.query ?? {}).length) throw new BadRequestException({ code: 'SCHOOL_WEBSITE_INVALID' });
    const scope = await this.database.resolveAuthorizedScope(identity.externalSubject, schoolId, permission);
    if (!scope || scope.organizationId !== organizationId || scope.schoolId !== schoolId) throw new ForbiddenException('The school website is not authorized for this school.');
    const requestId = randomUUID();
    return { ...scope, principalType: 'HUMAN_USER', requestId, correlationId: requestId, idempotencyKey, source: 'HUMAN_UI', externalSubject: identity.externalSubject };
  }
}

/** Public published site: GET only, no session, no cookies needed. Unknown or offline sites are a generic 404. */
@Controller('public/sites')
export class PublishedSchoolWebsiteController {
  constructor(private readonly websites: SchoolWebsiteService) {}
  @Get(':slug') @Header('Cache-Control', 'no-store')
  async published(@Param('slug') slug: string) {
    const data = await this.websites.published(slug);
    if (!data) throw new NotFoundException({ result: 'invalid' });
    return { data };
  }
}
