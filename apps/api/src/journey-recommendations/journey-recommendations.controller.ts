import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Header, Headers, HttpCode, Injectable, Param, ParseUUIDPipe, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { randomUUID } from 'node:crypto';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import type { MembershipLifecycleContext } from '../billing/membership.service.js';
import { MembershipActivationHumanUiGuard } from '../billing/membership-activation-human-ui.guard.js';
import { JourneyRecommendationsService } from './journey-recommendations.service.js';

const MANAGE = 'curriculum.manage';

/** 0603: each journey recommendation call is its own human command; reads are GET only. */
@Injectable()
export class ParentJourneyRecommendationsReadGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'parent.journey_recommendations.read';
}
@Injectable()
export class ParentJourneyRecommendationsRespondGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'parent.journey_recommendations.respond';
}
@Injectable()
export class JourneyRecommendationsReadGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'journey_recommendations.read';
}
@Injectable()
export class JourneyRecommendationsSaveGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'journey_recommendations.save';
}
@Injectable()
export class JourneyRecommendationsStatusGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'journey_recommendations.status';
}

function noSelectors(request: HonRequest, query: Record<string, unknown>): void {
  if (Object.keys(query ?? {}).length || request.originalUrl?.includes('?')) throw new BadRequestException({ code: 'JOURNEY_RECOMMENDATIONS_SELECTORS_NOT_ACCEPTED' });
  if (!request.honIdentity) throw new ForbiddenException({ code: 'IDENTITY_REQUIRED' });
}

/** Parent side: the journey recommendations each child of the signed-in family has reached (journey in the HON Family app). */
@Controller('parent/journey-recommendations')
@UseGuards(HonIdentityGuard)
export class ParentJourneyRecommendationsController {
  constructor(private readonly recommendations: JourneyRecommendationsService) {}

  @Get()
  @UseGuards(ParentJourneyRecommendationsReadGuard)
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  async read(@Query() query: Record<string, unknown>, @Req() request: HonRequest) {
    noSelectors(request, query);
    return { data: await this.recommendations.parentRead(request.honIdentity!.externalSubject) };
  }

  /** 0608: "Not now" (HIDDEN) or "See how to join" (INTERESTED) for one recommendation the family sees now. */
  @Post(':recommendationId/response')
  @HttpCode(200)
  @UseGuards(ParentJourneyRecommendationsRespondGuard)
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  async respond(@Param('recommendationId') recommendationId: string, @Query() query: Record<string, unknown>, @Body() body: unknown, @Req() request: HonRequest) {
    noSelectors(request, query);
    return { data: await this.recommendations.parentRespond(request.honIdentity!.externalSubject, recommendationId, body) };
  }
}

/**
 * Staff side: add, edit, turn on or off and remove journey recommendations. Route identifiers are never authority: the guarded boundary resolves the
 * scope from the verified session with curriculum.manage, and every database call re-proves it.
 */
@Controller('organizations/:organizationId/schools/:schoolId/journey-recommendations')
@UseGuards(HonIdentityGuard)
export class JourneyRecommendationsController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly recommendations: JourneyRecommendationsService) {}

  @Get()
  @UseGuards(JourneyRecommendationsReadGuard)
  @Header('Cache-Control', 'private, no-store')
  async list(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Query() query: Record<string, unknown>, @Headers('idempotency-key') key: string | undefined, @Req() request: HonRequest) {
    noSelectors(request, query);
    if (key !== undefined) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
    const context = await this.context(request, organizationId, schoolId, '');
    return { data: await this.recommendations.list(context), meta: { requestId: context.requestId } };
  }

  /** 0608: families who tapped "See how to join", newest first. */
  @Get('interest')
  @UseGuards(JourneyRecommendationsReadGuard)
  @Header('Cache-Control', 'private, no-store')
  async interest(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Query() query: Record<string, unknown>, @Headers('idempotency-key') key: string | undefined, @Req() request: HonRequest) {
    noSelectors(request, query);
    if (key !== undefined) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
    const context = await this.context(request, organizationId, schoolId, '');
    return { data: await this.recommendations.interest(context), meta: { requestId: context.requestId } };
  }

  @Post()
  @HttpCode(201)
  @UseGuards(JourneyRecommendationsSaveGuard)
  @Header('Cache-Control', 'private, no-store')
  async save(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Query() query: Record<string, unknown>, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined, @Req() request: HonRequest,
    @Res({ passthrough: true }) response: Response) {
    noSelectors(request, query);
    const context = await this.context(request, organizationId, schoolId, this.key(key));
    const result = await this.recommendations.save(context, body);
    // A new recommendation is 201; an edit, or any exact replay, is 200.
    response.status(!result.replayed && (body as { recommendationId?: unknown } | null)?.recommendationId === null ? 201 : 200);
    return { data: result.receipt, meta: { requestId: context.requestId, replayed: result.replayed } };
  }

  @Post(':recommendationId/status')
  @HttpCode(200)
  @UseGuards(JourneyRecommendationsStatusGuard)
  @Header('Cache-Control', 'private, no-store')
  async setStatus(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('recommendationId') recommendationId: string, @Query() query: Record<string, unknown>, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined,
    @Req() request: HonRequest) {
    noSelectors(request, query);
    const context = await this.context(request, organizationId, schoolId, this.key(key));
    const result = await this.recommendations.setStatus(context, recommendationId, body);
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
      throw new ForbiddenException({ code: 'JOURNEY_RECOMMENDATIONS_FORBIDDEN' });
    }
    const requestId = randomUUID();
    return { ...scope, principalType: 'HUMAN_USER', requestId, correlationId: requestId, idempotencyKey, source: 'HUMAN_UI', externalSubject: identity.externalSubject };
  }
}
