import { BadRequestException, Body, Controller, ForbiddenException, Get, Header, Headers, HttpCode, Injectable, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { ChadFollowUpAssistantContext } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { CampaignHumanUiGuard } from '../marketing/campaign-human-ui.guard.js';
import { ChadFollowUpAssistantService } from './chad-follow-up-assistant.service.js';

@Injectable()
export class ChadFollowUpAssistantHumanUiGuard extends CampaignHumanUiGuard { protected readonly command = 'chad-follow-up-assistant'; }

@Controller('staff/leads/assistant')
@UseGuards(HonIdentityGuard, ChadFollowUpAssistantHumanUiGuard)
export class ChadFollowUpAssistantController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly assistant: ChadFollowUpAssistantService) {}
  private async context(req: HonRequest, key = ''): Promise<ChadFollowUpAssistantContext> { if (!req.honIdentity) throw new ForbiddenException({ code: 'IDENTITY_REQUIRED' }); const scope = await this.database.resolveChadFollowUpAssistantScope(req.honIdentity.externalSubject); if (!scope) throw new ForbiddenException({ code: 'FOLLOW_UP_DRAFT_SCOPE_DENIED' }); const id = randomUUID(); return { ...scope, externalSubject: req.honIdentity.externalSubject, principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: id, correlationId: id, idempotencyKey: key }; }
  private noQuery(query: Record<string, unknown>) { if (Object.keys(query).length) throw new BadRequestException({ code: 'INVALID_FOLLOW_UP_DRAFT_QUERY' }); }
  private empty(input: unknown) { if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length) throw new BadRequestException({ code: 'EMPTY_COMMAND_REQUIRED' }); }
  @Header('Cache-Control', 'private, no-store') @Header('Referrer-Policy', 'no-referrer') @Post() @HttpCode(200)
  async submit(@Req() req: HonRequest, @Body() input: unknown, @Headers('idempotency-key') key: string | undefined, @Query() query: Record<string, unknown>) { this.noQuery(query); return { data: await this.assistant.submit(await this.context(req, key ?? ''), input) }; }
  @Header('Cache-Control', 'private, no-store') @Header('Referrer-Policy', 'no-referrer') @Get('mine')
  async mine(@Req() req: HonRequest, @Query() query: Record<string, unknown>) { this.noQuery(query); return { data: await this.assistant.listMine(await this.context(req)) }; }
  @Header('Cache-Control', 'private, no-store') @Header('Referrer-Policy', 'no-referrer') @Get(':invocationId')
  async read(@Req() req: HonRequest, @Param('invocationId', new ParseUUIDPipe()) id: string, @Query() query: Record<string, unknown>) { this.noQuery(query); return { data: await this.assistant.read(await this.context(req), id) }; }
  @Header('Cache-Control', 'private, no-store') @Header('Referrer-Policy', 'no-referrer') @Post(':invocationId/retry') @HttpCode(200)
  async retry(@Req() req: HonRequest, @Param('invocationId', new ParseUUIDPipe()) id: string, @Body() input: unknown, @Query() query: Record<string, unknown>) { this.noQuery(query); this.empty(input); return { data: await this.assistant.generate(await this.context(req), id) }; }
}
