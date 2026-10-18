import { BadRequestException, Body, Controller, ForbiddenException, Get, Headers, HttpCode, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { SAAS_COMMANDS } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { SaasCommandGuard, SaasCommandName, SaasReadGuard, SaasReadQuery } from './saas-billing.guards.js';
import { SaasBillingService } from './saas-billing.service.js';

function assertEmptyBody(body: unknown): void {
  if (body !== undefined && body !== null && (typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length > 0)) {
    throw new BadRequestException({ code: 'INVALID_SAAS_INPUT' });
  }
}

function subject(req: HonRequest): string {
  if (!req.honIdentity) throw new ForbiddenException({ code: 'SAAS_FORBIDDEN' });
  return req.honIdentity.externalSubject;
}

/**
 * HON subscription catalog and records (B1), HQ only. HQ owner or operator authority is resolved
 * in the database. There is no checkout, charge, invoice, refund or credit route.
 */
@Controller('hq/saas')
@UseGuards(HonIdentityGuard)
export class SaasBillingHqController {
  constructor(private readonly billing: SaasBillingService) {}

  @Get('catalog') @UseGuards(SaasReadGuard)
  async catalog(@Req() req: HonRequest) {
    return { data: await this.billing.readCatalog(subject(req)) };
  }
  @Post('catalog/drafts') @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.createCatalogDraft)
  async draft(@Req() req: HonRequest, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    return { data: await this.billing.createCatalogDraft(subject(req), body, key) };
  }
  @Post('catalog/drafts/:catalogId/publish') @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.publishCatalog)
  async publish(@Req() req: HonRequest, @Param('catalogId') catalogId: string, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    assertEmptyBody(body);
    return { data: await this.billing.publishCatalog(subject(req), catalogId, key) };
  }
  @Get('founder-reservations') @UseGuards(SaasReadGuard) @SaasReadQuery(['status'])
  async reservations(@Req() req: HonRequest, @Query('status') status: unknown) {
    return { data: await this.billing.readFounderReservations(subject(req), status) };
  }
  @Post('founder-reservations') @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.reserveFounder)
  async reserve(@Req() req: HonRequest, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    return { data: await this.billing.reserveFounder(subject(req), body, key) };
  }
  @Post('founder-reservations/:reservationId/release') @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.releaseFounder)
  async release(@Req() req: HonRequest, @Param('reservationId') reservationId: string, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    return { data: await this.billing.releaseFounder(subject(req), reservationId, body, key) };
  }
  @Get('subscriptions') @UseGuards(SaasReadGuard) @SaasReadQuery(['status'])
  async subscriptions(@Req() req: HonRequest, @Query('status') status: unknown) {
    return { data: await this.billing.readSubscriptions(subject(req), status) };
  }
  @Post('subscriptions') @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.recordSubscription)
  async record(@Req() req: HonRequest, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    return { data: await this.billing.recordSubscription(subject(req), body, key) };
  }
  @Post('subscriptions/:subscriptionId/commands') @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.subscriptionCommand)
  async command(@Req() req: HonRequest, @Param('subscriptionId') subscriptionId: string, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    return { data: await this.billing.commandSubscription(subject(req), subscriptionId, body, key) };
  }
  @Get('organizations/:organizationId/subscription') @UseGuards(SaasReadGuard)
  async organization(@Req() req: HonRequest, @Param('organizationId') organizationId: string) {
    return { data: await this.billing.readOrganizationSubscription(subject(req), organizationId) };
  }
}
