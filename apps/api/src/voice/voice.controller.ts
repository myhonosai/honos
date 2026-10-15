import { Allow } from 'class-validator';
import { BadRequestException, Body, Controller, ForbiddenException, Get, Header, Headers, HttpCode, Injectable, Param, ParseUUIDPipe, Post, Query, Req, UseGuards, type ExecutionContext } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { VOICE_UUID, type VoiceContext, type VoiceOperation } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { CurriculumHumanUiGuard } from '../curriculum/curriculum-human-ui.guard.js';
import { VoiceService } from './voice.service.js';

export class VoiceCreateDto {
  @Allow() agentCatalogId!: unknown;
  @Allow() workItemId?: unknown;
  @Allow() actionRequestId?: unknown;
  @Allow() approvalId?: unknown;
  @Allow() resumeSessionId?: unknown;
}
export class VoiceStatusDto { @Allow() expectedVersion!: unknown; @Allow() state!: unknown; @Allow() reasonCode!: unknown; }
export class VoiceFallbackDto { @Allow() expectedVersion!: unknown; @Allow() reasonCode!: unknown; @Allow() draftText?: unknown; }
export class VoiceEndDto { @Allow() expectedVersion!: unknown; }
@Injectable()
export class VoiceHumanUiGuard extends CurriculumHumanUiGuard {
  protected readonly command: string = 'voice-session';
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{ headers: Record<string, unknown> }>();
    if (req.headers['sec-fetch-site'] !== 'same-origin' || req.headers['x-hon-human-command'] !== this.command) throw new ForbiddenException({ code: 'HUMAN_UI_REQUIRED' });
    return super.canActivate(context);
  }
}
@Controller('staff/voice/:schoolId')
@UseGuards(HonIdentityGuard, VoiceHumanUiGuard)
export class VoiceController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly voice: VoiceService) {}
  private async context(school: string, req: HonRequest, key = ''): Promise<VoiceContext> {
    if (!req.honIdentity) throw new ForbiddenException({ code: 'IDENTITY_REQUIRED' });
    const externalSubject = req.honIdentity.externalSubject;
    const scope = await this.database.resolveAuthorizedScope(externalSubject, school, 'ai.voice.interact');
    if (!scope) throw new ForbiddenException({ code: 'PERMISSION_DENIED' });
    const requestId = randomUUID();
    return { ...scope, externalSubject, principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId, correlationId: requestId, idempotencyKey: key };
  }
  private emptyQuery(query: Record<string, unknown>) { if (Object.keys(query).length) throw new BadRequestException({ code: 'VALIDATION_FAILED' }); }
  private normalizedBody(body: unknown): Record<string, unknown> {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    return Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined));
  }
  private async change(school: string, id: string | null, operation: VoiceOperation, body: unknown, header: string | undefined, query: Record<string,unknown>, req: HonRequest) {
    this.emptyQuery(query);
    if (!header || !VOICE_UUID.test(header)) throw new BadRequestException({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
    const c = await this.context(school, req, header);
    return { data: await this.voice.mutate(c,operation,id,this.normalizedBody(body)), meta: { requestId: c.requestId, correlationId: c.correlationId } };
  }
  @Header('Cache-Control','private, no-store') @Post() @HttpCode(200)
  create(@Param('schoolId',new ParseUUIDPipe()) school: string, @Body() body: VoiceCreateDto, @Headers('idempotency-key') key: string | undefined, @Query() q: Record<string,unknown>, @Req() req: HonRequest) { return this.change(school,null,'create',body,key,q,req); }
  @Header('Cache-Control','private, no-store') @Get(':sessionId')
  async read(@Param('schoolId',new ParseUUIDPipe()) school: string, @Param('sessionId',new ParseUUIDPipe()) id: string, @Query() q: Record<string,unknown>, @Req() req: HonRequest) {
    this.emptyQuery(q); const c = await this.context(school,req);
    return { data: await this.voice.read(c,id), meta: { requestId: c.requestId, correlationId: c.correlationId } };
  }
  @Header('Cache-Control','private, no-store') @Post(':sessionId/status') @HttpCode(200)
  status(@Param('schoolId',new ParseUUIDPipe()) school: string, @Param('sessionId',new ParseUUIDPipe()) id: string, @Body() body: VoiceStatusDto, @Headers('idempotency-key') key: string | undefined, @Query() q: Record<string,unknown>, @Req() req: HonRequest) { return this.change(school,id,'status',body,key,q,req); }
  @Header('Cache-Control','private, no-store') @Post(':sessionId/mark-fallback') @HttpCode(200)
  fallback(@Param('schoolId',new ParseUUIDPipe()) school: string, @Param('sessionId',new ParseUUIDPipe()) id: string, @Body() body: VoiceFallbackDto, @Headers('idempotency-key') key: string | undefined, @Query() q: Record<string,unknown>, @Req() req: HonRequest) { return this.change(school,id,'mark-fallback',body,key,q,req); }
  @Header('Cache-Control','private, no-store') @Post(':sessionId/end') @HttpCode(200)
  end(@Param('schoolId',new ParseUUIDPipe()) school: string, @Param('sessionId',new ParseUUIDPipe()) id: string, @Body() body: VoiceEndDto, @Headers('idempotency-key') key: string | undefined, @Query() q: Record<string,unknown>, @Req() req: HonRequest) { return this.change(school,id,'end',body,key,q,req); }
}
