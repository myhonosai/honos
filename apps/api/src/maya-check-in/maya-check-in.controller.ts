import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Header, Headers, HttpCode, HttpStatus, Injectable, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { MembershipActivationHumanUiGuard } from '../billing/membership-activation-human-ui.guard.js';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { MayaCheckInService, type MayaCheckInContext } from './maya-check-in.service.js';

/** P8 (0649): reading, asking, approving, cancelling and dismissing are each their own same-origin browser command. */
@Injectable() export class MayaCheckInReadHumanUiGuard extends MembershipActivationHumanUiGuard { protected override readonly command: string = 'maya.check_in.read'; }
@Injectable() export class MayaCheckInRequestHumanUiGuard extends MembershipActivationHumanUiGuard { protected override readonly command: string = 'maya.check_in.request'; }
@Injectable() export class MayaCheckInApproveHumanUiGuard extends MembershipActivationHumanUiGuard { protected override readonly command: string = 'maya.check_in.approve'; }
@Injectable() export class MayaCheckInCancelHumanUiGuard extends MembershipActivationHumanUiGuard { protected override readonly command: string = 'maya.check_in.cancel'; }
@Injectable() export class MayaCheckInCloseHumanUiGuard extends MembershipActivationHumanUiGuard { protected override readonly command: string = 'maya.check_in.close'; }

/**
 * Maya check-in drafts. Route identifiers are never authority: the scope comes from the verified session (Maya's retention
 * read at this school), and the database re-proves Maya's capability, message queueing, AI planning and the Complete plan, that
 * the student is on the at-risk list, the recipient's consent and address, and the daily cap when a draft is approved.
 */
@Controller('organizations/:organizationId/schools/:schoolId/maya/check-ins')
@UseGuards(HonIdentityGuard)
export class MayaCheckInController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly maya: MayaCheckInService) {}

  @Get() @Header('Cache-Control', 'private, no-store') @Header('Referrer-Policy', 'no-referrer') @UseGuards(MayaCheckInReadHumanUiGuard)
  async list(@Param('organizationId', new ParseUUIDPipe()) o: string, @Param('schoolId', new ParseUUIDPipe()) s: string, @Headers('idempotency-key') k: string | undefined, @Req() r: HonRequest) {
    if (k !== undefined) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
    const context = await this.context(r, o, s, '');
    return { data: { aiAvailable: this.maya.available(), checkIns: await this.maya.list(context) }, meta: this.meta(context) };
  }
  @Post() @HttpCode(HttpStatus.OK) @Header('Cache-Control', 'private, no-store') @Header('Referrer-Policy', 'no-referrer') @UseGuards(MayaCheckInRequestHumanUiGuard)
  async request(@Param('organizationId', new ParseUUIDPipe()) o: string, @Param('schoolId', new ParseUUIDPipe()) s: string, @Headers('idempotency-key') k: string | undefined, @Body() input: unknown, @Req() r: HonRequest) {
    const context = await this.context(r, o, s, this.key(k));
    return { data: await this.maya.request(context, input), meta: this.meta(context) };
  }
  /** Approve (button or voice): queues one message through the school's ordinary delivery checks. */
  @Post(':id/approve') @HttpCode(HttpStatus.OK) @Header('Cache-Control', 'private, no-store') @Header('Referrer-Policy', 'no-referrer') @UseGuards(MayaCheckInApproveHumanUiGuard)
  async approve(@Param('organizationId', new ParseUUIDPipe()) o: string, @Param('schoolId', new ParseUUIDPipe()) s: string, @Param('id', new ParseUUIDPipe()) id: string,
    @Headers('idempotency-key') k: string | undefined, @Body() input: unknown, @Req() r: HonRequest) {
    const context = await this.context(r, o, s, this.key(k));
    return { data: await this.maya.approve(context, id, input), meta: this.meta(context) };
  }
  @Post(':id/cancel') @HttpCode(HttpStatus.OK) @Header('Cache-Control', 'private, no-store') @Header('Referrer-Policy', 'no-referrer') @UseGuards(MayaCheckInCancelHumanUiGuard)
  async cancel(@Param('organizationId', new ParseUUIDPipe()) o: string, @Param('schoolId', new ParseUUIDPipe()) s: string, @Param('id', new ParseUUIDPipe()) id: string,
    @Headers('idempotency-key') k: string | undefined, @Body() input: unknown, @Req() r: HonRequest) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length) throw new BadRequestException({ code: 'MAYA_CHECK_IN_INVALID' });
    const context = await this.context(r, o, s, this.key(k));
    return { data: await this.maya.cancel(context, id), meta: this.meta(context) };
  }
  @Post(':id/close') @HttpCode(HttpStatus.OK) @Header('Cache-Control', 'private, no-store') @Header('Referrer-Policy', 'no-referrer') @UseGuards(MayaCheckInCloseHumanUiGuard)
  async close(@Param('organizationId', new ParseUUIDPipe()) o: string, @Param('schoolId', new ParseUUIDPipe()) s: string, @Param('id', new ParseUUIDPipe()) id: string,
    @Headers('idempotency-key') k: string | undefined, @Body() input: unknown, @Req() r: HonRequest) {
    const ok = input && typeof input === 'object' && !Array.isArray(input) && Object.keys(input).join(',') === 'status' && (input as { status: unknown }).status === 'DISMISSED';
    if (!ok) throw new BadRequestException({ code: 'MAYA_CHECK_IN_INVALID' });
    const context = await this.context(r, o, s, this.key(k));
    return { data: await this.maya.dismiss(context, id), meta: this.meta(context) };
  }

  private meta(context: MayaCheckInContext) { return { requestId: context.requestId, correlationId: context.correlationId }; }
  private key(idempotencyKey: string | undefined): string {
    const key = idempotencyKey?.trim();
    if (!key || key.length > 160) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'A unique Idempotency-Key header is required.' });
    return key;
  }
  private async context(request: HonRequest, organizationId: string, schoolId: string, idempotencyKey: string): Promise<MayaCheckInContext> {
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException('HON identity context is missing.');
    if (Object.keys(request.query ?? {}).length) throw new BadRequestException({ code: 'MAYA_CHECK_IN_INVALID' });
    const scope = await this.database.resolveAuthorizedScope(identity.externalSubject, schoolId, 'retention.review.read');
    if (!scope || scope.organizationId !== organizationId || scope.schoolId !== schoolId) throw new ForbiddenException('Maya check-in drafts are not authorized for this school.');
    const requestId = randomUUID();
    return { ...scope, principalType: 'HUMAN_USER', requestId, correlationId: requestId, idempotencyKey, source: 'HUMAN_UI', externalSubject: identity.externalSubject };
  }
}
