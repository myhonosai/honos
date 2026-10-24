import { Body, Controller, ForbiddenException, Get, Headers, HttpCode, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { SAAS_COMMANDS } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { SaasCommandGuard, SaasCommandName, SaasReadGuard, SaasReadQuery } from '../saas-billing/saas-billing.guards.js';
import { SaasSchoolBillingService } from './saas-school-billing.service.js';

function subject(req: HonRequest): string {
  if (!req.honIdentity) throw new ForbiddenException({ code: 'SAAS_FORBIDDEN' });
  return req.honIdentity.externalSubject;
}

/**
 * A school's own HON subscription billing (organization-level), read-only, for staff holding
 * billing.hon.view at the exact school. Never HQ financial permissions; never school-to-family billing.
 */
@Controller('schools/:schoolId/hon-billing')
@UseGuards(HonIdentityGuard)
export class SaasSchoolBillingController {
  constructor(private readonly reads: SaasSchoolBillingService) {}
  @Get() @UseGuards(SaasReadGuard)
  async account(@Req() req: HonRequest, @Param('schoolId') schoolId: string) {
    return { data: await this.reads.readAccount(subject(req), schoolId) };
  }
  @Get('invoices') @UseGuards(SaasReadGuard) @SaasReadQuery(['status','kind','cursor','limit'])
  async invoices(@Req() req: HonRequest, @Param('schoolId') schoolId: string, @Query() query: Record<string, unknown>) {
    return { data: await this.reads.readInvoices(subject(req), schoolId, query) };
  }
  @Get('invoices/:invoiceId') @UseGuards(SaasReadGuard)
  async invoice(@Req() req: HonRequest, @Param('schoolId') schoolId: string, @Param('invoiceId') invoiceId: string) {
    return { data: await this.reads.readInvoice(subject(req), schoolId, invoiceId) };
  }
}

/** HQ dry run of the PROPOSED paid-access terms for one organization. Enforcement NONE. */
@Controller('hq/saas/access')
@UseGuards(HonIdentityGuard)
export class SaasAccessReadinessHqController {
  constructor(private readonly reads: SaasSchoolBillingService) {}
  @Get(':organizationId') @UseGuards(SaasReadGuard)
  async readiness(@Req() req: HonRequest, @Param('organizationId') organizationId: string) {
    return { data: await this.reads.readAccessReadiness(subject(req), organizationId) };
  }
}

/**
 * B6A central access authority (HQ) and the inactive first-payment pathway. Placing an organization awaiting
 * its first payment and retrying a held activation are HQ-owner commands the database refuses while the
 * paid-access program is INACTIVE. Activation itself happens only inside the verified-payment transaction.
 */
@Controller('hq/saas/organizations/:organizationId/access')
@UseGuards(HonIdentityGuard)
export class SaasOrganizationAccessHqController {
  constructor(private readonly reads: SaasSchoolBillingService) {}
  @Get() @UseGuards(SaasReadGuard)
  async access(@Req() req: HonRequest, @Param('organizationId') organizationId: string) {
    return { data: await this.reads.readOrganizationAccess(subject(req), organizationId) };
  }
  @Post('await-first-payment') @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.awaitFirstPayment)
  async awaitFirstPayment(@Req() req: HonRequest, @Param('organizationId') organizationId: string, @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined) {
    return { data: await this.reads.awaitFirstPayment(subject(req), organizationId, body, key) };
  }
}

/** HQ-owner recovery of a first-payment activation held for review (refused while the program is INACTIVE). */
@Controller('hq/saas/payments/checkouts/:checkoutId/access-retry')
@UseGuards(HonIdentityGuard)
export class SaasAccessRetryHqController {
  constructor(private readonly reads: SaasSchoolBillingService) {}
  @Post() @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.retryFirstPaymentActivation)
  async retry(@Req() req: HonRequest, @Param('checkoutId') checkoutId: string, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    return { data: await this.reads.retryFirstPaymentActivation(subject(req), checkoutId, body, key) };
  }
}

/**
 * D9 HQ-owner access exceptions: time-limited free access for internal testing, product demonstrations and approved
 * pilots. Granting and revoking are HQ-owner commands; HQ billing staff may read and close lapsed exceptions. The
 * database refuses everyone else, an organization with access, a subscription or an unresolved checkout, and any
 * window over the policy maximum. An exception never carries AI credits and is never a purchase basis.
 */
@Controller('hq/saas/organizations/:organizationId/access-exceptions')
@UseGuards(HonIdentityGuard)
export class SaasAccessExceptionsHqController {
  constructor(private readonly reads: SaasSchoolBillingService) {}
  @Get() @UseGuards(SaasReadGuard)
  async list(@Req() req: HonRequest, @Param('organizationId') organizationId: string) {
    return { data: await this.reads.readAccessExceptions(subject(req), organizationId) };
  }
  @Post() @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.grantAccessException)
  async grant(@Req() req: HonRequest, @Param('organizationId') organizationId: string, @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined) {
    return { data: await this.reads.grantAccessException(subject(req), organizationId, body, key) };
  }
}

@Controller('hq/saas/access-exceptions')
@UseGuards(HonIdentityGuard)
export class SaasAccessExceptionCommandsHqController {
  constructor(private readonly reads: SaasSchoolBillingService) {}
  @Post('close-expired') @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.closeExpiredAccessExceptions)
  async closeExpired(@Req() req: HonRequest, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    return { data: await this.reads.closeExpiredAccessExceptions(subject(req), body, key) };
  }
  @Post(':exceptionId/revoke') @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.revokeAccessException)
  async revoke(@Req() req: HonRequest, @Param('exceptionId') exceptionId: string, @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined) {
    return { data: await this.reads.revokeAccessException(subject(req), exceptionId, body, key) };
  }
}
