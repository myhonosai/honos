import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Header, Headers, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import type { MembershipLifecycleContext } from '../billing/membership.service.js';
import { SaveSchoolBrandingDto } from './school-branding.dto.js';
import { SchoolBrandingReadHumanUiGuard, SchoolBrandingSaveHumanUiGuard } from './school-branding-human-ui.guard.js';
import { SchoolBrandingService } from './school-branding.service.js';

const MANAGE = 'school_branding.manage';

function definedFields(input: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input ?? {}).filter(([, value]) => value !== undefined));
}

/**
 * 0268: the school's shared page branding (logo, accent color, cover photo, contact line) shown on its booking and checkout
 * pages. Route identifiers are never authority: the guarded boundary resolves the route scope from the verified session, and
 * each protected database function re-proves the direct human subject and the live school_branding.manage permission.
 * Nothing here is public, uploads a file or fetches an image.
 */
@Controller('organizations/:organizationId/schools/:schoolId/settings/branding')
@UseGuards(HonIdentityGuard)
export class SchoolBrandingController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly branding: SchoolBrandingService) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(SchoolBrandingReadHumanUiGuard)
  async read(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: HonRequest,
  ) {
    if (idempotencyKey !== undefined) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
    this.noQuery(request);
    const context = await this.context(request, organizationId, schoolId, '');
    const data = await this.branding.read(context);
    return { data, meta: { requestId: context.requestId, correlationId: context.correlationId } };
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(SchoolBrandingSaveHumanUiGuard)
  async save(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: SaveSchoolBrandingDto,
    @Req() request: HonRequest,
  ) {
    this.noQuery(request);
    const key = idempotencyKey?.trim();
    if (!key || key.length > 200) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'A unique Idempotency-Key header is required.' });
    const context = await this.context(request, organizationId, schoolId, key);
    const result = await this.branding.save(context, definedFields(input));
    return { data: result.receipt, meta: { requestId: context.requestId, correlationId: context.correlationId, replayed: result.replayed } };
  }

  private noQuery(request: HonRequest): void {
    if (Object.keys(request.query ?? {}).length) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
  }

  private async context(request: HonRequest, organizationId: string, schoolId: string, idempotencyKey: string): Promise<MembershipLifecycleContext> {
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException('HON identity context is missing.');
    const scope = await this.database.resolveAuthorizedScope(identity.externalSubject, schoolId, MANAGE);
    if (!scope || scope.organizationId.toLowerCase() !== organizationId.toLowerCase() || scope.schoolId.toLowerCase() !== schoolId.toLowerCase()) {
      throw new ForbiddenException({ code: 'SCHOOL_BRANDING_FORBIDDEN' });
    }
    const requestId = randomUUID();
    return { ...scope, principalType: 'HUMAN_USER', requestId, correlationId: requestId, idempotencyKey, source: 'HUMAN_UI', externalSubject: identity.externalSubject };
  }
}
