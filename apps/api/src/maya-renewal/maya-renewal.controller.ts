import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Header, Headers, HttpCode, HttpStatus, Injectable, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { MembershipActivationHumanUiGuard } from '../billing/membership-activation-human-ui.guard.js';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { MayaRenewalService, type MayaRenewalContext } from './maya-renewal.service.js';

/** P5 (0646): reading, asking, applying and dismissing are each their own same-origin browser command. */
@Injectable() export class MayaRenewalReadHumanUiGuard extends MembershipActivationHumanUiGuard { protected override readonly command: string = 'maya.renewal_prep.read'; }
@Injectable() export class MayaRenewalRequestHumanUiGuard extends MembershipActivationHumanUiGuard { protected override readonly command: string = 'maya.renewal_prep.request'; }
@Injectable() export class MayaRenewalApplyHumanUiGuard extends MembershipActivationHumanUiGuard { protected override readonly command: string = 'maya.renewal_prep.apply'; }
@Injectable() export class MayaRenewalCloseHumanUiGuard extends MembershipActivationHumanUiGuard { protected override readonly command: string = 'maya.renewal_prep.close'; }

/**
 * Maya renewal prep. Route identifiers are never authority: the scope comes from the verified session (Maya's retention
 * read at this school), and the database re-proves Maya's capability, membership read, renewal review management, AI planning
 * and the Complete plan, and every renewal authority (0080) when suggestions are applied.
 */
@Controller('organizations/:organizationId/schools/:schoolId/maya/renewal-prep')
@UseGuards(HonIdentityGuard)
export class MayaRenewalController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly maya: MayaRenewalService) {}

  @Get() @Header('Cache-Control', 'private, no-store') @Header('Referrer-Policy', 'no-referrer') @UseGuards(MayaRenewalReadHumanUiGuard)
  async list(@Param('organizationId', new ParseUUIDPipe()) o: string, @Param('schoolId', new ParseUUIDPipe()) s: string, @Headers('idempotency-key') k: string | undefined, @Req() r: HonRequest) {
    if (k !== undefined) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
    const context = await this.context(r, o, s, '');
    return { data: { aiAvailable: this.maya.available(), renewalPreps: await this.maya.list(context) }, meta: this.meta(context) };
  }
  @Post() @HttpCode(HttpStatus.OK) @Header('Cache-Control', 'private, no-store') @Header('Referrer-Policy', 'no-referrer') @UseGuards(MayaRenewalRequestHumanUiGuard)
  async request(@Param('organizationId', new ParseUUIDPipe()) o: string, @Param('schoolId', new ParseUUIDPipe()) s: string, @Headers('idempotency-key') k: string | undefined, @Body() input: unknown, @Req() r: HonRequest) {
    const context = await this.context(r, o, s, this.key(k));
    return { data: await this.maya.request(context, input), meta: this.meta(context) };
  }
  @Post(':id/apply') @HttpCode(HttpStatus.OK) @Header('Cache-Control', 'private, no-store') @Header('Referrer-Policy', 'no-referrer') @UseGuards(MayaRenewalApplyHumanUiGuard)
  async apply(@Param('organizationId', new ParseUUIDPipe()) o: string, @Param('schoolId', new ParseUUIDPipe()) s: string, @Param('id', new ParseUUIDPipe()) id: string,
    @Headers('idempotency-key') k: string | undefined, @Body() input: unknown, @Req() r: HonRequest) {
    const context = await this.context(r, o, s, this.key(k));
    return { data: await this.maya.apply(context, id, input), meta: this.meta(context) };
  }
  @Post(':id/close') @HttpCode(HttpStatus.OK) @Header('Cache-Control', 'private, no-store') @Header('Referrer-Policy', 'no-referrer') @UseGuards(MayaRenewalCloseHumanUiGuard)
  async close(@Param('organizationId', new ParseUUIDPipe()) o: string, @Param('schoolId', new ParseUUIDPipe()) s: string, @Param('id', new ParseUUIDPipe()) id: string,
    @Headers('idempotency-key') k: string | undefined, @Body() input: unknown, @Req() r: HonRequest) {
    const ok = input && typeof input === 'object' && !Array.isArray(input) && Object.keys(input).join(',') === 'status' && (input as { status: unknown }).status === 'DISMISSED';
    if (!ok) throw new BadRequestException({ code: 'MAYA_RENEWAL_INVALID' });
    const context = await this.context(r, o, s, this.key(k));
    return { data: await this.maya.dismiss(context, id), meta: this.meta(context) };
  }

  private meta(context: MayaRenewalContext) { return { requestId: context.requestId, correlationId: context.correlationId }; }
  private key(idempotencyKey: string | undefined): string {
    const key = idempotencyKey?.trim();
    if (!key || key.length > 160) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'A unique Idempotency-Key header is required.' });
    return key;
  }
  private async context(request: HonRequest, organizationId: string, schoolId: string, idempotencyKey: string): Promise<MayaRenewalContext> {
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException('HON identity context is missing.');
    if (Object.keys(request.query ?? {}).length) throw new BadRequestException({ code: 'MAYA_RENEWAL_INVALID' });
    const scope = await this.database.resolveAuthorizedScope(identity.externalSubject, schoolId, 'retention.review.read');
    if (!scope || scope.organizationId !== organizationId || scope.schoolId !== schoolId) throw new ForbiddenException('Maya renewal prep is not authorized for this school.');
    const requestId = randomUUID();
    return { ...scope, principalType: 'HUMAN_USER', requestId, correlationId: requestId, idempotencyKey, source: 'HUMAN_UI', externalSubject: identity.externalSubject };
  }
}
