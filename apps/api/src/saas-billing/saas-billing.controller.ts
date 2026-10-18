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
 * HON subscription catalog and records (B1), invoices and payment evidence (B2), HQ only. HQ owner or
 * operator authority is resolved in the database. There is no checkout, charge, collection, invoice
 * delivery, refund execution or credit route.
 */
/**
 * School view of the HON premium credit allowance. Staff with ai.premium.request at the exact school;
 * the path is only a selector. Reads only: reservations are made by the premium job runtime, and
 * there is no purchase or top-up route.
 */
@Controller('schools/:schoolId/ai-credits')
@UseGuards(HonIdentityGuard)
export class SaasCreditsSchoolController {
  constructor(private readonly billing: SaasBillingService) {}
  @Get() @UseGuards(SaasReadGuard)
  async summary(@Req() req: HonRequest, @Param('schoolId') schoolId: string) {
    return { data: await this.billing.readSchoolCredits(subject(req), schoolId) };
  }
  @Get('estimate') @UseGuards(SaasReadGuard) @SaasReadQuery(['operation','units'])
  async estimate(@Req() req: HonRequest, @Param('schoolId') schoolId: string, @Query() query: unknown) {
    return { data: await this.billing.estimatePremiumOperation(subject(req), schoolId, query) };
  }
}

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
  @Get('organizations/:organizationId/payment-standing') @UseGuards(SaasReadGuard)
  async standing(@Req() req: HonRequest, @Param('organizationId') organizationId: string) {
    return { data: await this.billing.readPaymentStanding(subject(req), organizationId) };
  }
  @Get('invoices') @UseGuards(SaasReadGuard) @SaasReadQuery(['status'])
  async invoices(@Req() req: HonRequest, @Query('status') status: unknown) {
    return { data: await this.billing.readInvoices(subject(req), status) };
  }
  @Post('invoices') @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.createInvoiceDraft)
  async draftInvoice(@Req() req: HonRequest, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    return { data: await this.billing.createInvoiceDraft(subject(req), body, key) };
  }
  @Get('invoices/:invoiceId') @UseGuards(SaasReadGuard)
  async invoice(@Req() req: HonRequest, @Param('invoiceId') invoiceId: string) {
    return { data: await this.billing.readInvoice(subject(req), invoiceId) };
  }
  @Post('invoices/:invoiceId/commands') @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.invoiceCommand)
  async invoiceCommand(@Req() req: HonRequest, @Param('invoiceId') invoiceId: string, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    return { data: await this.billing.commandInvoice(subject(req), invoiceId, body, key) };
  }
  // ---------- B3: premium AI credits (HQ) ----------
  @Get('credits') @UseGuards(SaasReadGuard)
  async credits(@Req() req: HonRequest) {
    return { data: await this.billing.readCreditProgram(subject(req)) };
  }
  @Post('credits/program') @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.setCreditProgram)
  async creditProgram(@Req() req: HonRequest, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    return { data: await this.billing.setCreditProgram(subject(req), body, key) };
  }
  @Post('credits/cost-evidence') @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.recordCostEvidence)
  async costEvidence(@Req() req: HonRequest, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    return { data: await this.billing.recordCostEvidence(subject(req), body, key) };
  }
  @Post('credits/pricing-drafts') @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.createPricingDraft)
  async pricingDraft(@Req() req: HonRequest, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    return { data: await this.billing.createPricingDraft(subject(req), body, key) };
  }
  @Post('credits/pricing-drafts/:pricingId/publish') @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.publishPricing)
  async publishPricing(@Req() req: HonRequest, @Param('pricingId') pricingId: string, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    assertEmptyBody(body);
    return { data: await this.billing.publishPricing(subject(req), pricingId, key) };
  }
  @Post('credits/allowances') @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.allowanceCommand)
  async allowance(@Req() req: HonRequest, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    return { data: await this.billing.commandAllowance(subject(req), body, key) };
  }
  @Post('credits/reservations/:reservationId/resolve') @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.resolveCreditReservation)
  async resolve(@Req() req: HonRequest, @Param('reservationId') reservationId: string, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    return { data: await this.billing.resolveCreditReservation(subject(req), reservationId, body, key) };
  }
  @Get('organizations/:organizationId/credits') @UseGuards(SaasReadGuard)
  async organizationCredits(@Req() req: HonRequest, @Param('organizationId') organizationId: string) {
    return { data: await this.billing.readOrganizationCredits(subject(req), organizationId) };
  }
  @Post('invoices/:invoiceId/payment-evidence') @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.recordPaymentEvidence)
  async evidence(@Req() req: HonRequest, @Param('invoiceId') invoiceId: string, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    return { data: await this.billing.recordPaymentEvidence(subject(req), invoiceId, body, key) };
  }
}
