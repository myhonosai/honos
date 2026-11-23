import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Header, Headers, HttpCode, HttpStatus, Injectable, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { MembershipActivationHumanUiGuard } from '../../billing/membership-activation-human-ui.guard.js';
import { HonIdentityGuard } from '../../foundation/hon-identity.guard.js';
import type { HonRequest } from '../../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../../foundation/runtime-database.service.js';
import { CommerceReviewService, type CommerceReviewContext } from './commerce-review.service.js';

/** CA1 (0615): reading, asking and closing are each their own same-origin browser command. */
@Injectable() export class CommerceReviewReadHumanUiGuard extends MembershipActivationHumanUiGuard { protected override readonly command: string = 'shopify.commerce.review.read'; }
@Injectable() export class CommerceReviewRequestHumanUiGuard extends MembershipActivationHumanUiGuard { protected override readonly command: string = 'shopify.commerce.review.request'; }
@Injectable() export class CommerceReviewCloseHumanUiGuard extends MembershipActivationHumanUiGuard { protected override readonly command: string = 'shopify.commerce.review.close'; }

/**
 * Commerce reviews from Marcus. Route identifiers are never authority: the scope comes from the verified session (Shopify read
 * at this school), and the database re-proves Shopify management, the Marcus capability and the Complete plan for asking.
 */
@Controller('organizations/:organizationId/schools/:schoolId/shopify/commerce-reviews')
@UseGuards(HonIdentityGuard)
export class CommerceReviewController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly ideas: CommerceReviewService) {}

  @Get() @Header('Cache-Control', 'private, no-store') @Header('Referrer-Policy', 'no-referrer') @UseGuards(CommerceReviewReadHumanUiGuard)
  async list(@Param('organizationId', new ParseUUIDPipe()) o: string, @Param('schoolId', new ParseUUIDPipe()) s: string, @Headers('idempotency-key') k: string | undefined, @Req() r: HonRequest) {
    if (k !== undefined) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
    const context = await this.context(r, o, s, '');
    return { data: { aiAvailable: this.ideas.available(), requests: await this.ideas.list(context) }, meta: this.meta(context) };
  }
  @Post() @HttpCode(HttpStatus.OK) @Header('Cache-Control', 'private, no-store') @Header('Referrer-Policy', 'no-referrer') @UseGuards(CommerceReviewRequestHumanUiGuard)
  async request(@Param('organizationId', new ParseUUIDPipe()) o: string, @Param('schoolId', new ParseUUIDPipe()) s: string, @Headers('idempotency-key') k: string | undefined, @Body() input: unknown, @Req() r: HonRequest) {
    const context = await this.context(r, o, s, this.key(k));
    return { data: await this.ideas.request(context, input), meta: this.meta(context) };
  }
  @Post(':id/close') @HttpCode(HttpStatus.OK) @Header('Cache-Control', 'private, no-store') @Header('Referrer-Policy', 'no-referrer') @UseGuards(CommerceReviewCloseHumanUiGuard)
  async close(@Param('organizationId', new ParseUUIDPipe()) o: string, @Param('schoolId', new ParseUUIDPipe()) s: string, @Param('id', new ParseUUIDPipe()) id: string,
    @Headers('idempotency-key') k: string | undefined, @Body() input: unknown, @Req() r: HonRequest) {
    const status = input && typeof input === 'object' && !Array.isArray(input) && Object.keys(input).join(',') === 'status' ? (input as { status: unknown }).status : null;
    if (status !== 'APPLIED' && status !== 'DISMISSED') throw new BadRequestException({ code: 'SHOPIFY_REVIEW_INVALID' });
    const context = await this.context(r, o, s, this.key(k));
    return { data: await this.ideas.close(context, id, status), meta: this.meta(context) };
  }

  private meta(context: CommerceReviewContext) { return { requestId: context.requestId, correlationId: context.correlationId }; }
  private key(idempotencyKey: string | undefined): string {
    const key = idempotencyKey?.trim();
    if (!key || key.length > 200) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'A unique Idempotency-Key header is required.' });
    return key;
  }
  private async context(request: HonRequest, organizationId: string, schoolId: string, idempotencyKey: string): Promise<CommerceReviewContext> {
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException('HON identity context is missing.');
    if (Object.keys(request.query ?? {}).length) throw new BadRequestException({ code: 'SHOPIFY_REVIEW_INVALID' });
    const scope = await this.database.resolveAuthorizedScope(identity.externalSubject, schoolId, 'commerce.shopify.read');
    if (!scope || scope.organizationId !== organizationId || scope.schoolId !== schoolId) throw new ForbiddenException('Commerce reviews are not authorized for this school.');
    const requestId = randomUUID();
    return { ...scope, principalType: 'HUMAN_USER', requestId, correlationId: requestId, idempotencyKey, source: 'HUMAN_UI', externalSubject: identity.externalSubject };
  }
}
