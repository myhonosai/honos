import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Header, Headers, HttpCode, Injectable, NotFoundException, Param,
  ParseUUIDPipe, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import {
  MEMBERSHIP_AGREEMENT_CARD_READ_COMMAND, MEMBERSHIP_AGREEMENT_SEND_COMMAND, MEMBERSHIP_AGREEMENT_TEMPLATE_READ_COMMAND, MEMBERSHIP_AGREEMENT_TEMPLATE_SAVE_COMMAND,
} from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { MembershipActivationHumanUiGuard } from './membership-activation-human-ui.guard.js';
import { MembershipAgreementService } from './membership-agreement.service.js';
import type { MembershipLifecycleContext } from './membership.service.js';

/** M-E (0410): each call is its own browser command, so none replays as another. */
@Injectable() export class MembershipAgreementTemplateReadGuard extends MembershipActivationHumanUiGuard { protected override readonly command: string = MEMBERSHIP_AGREEMENT_TEMPLATE_READ_COMMAND; }
@Injectable() export class MembershipAgreementTemplateSaveGuard extends MembershipActivationHumanUiGuard { protected override readonly command: string = MEMBERSHIP_AGREEMENT_TEMPLATE_SAVE_COMMAND; }
@Injectable() export class MembershipAgreementCardReadGuard extends MembershipActivationHumanUiGuard { protected override readonly command: string = MEMBERSHIP_AGREEMENT_CARD_READ_COMMAND; }
@Injectable() export class MembershipAgreementSendGuard extends MembershipActivationHumanUiGuard { protected override readonly command: string = MEMBERSHIP_AGREEMENT_SEND_COMMAND; }

function idempotencyKey(key: string | undefined): string {
  if (typeof key !== 'string' || !key || key.trim() !== key || key.length > 200 || /[\u0000-\u001f\u007f]/.test(key)) {
    throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'A unique Idempotency-Key header is required.' });
  }
  return key;
}
const noQuery = (query: Record<string, unknown>) => { if (Object.keys(query ?? {}).length) throw new BadRequestException({ code: 'VALIDATION_FAILED' }); };

/**
 * M-E (0410): the school's membership agreement (Membership page) and the agreement for one membership (contact card). Route
 * identifiers are never authority: the scope is resolved from the verified session for the permission each call needs, and
 * the database re-proves it live.
 */
@Controller('organizations/:organizationId/schools/:schoolId/billing')
@UseGuards(HonIdentityGuard)
export class MembershipAgreementController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly agreements: MembershipAgreementService) {}

  @Get('membership-agreement') @UseGuards(MembershipAgreementTemplateReadGuard) @Header('Cache-Control', 'private, no-store')
  async template(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Headers('idempotency-key') key: string | undefined, @Query() query: Record<string, unknown>, @Req() request: HonRequest) {
    if (key !== undefined) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
    noQuery(query);
    const context = await this.context(request, organizationId, schoolId, '', 'billing.membership.read');
    return { data: await this.agreements.template(context), meta: { requestId: context.requestId } };
  }

  @Post('membership-agreement') @HttpCode(201) @UseGuards(MembershipAgreementTemplateSaveGuard) @Header('Cache-Control', 'private, no-store')
  async save(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Headers('idempotency-key') key: string | undefined, @Query() query: Record<string, unknown>, @Body() body: unknown, @Req() request: HonRequest,
    @Res({ passthrough: true }) response: Response) {
    noQuery(query);
    const context = await this.context(request, organizationId, schoolId, idempotencyKey(key), 'billing.membership_agreement.manage');
    const result = await this.agreements.save(context, body);
    response.status(result.replayed ? 200 : 201);
    return { data: result.agreement, meta: { requestId: context.requestId, replayed: result.replayed } };
  }

  @Get('memberships/:membershipId/agreement') @UseGuards(MembershipAgreementCardReadGuard) @Header('Cache-Control', 'private, no-store')
  async card(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('membershipId', new ParseUUIDPipe()) membershipId: string, @Headers('idempotency-key') key: string | undefined, @Query() query: Record<string, unknown>,
    @Req() request: HonRequest) {
    if (key !== undefined) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
    noQuery(query);
    const context = await this.context(request, organizationId, schoolId, '', 'billing.membership.read');
    return { data: await this.agreements.card(context, membershipId.toLowerCase()), meta: { requestId: context.requestId } };
  }

  @Post('memberships/:membershipId/agreement/send') @HttpCode(201) @UseGuards(MembershipAgreementSendGuard) @Header('Cache-Control', 'private, no-store')
  async send(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('membershipId', new ParseUUIDPipe()) membershipId: string, @Headers('idempotency-key') key: string | undefined, @Query() query: Record<string, unknown>,
    @Body() body: unknown, @Req() request: HonRequest, @Res({ passthrough: true }) response: Response) {
    noQuery(query);
    const context = await this.context(request, organizationId, schoolId, idempotencyKey(key), 'billing.membership.create');
    const result = await this.agreements.send(context, membershipId.toLowerCase(), body);
    response.status(result.replayed ? 200 : 201);
    return { data: result.request, meta: { requestId: context.requestId, replayed: result.replayed } };
  }

  private async context(request: HonRequest, organizationId: string, schoolId: string, idempotencyKey: string, permission: string): Promise<MembershipLifecycleContext> {
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException('HON identity context is missing.');
    const scope = await this.database.resolveAuthorizedScope(identity.externalSubject, schoolId, permission);
    if (!scope || scope.organizationId.toLowerCase() !== organizationId.toLowerCase() || scope.schoolId.toLowerCase() !== schoolId.toLowerCase()) {
      throw new ForbiddenException({ code: 'MEMBERSHIP_AGREEMENT_FORBIDDEN' });
    }
    const requestId = randomUUID();
    return { ...scope, principalType: 'HUMAN_USER', requestId, correlationId: requestId, idempotencyKey, source: 'HUMAN_UI', externalSubject: identity.externalSubject };
  }
}

/** M-E (0410): the family's signing link. No account: the random token in the link is the only key, and it signs once. */
@Controller('public/agreements')
export class PublicMembershipAgreementController {
  constructor(private readonly agreements: MembershipAgreementService) {}

  @Get(':token') @Header('Cache-Control', 'no-store') @Header('Referrer-Policy', 'no-referrer') @Header('X-Robots-Tag', 'noindex')
  async link(@Param('token') token: string) {
    const data = await this.agreements.link(token);
    if (!data) throw new NotFoundException({ result: 'gone' });
    return { data };
  }

  @Post(':token/signature') @Header('Cache-Control', 'no-store') @Header('Referrer-Policy', 'no-referrer')
  async sign(@Param('token') token: string, @Body() body: unknown, @Res() response: Response) {
    const result = await this.agreements.sign(token, body);
    return response.status(result === 'signed' ? 201 : result === 'invalid' ? 400 : result === 'gone' ? 410 : 503).json({ result });
  }
}
