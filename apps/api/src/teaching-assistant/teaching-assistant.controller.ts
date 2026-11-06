import { BadRequestException, Body, Controller, ForbiddenException, Get, Header, Headers, HttpCode, Injectable, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { TeachingAssistantContext } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { TeachingStudioHumanUiGuard } from '../teaching-studio/teaching-studio.dto.js';
import { TeachingAssistantService } from './teaching-assistant.service.js';

@Injectable()
export class TeachingAssistantHumanUiGuard extends TeachingStudioHumanUiGuard { protected readonly command = 'teaching-assistant'; }

@Controller('staff/teaching-assistant')
@UseGuards(HonIdentityGuard, TeachingAssistantHumanUiGuard)
export class TeachingAssistantController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly assistant: TeachingAssistantService) {}
  private async context(req: HonRequest, key = ''): Promise<TeachingAssistantContext> { if (!req.honIdentity) throw new ForbiddenException({ code: 'IDENTITY_REQUIRED' }); const scope = await this.database.resolveTeachingAssistantScope(req.honIdentity.externalSubject); if (!scope) throw new ForbiddenException({ code: 'TEACHING_ASSISTANT_SCOPE_DENIED' }); const id = randomUUID(); return { ...scope, externalSubject: req.honIdentity.externalSubject, principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: id, correlationId: id, idempotencyKey: key }; }
  private noQuery(query: Record<string, unknown>) { if (Object.keys(query).length) throw new BadRequestException({ code: 'INVALID_TEACHING_QUERY' }); }
  private empty(value: unknown) { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length) throw new BadRequestException({ code: 'EMPTY_COMMAND_REQUIRED' }); }
  @Header('Cache-Control', 'private, no-store') @Header('Referrer-Policy', 'no-referrer') @Post() @HttpCode(200)
  async submit(@Req() req: HonRequest, @Body() input: unknown, @Headers('idempotency-key') key: string | undefined, @Query() query: Record<string, unknown>) { this.noQuery(query); return { data: await this.assistant.submit(await this.context(req, key ?? ''), input) }; }
  @Header('Cache-Control', 'private, no-store') @Header('Referrer-Policy', 'no-referrer') @Get('curricula')
  async curricula(@Req() req: HonRequest, @Query() query: Record<string, unknown>) { this.noQuery(query); return { data: await this.assistant.listCurricula(await this.context(req)) }; }
  @Header('Cache-Control', 'private, no-store') @Header('Referrer-Policy', 'no-referrer') @Get('mine')
  async mine(@Req() req: HonRequest, @Query() query: Record<string, unknown>) { this.noQuery(query); return { data: await this.assistant.listMine(await this.context(req)) }; }
  @Header('Cache-Control', 'private, no-store') @Header('Referrer-Policy', 'no-referrer') @Get(':invocationId')
  async read(@Req() req: HonRequest, @Param('invocationId', new ParseUUIDPipe()) id: string, @Query() query: Record<string, unknown>) { this.noQuery(query); return { data: await this.assistant.read(await this.context(req), id) }; }
  @Header('Cache-Control', 'private, no-store') @Header('Referrer-Policy', 'no-referrer') @Post(':invocationId/retry') @HttpCode(200)
  async retry(@Req() req: HonRequest, @Param('invocationId', new ParseUUIDPipe()) id: string, @Body() input: unknown, @Query() query: Record<string, unknown>) { this.noQuery(query); this.empty(input); return { data: await this.assistant.generate(await this.context(req), id) }; }
  @Header('Cache-Control', 'private, no-store') @Header('Referrer-Policy', 'no-referrer') @Post(':invocationId/save-approved') @HttpCode(200)
  async save(@Req() req: HonRequest, @Param('invocationId', new ParseUUIDPipe()) id: string, @Body() input: unknown, @Query() query: Record<string, unknown>) { this.noQuery(query); this.empty(input); return { data: await this.assistant.saveApproved(await this.context(req), id) }; }
}
