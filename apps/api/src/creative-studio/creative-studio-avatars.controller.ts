import { Body, Controller, ForbiddenException, Get, Headers, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { SAAS_COMMANDS } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { SaasCommandGuard, SaasCommandName, SaasReadGuard } from '../saas-billing/saas-billing.guards.js';
import { CreativeStudioService } from './creative-studio.service.js';

function subject(req: HonRequest): string {
  if (!req.honIdentity) throw new ForbiddenException({ code: 'SAAS_FORBIDDEN' });
  return req.honIdentity.externalSubject;
}

/**
 * A1 Creative Studio avatars for staff of one school (the CS1 school actor at that exact school, enforced in the database;
 * the path is only a selector). An avatar is one generation priced by the HQ rate avatar.create and paid from that school's
 * creative wallet. There is no route that edits an avatar, chooses a provider, model or price, or settles credits directly.
 */
@Controller('schools/:schoolId/creative-studio/avatars')
@UseGuards(HonIdentityGuard)
export class CreativeStudioAvatarsController {
  constructor(private readonly studio: CreativeStudioService) {}
  @Get() @UseGuards(SaasReadGuard)
  async list(@Req() req: HonRequest, @Param('schoolId') schoolId: string) {
    return { data: await this.studio.listAvatars(subject(req), schoolId) };
  }
  @Get(':avatarId') @UseGuards(SaasReadGuard)
  async read(@Req() req: HonRequest, @Param('schoolId') schoolId: string, @Param('avatarId') avatarId: string) {
    return { data: await this.studio.readAvatar(subject(req), schoolId, avatarId) };
  }
  @Post() @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.createCreativeAvatar)
  async create(@Req() req: HonRequest, @Param('schoolId') schoolId: string, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    return { data: await this.studio.createAvatar(subject(req), schoolId, body, key) };
  }
}

/**
 * A2 Creative Studio avatar videos (0277): one of the school's READY avatars speaks a script, as one generation priced by
 * the HQ rate avatar.video (per second) and paid from that school's creative wallet. Same exact-school rules as avatars.
 */
@Controller('schools/:schoolId/creative-studio/avatar-videos')
@UseGuards(HonIdentityGuard)
export class CreativeStudioAvatarVideosController {
  constructor(private readonly studio: CreativeStudioService) {}
  @Get() @UseGuards(SaasReadGuard)
  async list(@Req() req: HonRequest, @Param('schoolId') schoolId: string) {
    return { data: await this.studio.listAvatarVideos(subject(req), schoolId) };
  }
  @Get(':videoId') @UseGuards(SaasReadGuard)
  async read(@Req() req: HonRequest, @Param('schoolId') schoolId: string, @Param('videoId') videoId: string) {
    return { data: await this.studio.readAvatarVideo(subject(req), schoolId, videoId) };
  }
  @Post() @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.createCreativeAvatarVideo)
  async create(@Req() req: HonRequest, @Param('schoolId') schoolId: string, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    return { data: await this.studio.createAvatarVideo(subject(req), schoolId, body, key) };
  }
}
