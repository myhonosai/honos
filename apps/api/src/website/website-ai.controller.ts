import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Header, Headers, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { SchoolWebsiteAiApplyHumanUiGuard, SchoolWebsiteAiDismissHumanUiGuard, SchoolWebsiteAiRequestHumanUiGuard, SchoolWebsiteReadHumanUiGuard } from './school-website-human-ui.guard.js';
import type { SchoolWebsiteContext } from './school-website.service.js';
import { WebsiteAiService } from './website-ai.service.js';

/**
 * WB5 (0489): website suggestions from Marcus. Route identifiers are never authority: the scope comes from the verified
 * session, and the database re-proves website editing, the Marcus capability and the Complete plan for each request.
 */
@Controller('organizations/:organizationId/schools/:schoolId/website/ai-edits')
@UseGuards(HonIdentityGuard)
export class SchoolWebsiteAiController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly suggestions: WebsiteAiService) {}

  @Get() @Header('Cache-Control', 'private, no-store') @Header('Referrer-Policy', 'no-referrer') @UseGuards(SchoolWebsiteReadHumanUiGuard)
  async list(@Param('organizationId', new ParseUUIDPipe()) o: string, @Param('schoolId', new ParseUUIDPipe()) s: string, @Headers('idempotency-key') k: string | undefined, @Req() r: HonRequest) {
    if (k !== undefined) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
    const context = await this.context(r, o, s, '');
    return { data: await this.suggestions.list(context), meta: this.meta(context) };
  }
  @Get(':id') @Header('Cache-Control', 'private, no-store') @Header('Referrer-Policy', 'no-referrer') @UseGuards(SchoolWebsiteReadHumanUiGuard)
  async read(@Param('organizationId', new ParseUUIDPipe()) o: string, @Param('schoolId', new ParseUUIDPipe()) s: string, @Param('id', new ParseUUIDPipe()) id: string,
    @Headers('idempotency-key') k: string | undefined, @Req() r: HonRequest) {
    if (k !== undefined) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
    const context = await this.context(r, o, s, '');
    return { data: await this.suggestions.read(context, id), meta: this.meta(context) };
  }
  @Post() @HttpCode(HttpStatus.OK) @Header('Cache-Control', 'private, no-store') @Header('Referrer-Policy', 'no-referrer') @UseGuards(SchoolWebsiteAiRequestHumanUiGuard)
  async request(@Param('organizationId', new ParseUUIDPipe()) o: string, @Param('schoolId', new ParseUUIDPipe()) s: string, @Headers('idempotency-key') k: string | undefined, @Body() input: unknown, @Req() r: HonRequest) {
    const context = await this.context(r, o, s, this.key(k));
    return { data: await this.suggestions.request(context, input), meta: this.meta(context) };
  }
  @Post(':id/apply') @HttpCode(HttpStatus.OK) @Header('Cache-Control', 'private, no-store') @Header('Referrer-Policy', 'no-referrer') @UseGuards(SchoolWebsiteAiApplyHumanUiGuard)
  async apply(@Param('organizationId', new ParseUUIDPipe()) o: string, @Param('schoolId', new ParseUUIDPipe()) s: string, @Param('id', new ParseUUIDPipe()) id: string,
    @Headers('idempotency-key') k: string | undefined, @Body() input: unknown, @Req() r: HonRequest) {
    const context = await this.context(r, o, s, this.key(k));
    const result = await this.suggestions.apply(context, id, input);
    return { data: { website: result.website, suggestion: result.suggestion }, meta: { ...this.meta(context), replayed: result.replayed } };
  }
  @Post(':id/dismiss') @HttpCode(HttpStatus.OK) @Header('Cache-Control', 'private, no-store') @Header('Referrer-Policy', 'no-referrer') @UseGuards(SchoolWebsiteAiDismissHumanUiGuard)
  async dismiss(@Param('organizationId', new ParseUUIDPipe()) o: string, @Param('schoolId', new ParseUUIDPipe()) s: string, @Param('id', new ParseUUIDPipe()) id: string,
    @Headers('idempotency-key') k: string | undefined, @Body() input: unknown, @Req() r: HonRequest) {
    if (input !== undefined && input !== null && (typeof input !== 'object' || Object.keys(input as object).length)) throw new BadRequestException({ code: 'SCHOOL_WEBSITE_AI_INVALID' });
    const context = await this.context(r, o, s, this.key(k));
    return { data: await this.suggestions.dismiss(context, id), meta: this.meta(context) };
  }

  private meta(context: SchoolWebsiteContext) { return { requestId: context.requestId, correlationId: context.correlationId }; }
  private key(idempotencyKey: string | undefined): string {
    const key = idempotencyKey?.trim();
    if (!key || key.length > 200) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'A unique Idempotency-Key header is required.' });
    return key;
  }
  private async context(request: HonRequest, organizationId: string, schoolId: string, idempotencyKey: string): Promise<SchoolWebsiteContext> {
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException('HON identity context is missing.');
    if (Object.keys(request.query ?? {}).length) throw new BadRequestException({ code: 'SCHOOL_WEBSITE_AI_INVALID' });
    const scope = await this.database.resolveAuthorizedScope(identity.externalSubject, schoolId, 'website.edit');
    if (!scope || scope.organizationId !== organizationId || scope.schoolId !== schoolId) throw new ForbiddenException('Website suggestions are not authorized for this school.');
    const requestId = randomUUID();
    return { ...scope, principalType: 'HUMAN_USER', requestId, correlationId: requestId, idempotencyKey, source: 'HUMAN_UI', externalSubject: identity.externalSubject };
  }
}
