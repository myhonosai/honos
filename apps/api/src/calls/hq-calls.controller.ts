import { BadRequestException, Body, Controller, ForbiddenException, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { SAAS_COMMANDS } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { SaasCommandGuard, SaasCommandName, SaasReadGuard, SaasReadQuery } from '../saas-billing/saas-billing.guards.js';
import { HqCallsService } from './hq-calls.service.js';

function subject(req: HonRequest): string {
  if (!req.honIdentity) throw new ForbiddenException({ code: 'CALLING_FORBIDDEN' });
  return req.honIdentity.externalSubject;
}
function noKey(key: string | undefined): void {
  if (key !== undefined) throw new BadRequestException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
}
const LIST_KEYS = ['filter', 'contactUserId', 'beforeAt', 'beforeId'] as const;

/** The HQ call log filters arrive as plain query strings; a repeated key or a half cursor is refused. */
export function hqCallListQuery(query: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(query ?? {})) {
    if (!(LIST_KEYS as readonly string[]).includes(key) || typeof value !== 'string') throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    if (key === 'filter' || key === 'contactUserId') out[key] = value;
  }
  const at = query?.beforeAt, id = query?.beforeId;
  if ((at === undefined) !== (id === undefined)) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
  if (at !== undefined) out.before = { at, id };
  return out;
}

/**
 * CL5 (0580) HQ calling on the HQ number: direct human HQ people only. Reads are GET with no body; each command is its own
 * same-origin human command. The database decides who may call (any HQ messaging purpose) and who manages (HQ owner).
 */
@Controller('hq/calls')
@UseGuards(HonIdentityGuard)
export class HqCallsController {
  constructor(private readonly calls: HqCallsService) {}

  @Get('overview') @UseGuards(SaasReadGuard)
  async overview(@Req() req: HonRequest, @Headers('idempotency-key') key: string | undefined) {
    noKey(key);
    return { data: await this.calls.overview(subject(req)) };
  }

  @Get() @UseGuards(SaasReadGuard) @SaasReadQuery(LIST_KEYS)
  async list(@Req() req: HonRequest, @Query() query: Record<string, unknown>, @Headers('idempotency-key') key: string | undefined) {
    noKey(key);
    return { data: await this.calls.list(subject(req), hqCallListQuery(query)) };
  }

  /** A voicemail, streamed for this HQ person only (audited); never cached. */
  @Get(':callId/recording') @UseGuards(SaasReadGuard)
  async recording(@Req() req: HonRequest, @Param('callId', new ParseUUIDPipe()) callId: string, @Headers('idempotency-key') key: string | undefined,
    @Res() response: Response) {
    noKey(key);
    const audio = await this.calls.recording(subject(req), callId.toLowerCase());
    response.status(200).set({ 'Content-Type': audio.contentType, 'Content-Length': String(audio.audio.length), 'Cache-Control': 'private, no-store',
      'Content-Disposition': 'inline', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' }).end(audio.audio);
  }

  @Post('settings') @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.setHqCallingSettings)
  async settings(@Req() req: HonRequest, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    noKey(key);
    return { data: await this.calls.setSettings(subject(req), body) };
  }

  @Post('ring-me') @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.setMyHqCallRinging)
  async ringMe(@Req() req: HonRequest, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    noKey(key);
    return { data: await this.calls.setRinging(subject(req), body) };
  }

  @Post('do-not-call') @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.setHqDoNotCall)
  async doNotCall(@Req() req: HonRequest, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    noKey(key);
    return { data: await this.calls.setDoNotCall(subject(req), body) };
  }

  @Post('phone-token') @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.issueHqPhoneToken)
  async phoneToken(@Req() req: HonRequest, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    noKey(key);
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    return { data: await this.calls.phoneToken(subject(req)) };
  }

  /** Records an outgoing HQ call; the same Idempotency-Key (a uuid) replays it. The browser phone connects it. */
  @Post() @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.startHqCall)
  async start(@Req() req: HonRequest, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    if (typeof key !== 'string') throw new BadRequestException({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
    return { data: await this.calls.start(subject(req), body, key.toLowerCase()) };
  }

  @Post(':callId') @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.updateHqCall)
  async update(@Req() req: HonRequest, @Param('callId', new ParseUUIDPipe()) callId: string, @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined) {
    noKey(key);
    return { data: await this.calls.update(subject(req), callId.toLowerCase(), body) };
  }
}
