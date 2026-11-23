import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Header, Headers, HttpCode, Injectable, Param, ParseUUIDPipe, Post, Query, Req,
  Res, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import { PERSON_MEMBERSHIP_START_COMMAND, PERSON_MEMBERSHIP_START_READ_COMMAND } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { MembershipActivationHumanUiGuard } from './membership-activation-human-ui.guard.js';
import type { MembershipLifecycleContext } from './membership.service.js';
import { PersonMembershipStartService } from './person-membership-start.service.js';

/** M-B (0624): the read and the start are separate browser commands, so neither replays as the other. */
@Injectable()
export class PersonMembershipStartReadGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = PERSON_MEMBERSHIP_START_READ_COMMAND;
}
@Injectable()
export class PersonMembershipStartGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = PERSON_MEMBERSHIP_START_COMMAND;
}

function idempotencyKey(key: string | undefined): string {
  if (typeof key !== 'string' || !key || key.trim() !== key || key.length > 200 || /[\u0000-\u001f\u007f]/.test(key)) {
    throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'A unique Idempotency-Key header is required.' });
  }
  return key;
}

/**
 * M-B (0624): New membership and Renew on a student's contact card. Route identifiers are never authority: the scope is
 * resolved from the verified session for billing.membership.create, and the database re-proves it live.
 */
@Controller('organizations/:organizationId/schools/:schoolId/billing/people/:personId')
@UseGuards(HonIdentityGuard)
export class PersonMembershipStartController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly starts: PersonMembershipStartService) {}

  /** Who may pay, the student's memberships (with renewals offered) and what blocks a start. */
  @Get('membership-start')
  @UseGuards(PersonMembershipStartReadGuard)
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  async options(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('personId', new ParseUUIDPipe()) personId: string, @Headers('idempotency-key') key: string | undefined, @Query() query: Record<string, unknown>,
    @Req() request: HonRequest) {
    if (key !== undefined) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
    if (Object.keys(query ?? {}).length) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    const context = await this.context(request, organizationId, schoolId, '');
    return { data: await this.starts.options(context, personId.toLowerCase()), meta: { requestId: context.requestId } };
  }

  /** One DRAFT from the exact plan version shown; staff then start it with the activation preview and confirm. */
  @Post('memberships/from-plan')
  @HttpCode(201)
  @UseGuards(PersonMembershipStartGuard)
  @Header('Cache-Control', 'private, no-store')
  async start(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('personId', new ParseUUIDPipe()) personId: string, @Headers('idempotency-key') key: string | undefined, @Query() query: Record<string, unknown>,
    @Body() body: unknown, @Req() request: HonRequest, @Res({ passthrough: true }) response: Response) {
    if (Object.keys(query ?? {}).length) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    const context = await this.context(request, organizationId, schoolId, idempotencyKey(key));
    const result = await this.starts.start(context, personId.toLowerCase(), body);
    response.status(result.replayed ? 200 : 201);
    return { data: result.receipt, meta: { requestId: context.requestId, replayed: result.replayed } };
  }

  private async context(request: HonRequest, organizationId: string, schoolId: string, idempotencyKey: string): Promise<MembershipLifecycleContext> {
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException('HON identity context is missing.');
    const scope = await this.database.resolveAuthorizedScope(identity.externalSubject, schoolId, 'billing.membership.create');
    if (!scope || scope.organizationId.toLowerCase() !== organizationId.toLowerCase() || scope.schoolId.toLowerCase() !== schoolId.toLowerCase()) {
      throw new ForbiddenException({ code: 'PERSON_MEMBERSHIP_FORBIDDEN' });
    }
    const requestId = randomUUID();
    return { ...scope, principalType: 'HUMAN_USER', requestId, correlationId: requestId, idempotencyKey, source: 'HUMAN_UI', externalSubject: identity.externalSubject };
  }
}
