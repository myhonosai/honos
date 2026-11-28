import { Body, Controller, ForbiddenException, Get, Headers, HttpCode, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { SAAS_COMMANDS } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { SaasCommandGuard, SaasCommandName, SaasReadGuard, SaasReadQuery } from '../saas-billing/saas-billing.guards.js';
import { HqBlastsService } from './hq-blasts.service.js';

function subject(req: HonRequest): string {
  if (!req.honIdentity) throw new ForbiddenException({ code: 'SAAS_FORBIDDEN' });
  return req.honIdentity.externalSubject;
}

/** HB1 (0712) HQ text and email blasts to school owners. HQ owner only (decided in the database). No address is ever returned. */
@Controller('hq/communications/blasts')
@UseGuards(HonIdentityGuard)
export class HqBlastsController {
  constructor(private readonly blasts: HqBlastsService) {}
  @Get() @UseGuards(SaasReadGuard)
  async list(@Req() req: HonRequest) { return { data: await this.blasts.list(subject(req)) }; }
  // Declared before ':blastId' so "options" is never read as an id.
  @Get('options') @UseGuards(SaasReadGuard) @SaasReadQuery(['search'])
  async options(@Req() req: HonRequest, @Query() query: Record<string, unknown>) { return { data: await this.blasts.options(subject(req), query) }; }
  @Get(':blastId') @UseGuards(SaasReadGuard)
  async read(@Req() req: HonRequest, @Param('blastId') id: string) { return { data: await this.blasts.read(subject(req), id) }; }
  @Get(':blastId/audience') @UseGuards(SaasReadGuard)
  async audience(@Req() req: HonRequest, @Param('blastId') id: string) { return { data: await this.blasts.audience(subject(req), id) }; }
  @Post() @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.saveHqBlast)
  async save(@Req() req: HonRequest, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    return { data: await this.blasts.save(subject(req), body, key) };
  }
  @Post(':blastId/send') @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.sendHqBlast)
  async send(@Req() req: HonRequest, @Param('blastId') id: string, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    return { data: await this.blasts.send(subject(req), id, body, key) };
  }
  @Post(':blastId/cancel') @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.cancelHqBlast)
  async cancel(@Req() req: HonRequest, @Param('blastId') id: string, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    return { data: await this.blasts.cancel(subject(req), id, body, key) };
  }
}
