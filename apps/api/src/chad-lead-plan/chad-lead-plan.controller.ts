import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Header, Headers, HttpCode, HttpStatus, Injectable, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { MembershipActivationHumanUiGuard } from '../billing/membership-activation-human-ui.guard.js';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { ChadLeadPlanService, type ChadLeadPlanContext } from './chad-lead-plan.service.js';

/** P9 (0650): reading, asking, recording a step and dismissing are each their own same-origin browser command. */
@Injectable() export class ChadLeadPlanReadHumanUiGuard extends MembershipActivationHumanUiGuard { protected override readonly command: string = 'chad.lead_plan.read'; }
@Injectable() export class ChadLeadPlanRequestHumanUiGuard extends MembershipActivationHumanUiGuard { protected override readonly command: string = 'chad.lead_plan.request'; }
@Injectable() export class ChadLeadPlanStepHumanUiGuard extends MembershipActivationHumanUiGuard { protected override readonly command: string = 'chad.lead_plan.step'; }
@Injectable() export class ChadLeadPlanCloseHumanUiGuard extends MembershipActivationHumanUiGuard { protected override readonly command: string = 'chad.lead_plan.close'; }

/**
 * Chad lead next steps. Route identifiers are never authority: the scope comes from the verified session (lead read at this
 * school), and the database re-proves Chad's follow-up assistant authority, AI planning and the Complete plan, and that each
 * recorded step was made by the requester's own human command.
 */
@Controller('organizations/:organizationId/schools/:schoolId/chad/lead-plan')
@UseGuards(HonIdentityGuard)
export class ChadLeadPlanController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly chad: ChadLeadPlanService) {}

  @Get() @Header('Cache-Control', 'private, no-store') @Header('Referrer-Policy', 'no-referrer') @UseGuards(ChadLeadPlanReadHumanUiGuard)
  async list(@Param('organizationId', new ParseUUIDPipe()) o: string, @Param('schoolId', new ParseUUIDPipe()) s: string, @Headers('idempotency-key') k: string | undefined, @Req() r: HonRequest) {
    if (k !== undefined) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
    const context = await this.context(r, o, s, '');
    return { data: { aiAvailable: this.chad.available(), leadPlans: await this.chad.list(context) }, meta: this.meta(context) };
  }
  @Post() @HttpCode(HttpStatus.OK) @Header('Cache-Control', 'private, no-store') @Header('Referrer-Policy', 'no-referrer') @UseGuards(ChadLeadPlanRequestHumanUiGuard)
  async request(@Param('organizationId', new ParseUUIDPipe()) o: string, @Param('schoolId', new ParseUUIDPipe()) s: string, @Headers('idempotency-key') k: string | undefined, @Body() input: unknown, @Req() r: HonRequest) {
    const context = await this.context(r, o, s, this.key(k));
    return { data: await this.chad.request(context, input), meta: this.meta(context) };
  }
  @Post(':id/steps/:index') @HttpCode(HttpStatus.OK) @Header('Cache-Control', 'private, no-store') @Header('Referrer-Policy', 'no-referrer') @UseGuards(ChadLeadPlanStepHumanUiGuard)
  async step(@Param('organizationId', new ParseUUIDPipe()) o: string, @Param('schoolId', new ParseUUIDPipe()) s: string, @Param('id', new ParseUUIDPipe()) id: string,
    @Param('index') index: string, @Headers('idempotency-key') k: string | undefined, @Body() input: unknown, @Req() r: HonRequest) {
    if (!/^[0-9]$/.test(index)) throw new BadRequestException({ code: 'CHAD_LEAD_PLAN_INVALID' });
    const context = await this.context(r, o, s, this.key(k));
    return { data: await this.chad.recordStep(context, id, Number(index), input), meta: this.meta(context) };
  }
  @Post(':id/close') @HttpCode(HttpStatus.OK) @Header('Cache-Control', 'private, no-store') @Header('Referrer-Policy', 'no-referrer') @UseGuards(ChadLeadPlanCloseHumanUiGuard)
  async close(@Param('organizationId', new ParseUUIDPipe()) o: string, @Param('schoolId', new ParseUUIDPipe()) s: string, @Param('id', new ParseUUIDPipe()) id: string,
    @Headers('idempotency-key') k: string | undefined, @Body() input: unknown, @Req() r: HonRequest) {
    const ok = input && typeof input === 'object' && !Array.isArray(input) && Object.keys(input).join(',') === 'status' && (input as { status: unknown }).status === 'DISMISSED';
    if (!ok) throw new BadRequestException({ code: 'CHAD_LEAD_PLAN_INVALID' });
    const context = await this.context(r, o, s, this.key(k));
    return { data: await this.chad.dismiss(context, id), meta: this.meta(context) };
  }

  private meta(context: ChadLeadPlanContext) { return { requestId: context.requestId, correlationId: context.correlationId }; }
  private key(idempotencyKey: string | undefined): string {
    const key = idempotencyKey?.trim();
    if (!key || key.length > 160) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'A unique Idempotency-Key header is required.' });
    return key;
  }
  private async context(request: HonRequest, organizationId: string, schoolId: string, idempotencyKey: string): Promise<ChadLeadPlanContext> {
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException('HON identity context is missing.');
    if (Object.keys(request.query ?? {}).length) throw new BadRequestException({ code: 'CHAD_LEAD_PLAN_INVALID' });
    const scope = await this.database.resolveAuthorizedScope(identity.externalSubject, schoolId, 'crm.lead.read');
    if (!scope || scope.organizationId !== organizationId || scope.schoolId !== schoolId) throw new ForbiddenException('Chad lead next steps are not authorized for this school.');
    const requestId = randomUUID();
    return { ...scope, principalType: 'HUMAN_USER', requestId, correlationId: requestId, idempotencyKey, source: 'HUMAN_UI', externalSubject: identity.externalSubject };
  }
}
