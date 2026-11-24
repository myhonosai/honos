import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Header, Headers, HttpCode, HttpStatus, Injectable, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { MembershipActivationHumanUiGuard } from '../billing/membership-activation-human-ui.guard.js';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { MarcusReviewService, type MarcusReviewContext } from './marcus-review.service.js';

/** P3 (0641): reading, asking and dismissing are each their own same-origin browser command. */
@Injectable() export class MarcusReviewReadHumanUiGuard extends MembershipActivationHumanUiGuard { protected override readonly command: string = 'marcus.review.read'; }
@Injectable() export class MarcusReviewRequestHumanUiGuard extends MembershipActivationHumanUiGuard { protected override readonly command: string = 'marcus.review.request'; }
@Injectable() export class MarcusReviewCloseHumanUiGuard extends MembershipActivationHumanUiGuard { protected override readonly command: string = 'marcus.review.close'; }

/**
 * Marcus marketing review. Route identifiers are never authority: the scope comes from the verified session (campaign reading
 * at this school), and the database re-proves Marcus's capability, AI planning and the Complete plan on every command.
 */
@Controller('organizations/:organizationId/schools/:schoolId/marcus/reviews')
@UseGuards(HonIdentityGuard)
export class MarcusReviewController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly marcus: MarcusReviewService) {}

  @Get() @Header('Cache-Control', 'private, no-store') @Header('Referrer-Policy', 'no-referrer') @UseGuards(MarcusReviewReadHumanUiGuard)
  async list(@Param('organizationId', new ParseUUIDPipe()) o: string, @Param('schoolId', new ParseUUIDPipe()) s: string, @Headers('idempotency-key') k: string | undefined, @Req() r: HonRequest) {
    if (k !== undefined) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
    const context = await this.context(r, o, s, '');
    return { data: { aiAvailable: this.marcus.available(), reviews: await this.marcus.list(context) }, meta: this.meta(context) };
  }
  @Post() @HttpCode(HttpStatus.OK) @Header('Cache-Control', 'private, no-store') @Header('Referrer-Policy', 'no-referrer') @UseGuards(MarcusReviewRequestHumanUiGuard)
  async request(@Param('organizationId', new ParseUUIDPipe()) o: string, @Param('schoolId', new ParseUUIDPipe()) s: string, @Headers('idempotency-key') k: string | undefined, @Body() input: unknown, @Req() r: HonRequest) {
    const context = await this.context(r, o, s, this.key(k));
    return { data: await this.marcus.request(context, input), meta: this.meta(context) };
  }
  @Post(':id/close') @HttpCode(HttpStatus.OK) @Header('Cache-Control', 'private, no-store') @Header('Referrer-Policy', 'no-referrer') @UseGuards(MarcusReviewCloseHumanUiGuard)
  async close(@Param('organizationId', new ParseUUIDPipe()) o: string, @Param('schoolId', new ParseUUIDPipe()) s: string, @Param('id', new ParseUUIDPipe()) id: string,
    @Headers('idempotency-key') k: string | undefined, @Body() input: unknown, @Req() r: HonRequest) {
    const ok = input && typeof input === 'object' && !Array.isArray(input) && Object.keys(input).join(',') === 'status' && (input as { status: unknown }).status === 'DISMISSED';
    if (!ok) throw new BadRequestException({ code: 'MARCUS_REVIEW_INVALID' });
    const context = await this.context(r, o, s, this.key(k));
    return { data: await this.marcus.dismiss(context, id), meta: this.meta(context) };
  }

  private meta(context: MarcusReviewContext) { return { requestId: context.requestId, correlationId: context.correlationId }; }
  private key(idempotencyKey: string | undefined): string {
    const key = idempotencyKey?.trim();
    if (!key || key.length > 160) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'A unique Idempotency-Key header is required.' });
    return key;
  }
  private async context(request: HonRequest, organizationId: string, schoolId: string, idempotencyKey: string): Promise<MarcusReviewContext> {
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException('HON identity context is missing.');
    if (Object.keys(request.query ?? {}).length) throw new BadRequestException({ code: 'MARCUS_REVIEW_INVALID' });
    const scope = await this.database.resolveAuthorizedScope(identity.externalSubject, schoolId, 'marketing.campaign.read');
    if (!scope || scope.organizationId !== organizationId || scope.schoolId !== schoolId) throw new ForbiddenException('Marcus reviews are not authorized for this school.');
    const requestId = randomUUID();
    return { ...scope, principalType: 'HUMAN_USER', requestId, correlationId: requestId, idempotencyKey, source: 'HUMAN_UI', externalSubject: identity.externalSubject };
  }
}
