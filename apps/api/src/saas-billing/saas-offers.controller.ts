import { BadRequestException, Body, Controller, ForbiddenException, Get, Headers, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { SAAS_COMMANDS } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { SaasCommandGuard, SaasCommandName, SaasReadGuard } from './saas-billing.guards.js';
import { SaasBillingService } from './saas-billing.service.js';

function subject(req: HonRequest): string {
  if (!req.honIdentity) throw new ForbiddenException({ code: 'SAAS_FORBIDDEN' });
  return req.honIdentity.externalSubject;
}
function body(value: unknown): unknown {
  if (value === undefined) throw new BadRequestException({ code: 'INVALID_SAAS_INPUT' });
  return value;
}

/**
 * HQ Pricing & Offers for the one HON OS product (0181). Reads: HQ owner, or operator with hq.billing.manage.
 * Commands: HQ owner only, resolved in the database. Publishing requires the server's preview digest of the exact
 * draft revision. No route here opens a checkout, charges, grants credits or changes an entitlement.
 */
@Controller('hq/saas/offers')
@UseGuards(HonIdentityGuard)
export class SaasOffersHqController {
  constructor(private readonly billing: SaasBillingService) {}

  @Get() @UseGuards(SaasReadGuard)
  async management(@Req() req: HonRequest) {
    return { data: await this.billing.readOfferManagement(subject(req)) };
  }
  @Get('sets/:setId') @UseGuards(SaasReadGuard)
  async set(@Req() req: HonRequest, @Param('setId') setId: string) {
    return { data: await this.billing.readOfferSet(subject(req), setId) };
  }
  @Post('sets') @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.createOfferSetDraft)
  async draft(@Req() req: HonRequest, @Body() input: unknown, @Headers('idempotency-key') key: string | undefined) {
    return { data: await this.billing.createOfferSetDraft(subject(req), body(input), key) };
  }
  @Post('sets/:setId/revise') @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.reviseOfferSetDraft)
  async revise(@Req() req: HonRequest, @Param('setId') setId: string, @Body() input: unknown, @Headers('idempotency-key') key: string | undefined) {
    return { data: await this.billing.reviseOfferSetDraft(subject(req), setId, body(input), key) };
  }
  @Post('sets/:setId/discard') @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.discardOfferSetDraft)
  async discard(@Req() req: HonRequest, @Param('setId') setId: string, @Body() input: unknown, @Headers('idempotency-key') key: string | undefined) {
    return { data: await this.billing.discardOfferSetDraft(subject(req), setId, body(input), key) };
  }
  @Post('sets/:setId/publish') @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.publishOfferSet)
  async publish(@Req() req: HonRequest, @Param('setId') setId: string, @Body() input: unknown, @Headers('idempotency-key') key: string | undefined) {
    return { data: await this.billing.publishOfferSet(subject(req), setId, body(input), key) };
  }
  @Post(':offerId/stop-sales') @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.stopOfferSales)
  async stopSales(@Req() req: HonRequest, @Param('offerId') offerId: string, @Body() input: unknown, @Headers('idempotency-key') key: string | undefined) {
    return { data: await this.billing.stopOfferSales(subject(req), offerId, body(input), key) };
  }
}

/**
 * The HON OS offers a school purchaser (billing.hon.purchase at the exact school) may see now: published, on sale,
 * with server-evaluated eligibility. Read only; purchasing is NOT_CONNECTED and the path is only a selector.
 */
@Controller('schools/:schoolId/hon-os-offers')
@UseGuards(HonIdentityGuard)
export class SaasOffersSchoolController {
  constructor(private readonly billing: SaasBillingService) {}
  @Get() @UseGuards(SaasReadGuard)
  async offers(@Req() req: HonRequest, @Param('schoolId') schoolId: string) {
    return { data: await this.billing.readSchoolHonOsOffers(subject(req), schoolId) };
  }
}
