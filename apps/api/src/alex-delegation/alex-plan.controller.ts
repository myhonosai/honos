import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Header, Headers, HttpCode, HttpStatus, Injectable, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { MembershipActivationHumanUiGuard } from '../billing/membership-activation-human-ui.guard.js';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { AlexPlanService, type AlexPlanContext } from './alex-plan.service.js';

/** P1 (0639): reading, asking, creating tasks and dismissing are each their own same-origin browser command. */
@Injectable() export class AlexPlanReadHumanUiGuard extends MembershipActivationHumanUiGuard { protected override readonly command: string = 'alex.plan.read'; }
@Injectable() export class AlexPlanRequestHumanUiGuard extends MembershipActivationHumanUiGuard { protected override readonly command: string = 'alex.plan.request'; }
@Injectable() export class AlexPlanCreateHumanUiGuard extends MembershipActivationHumanUiGuard { protected override readonly command: string = 'alex.plan.create'; }
@Injectable() export class AlexPlanCloseHumanUiGuard extends MembershipActivationHumanUiGuard { protected override readonly command: string = 'alex.plan.close'; }

/**
 * Alex delegation plans. Route identifiers are never authority: the scope comes from the verified session (reports at this
 * school), and the database re-proves Alex's capability, task creation, AI planning and the Complete plan for asking, and every
 * work item authority (0084) for creating tasks.
 */
@Controller('organizations/:organizationId/schools/:schoolId/alex/plans')
@UseGuards(HonIdentityGuard)
export class AlexPlanController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly alex: AlexPlanService) {}

  @Get() @Header('Cache-Control', 'private, no-store') @Header('Referrer-Policy', 'no-referrer') @UseGuards(AlexPlanReadHumanUiGuard)
  async list(@Param('organizationId', new ParseUUIDPipe()) o: string, @Param('schoolId', new ParseUUIDPipe()) s: string, @Headers('idempotency-key') k: string | undefined, @Req() r: HonRequest) {
    if (k !== undefined) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
    const context = await this.context(r, o, s, '');
    return { data: { aiAvailable: this.alex.available(), plans: await this.alex.list(context) }, meta: this.meta(context) };
  }
  @Post() @HttpCode(HttpStatus.OK) @Header('Cache-Control', 'private, no-store') @Header('Referrer-Policy', 'no-referrer') @UseGuards(AlexPlanRequestHumanUiGuard)
  async request(@Param('organizationId', new ParseUUIDPipe()) o: string, @Param('schoolId', new ParseUUIDPipe()) s: string, @Headers('idempotency-key') k: string | undefined, @Body() input: unknown, @Req() r: HonRequest) {
    const context = await this.context(r, o, s, this.key(k));
    return { data: await this.alex.request(context, input), meta: this.meta(context) };
  }
  @Post(':id/create') @HttpCode(HttpStatus.OK) @Header('Cache-Control', 'private, no-store') @Header('Referrer-Policy', 'no-referrer') @UseGuards(AlexPlanCreateHumanUiGuard)
  async create(@Param('organizationId', new ParseUUIDPipe()) o: string, @Param('schoolId', new ParseUUIDPipe()) s: string, @Param('id', new ParseUUIDPipe()) id: string,
    @Headers('idempotency-key') k: string | undefined, @Body() input: unknown, @Req() r: HonRequest) {
    const context = await this.context(r, o, s, this.key(k));
    return { data: await this.alex.create(context, id, input), meta: this.meta(context) };
  }
  @Post(':id/close') @HttpCode(HttpStatus.OK) @Header('Cache-Control', 'private, no-store') @Header('Referrer-Policy', 'no-referrer') @UseGuards(AlexPlanCloseHumanUiGuard)
  async close(@Param('organizationId', new ParseUUIDPipe()) o: string, @Param('schoolId', new ParseUUIDPipe()) s: string, @Param('id', new ParseUUIDPipe()) id: string,
    @Headers('idempotency-key') k: string | undefined, @Body() input: unknown, @Req() r: HonRequest) {
    const ok = input && typeof input === 'object' && !Array.isArray(input) && Object.keys(input).join(',') === 'status' && (input as { status: unknown }).status === 'DISMISSED';
    if (!ok) throw new BadRequestException({ code: 'ALEX_PLAN_INVALID' });
    const context = await this.context(r, o, s, this.key(k));
    return { data: await this.alex.dismiss(context, id), meta: this.meta(context) };
  }

  private meta(context: AlexPlanContext) { return { requestId: context.requestId, correlationId: context.correlationId }; }
  private key(idempotencyKey: string | undefined): string {
    const key = idempotencyKey?.trim();
    if (!key || key.length > 160) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'A unique Idempotency-Key header is required.' });
    return key;
  }
  private async context(request: HonRequest, organizationId: string, schoolId: string, idempotencyKey: string): Promise<AlexPlanContext> {
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException('HON identity context is missing.');
    if (Object.keys(request.query ?? {}).length) throw new BadRequestException({ code: 'ALEX_PLAN_INVALID' });
    const scope = await this.database.resolveAuthorizedScope(identity.externalSubject, schoolId, 'reporting.view');
    if (!scope || scope.organizationId !== organizationId || scope.schoolId !== schoolId) throw new ForbiddenException('Alex plans are not authorized for this school.');
    const requestId = randomUUID();
    return { ...scope, principalType: 'HUMAN_USER', requestId, correlationId: requestId, idempotencyKey, source: 'HUMAN_UI', externalSubject: identity.externalSubject };
  }
}
