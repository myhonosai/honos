import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Header, Headers, HttpCode, Injectable, Param, ParseUUIDPipe, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { randomUUID } from 'node:crypto';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import type { MembershipLifecycleContext } from '../billing/membership.service.js';
import { MembershipActivationHumanUiGuard } from '../billing/membership-activation-human-ui.guard.js';
import { SchoolAnnouncementsService } from './school-announcements.service.js';

const MANAGE = 'family_messages.manage';

/** 0576: each announcement call is its own human command; reads are GET only. */
@Injectable()
export class ParentSchoolAnnouncementsReadGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'parent.announcements.read';
}
@Injectable()
export class SchoolAnnouncementsReadGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'school_announcements.read';
}
@Injectable()
export class SchoolAnnouncementsPublishGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'school_announcements.publish';
}
@Injectable()
export class SchoolAnnouncementsWithdrawGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'school_announcements.withdraw';
}

function noSelectors(request: HonRequest, query: Record<string, unknown>): void {
  if (Object.keys(query ?? {}).length || request.originalUrl?.includes('?')) throw new BadRequestException({ code: 'SCHOOL_ANNOUNCEMENTS_SELECTORS_NOT_ACCEPTED' });
  if (!request.honIdentity) throw new ForbiddenException({ code: 'IDENTITY_REQUIRED' });
}

/** Parent side: the school's live announcements for the signed-in family (Home screen of the HON Family app). */
@Controller('parent/announcements')
@UseGuards(HonIdentityGuard)
export class ParentSchoolAnnouncementsController {
  constructor(private readonly announcements: SchoolAnnouncementsService) {}

  @Get()
  @UseGuards(ParentSchoolAnnouncementsReadGuard)
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  async read(@Query() query: Record<string, unknown>, @Req() request: HonRequest) {
    noSelectors(request, query);
    return { data: await this.announcements.parentRead(request.honIdentity!.externalSubject) };
  }
}

/**
 * Staff side: post and take down announcements. Route identifiers are never authority: the guarded boundary resolves the
 * scope from the verified session with family_messages.manage, and every database call re-proves it.
 */
@Controller('organizations/:organizationId/schools/:schoolId/announcements')
@UseGuards(HonIdentityGuard)
export class SchoolAnnouncementsController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly announcements: SchoolAnnouncementsService) {}

  @Get()
  @UseGuards(SchoolAnnouncementsReadGuard)
  @Header('Cache-Control', 'private, no-store')
  async list(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Query() query: Record<string, unknown>, @Headers('idempotency-key') key: string | undefined, @Req() request: HonRequest) {
    noSelectors(request, query);
    if (key !== undefined) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
    const context = await this.context(request, organizationId, schoolId, '');
    return { data: await this.announcements.list(context), meta: { requestId: context.requestId } };
  }

  @Post()
  @HttpCode(201)
  @UseGuards(SchoolAnnouncementsPublishGuard)
  @Header('Cache-Control', 'private, no-store')
  async publish(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Query() query: Record<string, unknown>, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined, @Req() request: HonRequest,
    @Res({ passthrough: true }) response: Response) {
    noSelectors(request, query);
    const context = await this.context(request, organizationId, schoolId, this.key(key));
    const result = await this.announcements.publish(context, body);
    response.status(result.replayed ? 200 : 201);
    return { data: result.receipt, meta: { requestId: context.requestId, replayed: result.replayed } };
  }

  @Post(':announcementId/withdraw')
  @HttpCode(200)
  @UseGuards(SchoolAnnouncementsWithdrawGuard)
  @Header('Cache-Control', 'private, no-store')
  async withdraw(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('announcementId') announcementId: string, @Query() query: Record<string, unknown>, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined,
    @Req() request: HonRequest) {
    noSelectors(request, query);
    const context = await this.context(request, organizationId, schoolId, this.key(key));
    const result = await this.announcements.withdraw(context, announcementId, body);
    return { data: result.receipt, meta: { requestId: context.requestId, replayed: result.replayed } };
  }

  private key(key: string | undefined): string {
    if (typeof key !== 'string' || !key || key.trim() !== key || key.length > 200) {
      throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'A unique Idempotency-Key header is required.' });
    }
    return key;
  }

  private async context(request: HonRequest, organizationId: string, schoolId: string, idempotencyKey: string): Promise<MembershipLifecycleContext> {
    const identity = request.honIdentity!;
    const scope = await this.database.resolveAuthorizedScope(identity.externalSubject, schoolId, MANAGE);
    if (!scope || scope.organizationId.toLowerCase() !== organizationId.toLowerCase() || scope.schoolId.toLowerCase() !== schoolId.toLowerCase()) {
      throw new ForbiddenException({ code: 'SCHOOL_ANNOUNCEMENTS_FORBIDDEN' });
    }
    const requestId = randomUUID();
    return { ...scope, principalType: 'HUMAN_USER', requestId, correlationId: requestId, idempotencyKey, source: 'HUMAN_UI', externalSubject: identity.externalSubject };
  }
}
