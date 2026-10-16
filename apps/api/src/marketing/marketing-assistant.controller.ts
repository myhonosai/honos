import { BadRequestException, Body, Controller, ForbiddenException, Get, Header, Headers, HttpCode, Injectable, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { MarketingAssistantContext } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { CampaignHumanUiGuard } from './campaign-human-ui.guard.js';
import { MarketingAssistantService } from './marketing-assistant.service.js';

@Injectable()
export class MarketingAssistantHumanUiGuard extends CampaignHumanUiGuard { protected readonly command: string = 'marketing-assistant'; }

@Controller('marketing/assistant')
@UseGuards(HonIdentityGuard, MarketingAssistantHumanUiGuard)
export class MarketingAssistantController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly assistant: MarketingAssistantService) {}
  private async context(req: HonRequest, key = ''): Promise<MarketingAssistantContext> {
    if (!req.honIdentity) throw new ForbiddenException({ code: 'IDENTITY_REQUIRED' });
    const scope = await this.database.resolveCampaignScope(req.honIdentity.externalSubject, 'marketing.campaign.read');
    if (!scope) throw new ForbiddenException({ code: 'MARKETING_SCOPE_DENIED' });
    const id = randomUUID();
    return { ...scope, externalSubject: req.honIdentity.externalSubject, principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: id, correlationId: id, idempotencyKey: key };
  }
  private noQuery(query: Record<string, unknown>) { if (Object.keys(query).length) throw new BadRequestException({ code: 'INVALID_MARKETING_QUERY' }); }
  private empty(input: unknown) { if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length) throw new BadRequestException({ code: 'EMPTY_COMMAND_REQUIRED' }); }
  @Header('Cache-Control', 'private, no-store') @Post() @HttpCode(200)
  async submit(@Req() req: HonRequest, @Body() input: unknown, @Headers('idempotency-key') key: string | undefined, @Query() query: Record<string, unknown>) { this.noQuery(query); return { data: await this.assistant.submit(await this.context(req, key), input) }; }
  @Header('Cache-Control', 'private, no-store') @Get('mine')
  async mine(@Req() req: HonRequest, @Query() query: Record<string, unknown>) { this.noQuery(query); return { data: await this.assistant.listMine(await this.context(req)) }; }
  @Header('Cache-Control', 'private, no-store') @Get(':invocationId')
  async read(@Req() req: HonRequest, @Param('invocationId', new ParseUUIDPipe()) id: string, @Query() query: Record<string, unknown>) { this.noQuery(query); return { data: await this.assistant.read(await this.context(req), id) }; }
  @Header('Cache-Control', 'private, no-store') @Post(':invocationId/retry') @HttpCode(200)
  async retry(@Req() req: HonRequest, @Param('invocationId', new ParseUUIDPipe()) id: string, @Body() input: unknown, @Query() query: Record<string, unknown>) { this.noQuery(query); this.empty(input); return { data: await this.assistant.generate(await this.context(req), id) }; }
  @Header('Cache-Control', 'private, no-store') @Post(':invocationId/save-approved') @HttpCode(200)
  async save(@Req() req: HonRequest, @Param('invocationId', new ParseUUIDPipe()) id: string, @Body() input: unknown, @Query() query: Record<string, unknown>) { this.noQuery(query); this.empty(input); return { data: await this.assistant.saveApproved(await this.context(req), id) }; }
  @Header('Cache-Control', 'private, no-store') @Get('campaigns/:campaignId/content')
  async content(@Req() req: HonRequest, @Param('campaignId', new ParseUUIDPipe()) id: string, @Query() query: Record<string, unknown>) { this.noQuery(query); return { data: await this.assistant.workspace(await this.context(req), id) }; }
}
