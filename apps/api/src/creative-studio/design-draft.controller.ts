import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Header, Headers, HttpCode, Injectable, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DESIGN_DRAFT_COMMAND } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { MembershipActivationHumanUiGuard } from '../billing/membership-activation-human-ui.guard.js';
import { DesignDraftService, type DesignDraftContext } from './design-draft.service.js';

/** The design guard rules (same origin, no selectors, no other X-Hon header) with this feature's own command. */
@Injectable() export class DesignDraftHumanUiGuard extends MembershipActivationHumanUiGuard { protected override readonly command: string = DESIGN_DRAFT_COMMAND; }

/**
 * Design AI drafts (0705, E4a), under Creative Studio. The school in the path is never authority: the scope comes from the
 * verified session (creative.design.manage at this school), and the database re-proves design access, the Marcus capability
 * and the Complete plan.
 */
@Controller('organizations/:organizationId/schools/:schoolId/creative-studio/design-drafts')
@UseGuards(HonIdentityGuard, DesignDraftHumanUiGuard)
export class DesignDraftController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly drafts: DesignDraftService) {}

  @Get() @Header('Cache-Control', 'private, no-store') @Header('Referrer-Policy', 'no-referrer')
  async list(@Param('organizationId', new ParseUUIDPipe()) o: string, @Param('schoolId', new ParseUUIDPipe()) s: string, @Headers('idempotency-key') k: string | undefined, @Req() r: HonRequest) {
    if (k !== undefined) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
    const context = await this.context(r, o, s, '');
    return { data: { aiAvailable: this.drafts.available(), price: await this.drafts.price(context), requests: await this.drafts.list(context) }, meta: this.meta(context) };
  }
  @Post() @HttpCode(200) @Header('Cache-Control', 'private, no-store') @Header('Referrer-Policy', 'no-referrer')
  async request(@Param('organizationId', new ParseUUIDPipe()) o: string, @Param('schoolId', new ParseUUIDPipe()) s: string, @Headers('idempotency-key') k: string | undefined, @Body() input: unknown, @Req() r: HonRequest) {
    const context = await this.context(r, o, s, this.key(k));
    return { data: await this.drafts.request(context, input), meta: this.meta(context) };
  }
  @Post(':id/close') @HttpCode(200) @Header('Cache-Control', 'private, no-store') @Header('Referrer-Policy', 'no-referrer')
  async close(@Param('organizationId', new ParseUUIDPipe()) o: string, @Param('schoolId', new ParseUUIDPipe()) s: string, @Param('id', new ParseUUIDPipe()) id: string,
    @Headers('idempotency-key') k: string | undefined, @Body() input: unknown, @Req() r: HonRequest) {
    const status = input && typeof input === 'object' && !Array.isArray(input) && Object.keys(input).join(',') === 'status' ? (input as { status: unknown }).status : null;
    if (status !== 'APPLIED' && status !== 'DISMISSED') throw new BadRequestException({ code: 'DESIGN_DRAFT_INVALID' });
    const context = await this.context(r, o, s, this.key(k));
    return { data: await this.drafts.close(context, id.toLowerCase(), status), meta: this.meta(context) };
  }

  private meta(context: DesignDraftContext) { return { requestId: context.requestId, correlationId: context.correlationId }; }
  private key(idempotencyKey: string | undefined): string {
    const key = idempotencyKey?.trim();
    if (!key || key.length > 200) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'A unique Idempotency-Key header is required.' });
    return key;
  }
  private async context(request: HonRequest, organizationId: string, schoolId: string, idempotencyKey: string): Promise<DesignDraftContext> {
    if (!request.honIdentity) throw new ForbiddenException({ code: 'IDENTITY_REQUIRED' });
    const scope = await this.database.resolveAuthorizedScope(request.honIdentity.externalSubject, schoolId, 'creative.design.manage');
    if (!scope || scope.organizationId.toLowerCase() !== organizationId.toLowerCase() || scope.schoolId.toLowerCase() !== schoolId.toLowerCase()) {
      throw new ForbiddenException({ code: 'DESIGN_DRAFT_SCOPE_DENIED' });
    }
    const requestId = randomUUID();
    return { ...scope, principalType: 'HUMAN_USER', requestId, correlationId: requestId, idempotencyKey, source: 'HUMAN_UI', externalSubject: request.honIdentity.externalSubject };
  }
}
