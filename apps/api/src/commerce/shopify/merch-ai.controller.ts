import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Header, Headers, HttpCode, HttpStatus, Injectable, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { MembershipActivationHumanUiGuard } from '../../billing/membership-activation-human-ui.guard.js';
import { HonIdentityGuard } from '../../foundation/hon-identity.guard.js';
import type { HonRequest } from '../../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../../foundation/runtime-database.service.js';
import { MerchAiService, type MerchAiContext } from './merch-ai.service.js';

/** CS-M2 (0535): reading, asking, using and dismissing are each their own same-origin browser command. */
@Injectable() export class MerchAiReadHumanUiGuard extends MembershipActivationHumanUiGuard { protected override readonly command: string = 'shopify.merch.ai.read'; }
@Injectable() export class MerchAiRequestHumanUiGuard extends MembershipActivationHumanUiGuard { protected override readonly command: string = 'shopify.merch.ai.request'; }
@Injectable() export class MerchAiCloseHumanUiGuard extends MembershipActivationHumanUiGuard { protected override readonly command: string = 'shopify.merch.ai.close'; }

/**
 * Merch ideas from Marcus. Route identifiers are never authority: the scope comes from the verified session (Shopify read
 * at this school), and the database re-proves Shopify management, the Marcus capability and the Complete plan for asking.
 */
@Controller('organizations/:organizationId/schools/:schoolId/shopify/merch-ideas')
@UseGuards(HonIdentityGuard)
export class MerchAiController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly ideas: MerchAiService) {}

  @Get() @Header('Cache-Control', 'private, no-store') @Header('Referrer-Policy', 'no-referrer') @UseGuards(MerchAiReadHumanUiGuard)
  async list(@Param('organizationId', new ParseUUIDPipe()) o: string, @Param('schoolId', new ParseUUIDPipe()) s: string, @Headers('idempotency-key') k: string | undefined, @Req() r: HonRequest) {
    if (k !== undefined) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
    const context = await this.context(r, o, s, '');
    return { data: { aiAvailable: this.ideas.available(), requests: await this.ideas.list(context) }, meta: this.meta(context) };
  }
  @Post() @HttpCode(HttpStatus.OK) @Header('Cache-Control', 'private, no-store') @Header('Referrer-Policy', 'no-referrer') @UseGuards(MerchAiRequestHumanUiGuard)
  async request(@Param('organizationId', new ParseUUIDPipe()) o: string, @Param('schoolId', new ParseUUIDPipe()) s: string, @Headers('idempotency-key') k: string | undefined, @Body() input: unknown, @Req() r: HonRequest) {
    const context = await this.context(r, o, s, this.key(k));
    return { data: await this.ideas.request(context, input), meta: this.meta(context) };
  }
  @Post(':id/close') @HttpCode(HttpStatus.OK) @Header('Cache-Control', 'private, no-store') @Header('Referrer-Policy', 'no-referrer') @UseGuards(MerchAiCloseHumanUiGuard)
  async close(@Param('organizationId', new ParseUUIDPipe()) o: string, @Param('schoolId', new ParseUUIDPipe()) s: string, @Param('id', new ParseUUIDPipe()) id: string,
    @Headers('idempotency-key') k: string | undefined, @Body() input: unknown, @Req() r: HonRequest) {
    const status = input && typeof input === 'object' && !Array.isArray(input) && Object.keys(input).join(',') === 'status' ? (input as { status: unknown }).status : null;
    if (status !== 'APPLIED' && status !== 'DISMISSED') throw new BadRequestException({ code: 'SHOPIFY_MERCH_AI_INVALID' });
    const context = await this.context(r, o, s, this.key(k));
    return { data: await this.ideas.close(context, id, status), meta: this.meta(context) };
  }

  private meta(context: MerchAiContext) { return { requestId: context.requestId, correlationId: context.correlationId }; }
  private key(idempotencyKey: string | undefined): string {
    const key = idempotencyKey?.trim();
    if (!key || key.length > 200) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'A unique Idempotency-Key header is required.' });
    return key;
  }
  private async context(request: HonRequest, organizationId: string, schoolId: string, idempotencyKey: string): Promise<MerchAiContext> {
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException('HON identity context is missing.');
    if (Object.keys(request.query ?? {}).length) throw new BadRequestException({ code: 'SHOPIFY_MERCH_AI_INVALID' });
    const scope = await this.database.resolveAuthorizedScope(identity.externalSubject, schoolId, 'commerce.shopify.read');
    if (!scope || scope.organizationId !== organizationId || scope.schoolId !== schoolId) throw new ForbiddenException('Merch ideas are not authorized for this school.');
    const requestId = randomUUID();
    return { ...scope, principalType: 'HUMAN_USER', requestId, correlationId: requestId, idempotencyKey, source: 'HUMAN_UI', externalSubject: identity.externalSubject };
  }
}
