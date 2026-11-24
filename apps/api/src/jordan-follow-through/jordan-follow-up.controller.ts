import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Header, Headers, HttpCode, HttpStatus, Injectable, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { MembershipActivationHumanUiGuard } from '../billing/membership-activation-human-ui.guard.js';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { JordanFollowUpService, type JordanFollowUpContext } from './jordan-follow-up.service.js';

/** P2 (0640): reading, asking, applying and dismissing are each their own same-origin browser command. */
@Injectable() export class JordanFollowUpReadHumanUiGuard extends MembershipActivationHumanUiGuard { protected override readonly command: string = 'jordan.follow_up.read'; }
@Injectable() export class JordanFollowUpRequestHumanUiGuard extends MembershipActivationHumanUiGuard { protected override readonly command: string = 'jordan.follow_up.request'; }
@Injectable() export class JordanFollowUpApplyHumanUiGuard extends MembershipActivationHumanUiGuard { protected override readonly command: string = 'jordan.follow_up.apply'; }
@Injectable() export class JordanFollowUpCloseHumanUiGuard extends MembershipActivationHumanUiGuard { protected override readonly command: string = 'jordan.follow_up.close'; }

/**
 * Jordan follow-through. Route identifiers are never authority: the scope comes from the verified session (class schedule
 * management at this school), and the database re-proves Jordan's capability, team task management, AI planning and the
 * Complete plan, and every work item authority (0084) when suggestions are applied.
 */
@Controller('organizations/:organizationId/schools/:schoolId/jordan/follow-ups')
@UseGuards(HonIdentityGuard)
export class JordanFollowUpController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly jordan: JordanFollowUpService) {}

  @Get() @Header('Cache-Control', 'private, no-store') @Header('Referrer-Policy', 'no-referrer') @UseGuards(JordanFollowUpReadHumanUiGuard)
  async list(@Param('organizationId', new ParseUUIDPipe()) o: string, @Param('schoolId', new ParseUUIDPipe()) s: string, @Headers('idempotency-key') k: string | undefined, @Req() r: HonRequest) {
    if (k !== undefined) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
    const context = await this.context(r, o, s, '');
    return { data: { aiAvailable: this.jordan.available(), followUps: await this.jordan.list(context) }, meta: this.meta(context) };
  }
  @Post() @HttpCode(HttpStatus.OK) @Header('Cache-Control', 'private, no-store') @Header('Referrer-Policy', 'no-referrer') @UseGuards(JordanFollowUpRequestHumanUiGuard)
  async request(@Param('organizationId', new ParseUUIDPipe()) o: string, @Param('schoolId', new ParseUUIDPipe()) s: string, @Headers('idempotency-key') k: string | undefined, @Body() input: unknown, @Req() r: HonRequest) {
    const context = await this.context(r, o, s, this.key(k));
    return { data: await this.jordan.request(context, input), meta: this.meta(context) };
  }
  @Post(':id/apply') @HttpCode(HttpStatus.OK) @Header('Cache-Control', 'private, no-store') @Header('Referrer-Policy', 'no-referrer') @UseGuards(JordanFollowUpApplyHumanUiGuard)
  async apply(@Param('organizationId', new ParseUUIDPipe()) o: string, @Param('schoolId', new ParseUUIDPipe()) s: string, @Param('id', new ParseUUIDPipe()) id: string,
    @Headers('idempotency-key') k: string | undefined, @Body() input: unknown, @Req() r: HonRequest) {
    const context = await this.context(r, o, s, this.key(k));
    return { data: await this.jordan.apply(context, id, input), meta: this.meta(context) };
  }
  @Post(':id/close') @HttpCode(HttpStatus.OK) @Header('Cache-Control', 'private, no-store') @Header('Referrer-Policy', 'no-referrer') @UseGuards(JordanFollowUpCloseHumanUiGuard)
  async close(@Param('organizationId', new ParseUUIDPipe()) o: string, @Param('schoolId', new ParseUUIDPipe()) s: string, @Param('id', new ParseUUIDPipe()) id: string,
    @Headers('idempotency-key') k: string | undefined, @Body() input: unknown, @Req() r: HonRequest) {
    const ok = input && typeof input === 'object' && !Array.isArray(input) && Object.keys(input).join(',') === 'status' && (input as { status: unknown }).status === 'DISMISSED';
    if (!ok) throw new BadRequestException({ code: 'JORDAN_FOLLOW_UP_INVALID' });
    const context = await this.context(r, o, s, this.key(k));
    return { data: await this.jordan.dismiss(context, id), meta: this.meta(context) };
  }

  private meta(context: JordanFollowUpContext) { return { requestId: context.requestId, correlationId: context.correlationId }; }
  private key(idempotencyKey: string | undefined): string {
    const key = idempotencyKey?.trim();
    if (!key || key.length > 160) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'A unique Idempotency-Key header is required.' });
    return key;
  }
  private async context(request: HonRequest, organizationId: string, schoolId: string, idempotencyKey: string): Promise<JordanFollowUpContext> {
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException('HON identity context is missing.');
    if (Object.keys(request.query ?? {}).length) throw new BadRequestException({ code: 'JORDAN_FOLLOW_UP_INVALID' });
    const scope = await this.database.resolveAuthorizedScope(identity.externalSubject, schoolId, 'schedule.session.manage');
    if (!scope || scope.organizationId !== organizationId || scope.schoolId !== schoolId) throw new ForbiddenException('Jordan follow-ups are not authorized for this school.');
    const requestId = randomUUID();
    return { ...scope, principalType: 'HUMAN_USER', requestId, correlationId: requestId, idempotencyKey, source: 'HUMAN_UI', externalSubject: identity.externalSubject };
  }
}
