import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Header, Headers, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { HonIdentityGuard } from '../../foundation/hon-identity.guard.js';
import type { HonRequest } from '../../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../../foundation/runtime-database.service.js';
import {
  SchoolSocialPostApproveHumanUiGuard, SchoolSocialPostCancelHumanUiGuard, SchoolSocialPostCreateHumanUiGuard, SchoolSocialPostEditHumanUiGuard,
  SchoolSocialPostResolveHumanUiGuard, SchoolSocialReadHumanUiGuard,
} from './school-social.guard.js';
import { SchoolSocialPostsService } from './school-social-posts.service.js';
import type { SchoolSocialContext } from './school-social.service.js';

const READ = 'marketing.social.read', POST = 'marketing.social.post', MANAGE = 'marketing.social.manage';

/**
 * School posts (0348). Route ids are never authority: scope comes from the verified session and every database call
 * re-proves the person. Cancelling needs marketing.social.post for a draft and marketing.social.manage for an approved
 * post, which the database decides; the route only requires a person who can see the school's social work.
 */
@Controller('organizations/:organizationId/schools/:schoolId/marketing/social')
@UseGuards(HonIdentityGuard)
export class SchoolSocialPostsController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly posts: SchoolSocialPostsService) {}

  @Get('posts')
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @UseGuards(SchoolSocialReadHumanUiGuard)
  async list(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Query() query: Record<string, unknown>, @Headers('idempotency-key') idempotencyKey: string | undefined, @Req() request: HonRequest) {
    if (idempotencyKey !== undefined) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
    const context = await this.context(request, organizationId, schoolId, '', READ);
    return { data: await this.posts.list(context, { ...query }), meta: { requestId: context.requestId, correlationId: context.correlationId } };
  }

  @Post('posts')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @UseGuards(SchoolSocialPostCreateHumanUiGuard)
  async create(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined, @Body() input: unknown, @Req() request: HonRequest) {
    return this.mutate(request, organizationId, schoolId, idempotencyKey, POST, 'create', null, input);
  }

  @Post('posts/:postId')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @UseGuards(SchoolSocialPostEditHumanUiGuard)
  async edit(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('postId', new ParseUUIDPipe()) postId: string, @Headers('idempotency-key') idempotencyKey: string | undefined, @Body() input: unknown, @Req() request: HonRequest) {
    return this.mutate(request, organizationId, schoolId, idempotencyKey, POST, 'edit', postId, input);
  }

  @Post('posts/:postId/approve')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @UseGuards(SchoolSocialPostApproveHumanUiGuard)
  async approve(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('postId', new ParseUUIDPipe()) postId: string, @Headers('idempotency-key') idempotencyKey: string | undefined, @Body() input: unknown, @Req() request: HonRequest) {
    return this.mutate(request, organizationId, schoolId, idempotencyKey, MANAGE, 'approve', postId, input);
  }

  @Post('posts/:postId/cancel')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @UseGuards(SchoolSocialPostCancelHumanUiGuard)
  async cancel(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('postId', new ParseUUIDPipe()) postId: string, @Headers('idempotency-key') idempotencyKey: string | undefined, @Body() input: unknown, @Req() request: HonRequest) {
    return this.mutate(request, organizationId, schoolId, idempotencyKey, READ, 'cancel', postId, input);
  }

  @Post('post-targets/:targetId/resolve')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @UseGuards(SchoolSocialPostResolveHumanUiGuard)
  async resolve(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('targetId', new ParseUUIDPipe()) targetId: string, @Headers('idempotency-key') idempotencyKey: string | undefined, @Body() input: unknown, @Req() request: HonRequest) {
    return this.mutate(request, organizationId, schoolId, idempotencyKey, MANAGE, 'resolve', targetId, input);
  }

  private async mutate(request: HonRequest, organizationId: string, schoolId: string, idempotencyKey: string | undefined, permission: string,
    action: 'create' | 'edit' | 'approve' | 'cancel' | 'resolve', id: string | null, input: unknown) {
    if (Object.keys(request.query ?? {}).length) throw new BadRequestException({ code: 'SOCIAL_INVALID' });
    const context = await this.context(request, organizationId, schoolId, this.key(idempotencyKey), permission);
    const { post, replayed } = await this.posts.mutate(context, action, id, input);
    return { data: post, meta: { requestId: context.requestId, correlationId: context.correlationId, replayed } };
  }

  private key(idempotencyKey: string | undefined): string {
    if (!idempotencyKey || idempotencyKey.length > 200 || idempotencyKey.trim() !== idempotencyKey) throw new BadRequestException({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
    return idempotencyKey;
  }

  private async context(request: HonRequest, organizationId: string, schoolId: string, idempotencyKey: string, permission: string): Promise<SchoolSocialContext> {
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException('HON identity context is missing.');
    const scope = await this.database.resolveAuthorizedScope(identity.externalSubject, schoolId, permission);
    if (!scope || scope.organizationId !== organizationId || scope.schoolId !== schoolId) throw new ForbiddenException({ code: 'SOCIAL_FORBIDDEN' });
    const requestId = randomUUID();
    return { ...scope, principalType: 'HUMAN_USER', requestId, correlationId: requestId, idempotencyKey, source: 'HUMAN_UI', externalSubject: identity.externalSubject };
  }
}
