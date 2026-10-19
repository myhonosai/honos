import { Controller, ForbiddenException, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { SaasReadGuard, SaasReadQuery } from '../saas-billing/saas-billing.guards.js';
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
