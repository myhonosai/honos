import { BadRequestException, Body, Controller, ForbiddenException, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { SAAS_COMMANDS } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { SaasCommandGuard, SaasCommandName, SaasReadGuard, SaasReadQuery } from '../saas-billing/saas-billing.guards.js';
import { HqCreativeDesignsService } from './hq-creative-designs.service.js';

function subject(req: HonRequest): string {
  if (!req.honIdentity) throw new ForbiddenException({ code: 'SAAS_FORBIDDEN' });
  return req.honIdentity.externalSubject;
}
function fields(body: unknown): unknown {
  return body && typeof body === 'object' && !Array.isArray(body) ? Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)) : body;
}

/**
 * 0678 HQ Creative designs: the flyer, poster and social design editor for HON's own marketing. Reads are same-origin GETs;
 * save, archive/restore and photo upload are each their own HQ human command. Who may read or change is decided only by
 * the database (HQ marketing people of 0252); the route carries no school and grants nothing.
 */
@Controller('hq/marketing/creative/designs')
@UseGuards(HonIdentityGuard)
export class HqCreativeDesignsController {
  constructor(private readonly designs: HqCreativeDesignsService) {}

  @Get() @UseGuards(SaasReadGuard) @SaasReadQuery(['status'])
  async list(@Req() req: HonRequest, @Query('status') status: unknown) {
    if (status !== undefined && typeof status !== 'string') throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    return { data: await this.designs.list(subject(req), status === undefined ? {} : { status }) };
  }

  @Get('photos/:photoId') @UseGuards(SaasReadGuard)
  async photo(@Req() req: HonRequest, @Param('photoId', new ParseUUIDPipe()) photoId: string) {
    return { data: await this.designs.photo(subject(req), photoId.toLowerCase()) };
  }

  @Get(':designId') @UseGuards(SaasReadGuard)
  async get(@Req() req: HonRequest, @Param('designId', new ParseUUIDPipe()) designId: string) {
    return { data: await this.designs.get(subject(req), designId.toLowerCase()) };
  }

  @Post() @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.saveHqCreativeDesign)
  async save(@Req() req: HonRequest, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    const r = await this.designs.save(subject(req), fields(body), key);
    return { data: r.design, meta: { replayed: r.replayed } };
  }

  @Post('photos') @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.addHqCreativeDesignPhoto)
  async addPhoto(@Req() req: HonRequest, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    const r = await this.designs.addPhoto(subject(req), fields(body), key);
    return { data: r.photo, meta: { replayed: r.replayed } };
  }

  @Post(':designId/status') @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.setHqCreativeDesignStatus)
  async setStatus(@Req() req: HonRequest, @Param('designId', new ParseUUIDPipe()) designId: string, @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined) {
    const input = fields(body);
    const r = await this.designs.setStatus(subject(req), input && typeof input === 'object' ? { ...input, designId: designId.toLowerCase() } : input, key);
    return { data: r.design, meta: { replayed: r.replayed } };
  }
}
