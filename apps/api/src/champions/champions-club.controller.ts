import { BadRequestException, Body, Controller, ForbiddenException, Get, Headers, HttpCode, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { CHAMPIONS_COMMANDS } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { ChampionsCommandGuard, ChampionsCommandName, ChampionsReadGuard, ChampionsReadQuery } from './champions-club.guards.js';
import { ChampionsClubService } from './champions-club.service.js';

function assertEmptyBody(body: unknown): void {
  if (body !== undefined && body !== null && (typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length > 0)) {
    throw new BadRequestException({ code: 'INVALID_CHAMPIONS_INPUT' });
  }
}

function subject(req: HonRequest): string {
  if (!req.honIdentity) throw new ForbiddenException({ code: 'CHAMPIONS_FORBIDDEN' });
  return req.honIdentity.externalSubject;
}

/** School participation. The database resolves staff authority for the exact school; the path is only a selector. */
@Controller('schools/:schoolId/champions')
@UseGuards(HonIdentityGuard)
export class ChampionsSchoolController {
  constructor(private readonly champions: ChampionsClubService) {}
  @Get('summary') @UseGuards(ChampionsReadGuard)
  async summary(@Req() req: HonRequest, @Param('schoolId') schoolId: string) {
    return { data: await this.champions.readSchoolView(subject(req), schoolId) };
  }
  @Get('referral-code') @UseGuards(ChampionsReadGuard)
  async referralCode(@Req() req: HonRequest, @Param('schoolId') schoolId: string) {
    const view = await this.champions.readSchoolView(subject(req), schoolId);
    return { data: { schoolId: view.schoolId, referralCode: view.referralCode } };
  }
  @Post('referral-code') @HttpCode(200) @UseGuards(ChampionsCommandGuard) @ChampionsCommandName(CHAMPIONS_COMMANDS.issueReferralCode)
  async issue(@Req() req: HonRequest, @Param('schoolId') schoolId: string, @Headers('idempotency-key') key: string | undefined) {
    return { data: await this.champions.issueReferralCode(subject(req), schoolId, key) };
  }
  @Get('rewards') @UseGuards(ChampionsReadGuard)
  async rewards(@Req() req: HonRequest, @Param('schoolId') schoolId: string) {
    return { data: await this.champions.readSchoolRewards(subject(req), schoolId) };
  }  @Get('leaderboard') @UseGuards(ChampionsReadGuard) @ChampionsReadQuery(['period','month'])
  async leaderboard(@Req() req: HonRequest, @Param('schoolId') schoolId: string, @Query() query: unknown) {
    return { data: await this.champions.readSchoolLeaderboard(subject(req), schoolId, query) };
  }
  @Get('statistics') @UseGuards(ChampionsReadGuard)
  async statistics(@Req() req: HonRequest, @Param('schoolId') schoolId: string) {
    return { data: await this.champions.readSchoolStatistics(subject(req), schoolId) };
  }
  @Post('leaderboard-preference') @HttpCode(200) @UseGuards(ChampionsCommandGuard) @ChampionsCommandName(CHAMPIONS_COMMANDS.setLeaderboardPreference)
  async preference(@Req() req: HonRequest, @Param('schoolId') schoolId: string, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    return { data: await this.champions.setLeaderboardPreference(subject(req), schoolId, body, key) };
  }
}

/** HQ program administration. HQ owner or operator authority is resolved in the database. */
@Controller('hq/champions')
@UseGuards(HonIdentityGuard)
export class ChampionsHqController {
  constructor(private readonly champions: ChampionsClubService) {}
  @Get('program') @UseGuards(ChampionsReadGuard)
  async program(@Req() req: HonRequest) {
    return { data: await this.champions.readProgram(subject(req)) };
  }
  @Post('policy-drafts') @HttpCode(200) @UseGuards(ChampionsCommandGuard) @ChampionsCommandName(CHAMPIONS_COMMANDS.createPolicyDraft)
  async draft(@Req() req: HonRequest, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    return { data: await this.champions.createPolicyDraft(subject(req), body, key) };
  }
  @Post('policy-drafts/:policyId/publish') @HttpCode(200) @UseGuards(ChampionsCommandGuard) @ChampionsCommandName(CHAMPIONS_COMMANDS.publishPolicy)
  async publish(@Req() req: HonRequest, @Param('policyId') policyId: string, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    assertEmptyBody(body);
    return { data: await this.champions.publishPolicy(subject(req), policyId, key) };
  }
  @Get('attributions') @UseGuards(ChampionsReadGuard) @ChampionsReadQuery(['state'])
  async attributions(@Req() req: HonRequest, @Query('state') state: unknown) {
    return { data: await this.champions.readAttributions(subject(req), state) };
  }
  @Post('attributions') @HttpCode(200) @UseGuards(ChampionsCommandGuard) @ChampionsCommandName(CHAMPIONS_COMMANDS.captureAttribution)
  async capture(@Req() req: HonRequest, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    return { data: await this.champions.captureAttribution(subject(req), body, key) };
  }
  @Post('attributions/:attributionId/decisions') @HttpCode(200) @UseGuards(ChampionsCommandGuard) @ChampionsCommandName(CHAMPIONS_COMMANDS.decideAttribution)
  async decide(@Req() req: HonRequest, @Param('attributionId') attributionId: string, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    return { data: await this.champions.decideAttribution(subject(req), attributionId, body, key) };
  }

  // Reward accounting: liabilities only; nothing is issued, applied or fulfilled.
  @Get('rewards/program') @UseGuards(ChampionsReadGuard)
  async rewardProgram(@Req() req: HonRequest) {
    return { data: await this.champions.readRewardProgram(subject(req)) };
  }
  @Post('rewards/policy-drafts') @HttpCode(200) @UseGuards(ChampionsCommandGuard) @ChampionsCommandName(CHAMPIONS_COMMANDS.createRewardPolicyDraft)
  async rewardDraft(@Req() req: HonRequest, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    return { data: await this.champions.createRewardPolicyDraft(subject(req), body, key) };
  }
  @Post('rewards/policy-drafts/:policyId/publish') @HttpCode(200) @UseGuards(ChampionsCommandGuard) @ChampionsCommandName(CHAMPIONS_COMMANDS.publishRewardPolicy)
  async rewardPublish(@Req() req: HonRequest, @Param('policyId') policyId: string, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    assertEmptyBody(body);
    return { data: await this.champions.publishRewardPolicy(subject(req), policyId, key) };
  }
  @Post('rewards/schools/:schoolId/reconcile') @HttpCode(200) @UseGuards(ChampionsCommandGuard) @ChampionsCommandName(CHAMPIONS_COMMANDS.reconcileRewards)
  async rewardReconcile(@Req() req: HonRequest, @Param('schoolId') schoolId: string, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    assertEmptyBody(body);
    return { data: await this.champions.reconcileRewards(subject(req), schoolId, key) };
  }
  @Get('rewards/ledger') @UseGuards(ChampionsReadGuard) @ChampionsReadQuery(['status'])
  async rewardLedger(@Req() req: HonRequest, @Query('status') status: unknown) {
    return { data: await this.champions.readRewardLedger(subject(req), status) };
  }
  @Post('rewards/entries/:entryId/decisions') @HttpCode(200) @UseGuards(ChampionsCommandGuard) @ChampionsCommandName(CHAMPIONS_COMMANDS.decideReward)
  async rewardDecide(@Req() req: HonRequest, @Param('entryId') entryId: string, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    return { data: await this.champions.decideReward(subject(req), entryId, body, key) };
  }
  // Leaderboards: QUALIFIED referrals only; holds never change attributions or rewards.
  @Get('leaderboard') @UseGuards(ChampionsReadGuard) @ChampionsReadQuery(['period','month'])
  async leaderboard(@Req() req: HonRequest, @Query() query: unknown) {
    return { data: await this.champions.readHqLeaderboard(subject(req), query) };
  }
  @Get('schools/:schoolId/statistics') @UseGuards(ChampionsReadGuard)
  async schoolStatistics(@Req() req: HonRequest, @Param('schoolId') schoolId: string) {
    return { data: await this.champions.readHqSchoolStatistics(subject(req), schoolId) };
  }
  @Post('leaderboard/holds') @HttpCode(200) @UseGuards(ChampionsCommandGuard) @ChampionsCommandName(CHAMPIONS_COMMANDS.setLeaderboardHold)
  async hold(@Req() req: HonRequest, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    return { data: await this.champions.setLeaderboardHold(subject(req), body, key) };
  }
}
