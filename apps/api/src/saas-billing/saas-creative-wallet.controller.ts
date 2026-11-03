import { BadRequestException, Body, Controller, ForbiddenException, Get, Headers, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { SAAS_COMMANDS } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { SaasCommandGuard, SaasCommandName, SaasReadGuard } from './saas-billing.guards.js';
import { SaasCreativeWalletService } from './saas-creative-wallet.service.js';

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
 * HQ view and control of HON OS creative credits (CW1). Owner-only commands and owner/operator reads are
 * enforced in the database; the path is only a selector. There is no route that charges a card, fulfills a
 * purchase or calls a generation provider.
 */
@Controller('hq/saas/creative-credits')
@UseGuards(HonIdentityGuard)
export class SaasCreativeWalletHqController {
  constructor(private readonly wallet: SaasCreativeWalletService) {}
  @Get() @UseGuards(SaasReadGuard)
  async wallets(@Req() req: HonRequest) {
    return { data: await this.wallet.readWallets(subject(req)) };
  }
  @Get('organizations/:organizationId') @UseGuards(SaasReadGuard)
  async organization(@Req() req: HonRequest, @Param('organizationId') organizationId: string) {
    return { data: await this.wallet.readOrganizationWallet(subject(req), organizationId) };
  }
  @Post('program') @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.setCreativeProgram)
  async program(@Req() req: HonRequest, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    return { data: await this.wallet.setProgram(subject(req), body, key) };
  }
  @Post('rates') @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.publishCreativeRates)
  async rates(@Req() req: HonRequest, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    return { data: await this.wallet.publishRates(subject(req), body, key) };
  }
  @Post('organizations/:organizationId/grants') @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.grantCreativeCredits)
  async grant(@Req() req: HonRequest, @Param('organizationId') organizationId: string, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    return { data: await this.wallet.grantCredits(subject(req), organizationId, body, key) };
  }
  @Post('lots/:lotId/debits') @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.debitCreativeLot)
  async debit(@Req() req: HonRequest, @Param('lotId') lotId: string, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    return { data: await this.wallet.debitLot(subject(req), lotId, body, key) };
  }
  @Post('reservations/:reservationId/resolve') @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.resolveCreativeReservation)
  async resolve(@Req() req: HonRequest, @Param('reservationId') reservationId: string, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    return { data: await this.wallet.resolveReservation(subject(req), reservationId, body, key) };
  }
}

/**
 * School view of its HON OS creative credits: staff with ai.premium.request at the exact school read the
 * wallet and open the current included window; a purchaser (billing.hon.purchase) records a top-up purchase
 * intent. No provider cost is shown and no payment is taken.
 */
@Controller('schools/:schoolId/creative-credits')
@UseGuards(HonIdentityGuard)
export class SaasCreativeWalletSchoolController {
  constructor(private readonly wallet: SaasCreativeWalletService) {}
  @Get() @UseGuards(SaasReadGuard)
  async summary(@Req() req: HonRequest, @Param('schoolId') schoolId: string) {
    return { data: await this.wallet.readSchoolWallet(subject(req), schoolId) };
  }
  @Post('window') @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.openCreativeWindow)
  async window(@Req() req: HonRequest, @Param('schoolId') schoolId: string, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    assertEmptyBody(body);
    return { data: await this.wallet.openWindow(subject(req), schoolId, key) };
  }
  @Post('top-up-purchases') @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.createCreativeTopupPurchase)
  async purchase(@Req() req: HonRequest, @Param('schoolId') schoolId: string, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    return { data: await this.wallet.createTopupPurchase(subject(req), schoolId, body, key) };
  }
}
