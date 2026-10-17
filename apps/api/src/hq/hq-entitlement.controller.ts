import { Body, Controller, ForbiddenException, Headers, Param, Patch, Req, UseGuards } from '@nestjs/common';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { HqEntitlementHumanUiGuard, assertHqEntitlementHumanRequest } from './hq-entitlement.dto.js';
import { HqEntitlementService } from './hq-entitlement.service.js';

@Controller('hq/organizations')
@UseGuards(HonIdentityGuard, HqEntitlementHumanUiGuard)
export class HqEntitlementController {
  constructor(private readonly entitlements: HqEntitlementService) {}
  @Patch(':organizationId/entitlement')
  async transition(@Req() request: HonRequest, @Param('organizationId') organizationId: string,
    @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    assertHqEntitlementHumanRequest(request);
    if (!request.honIdentity) throw new ForbiddenException({ code: 'HQ_ENTITLEMENT_FORBIDDEN' });
    return { data: await this.entitlements.transition(request.honIdentity.externalSubject,organizationId,body,key) };
  }
}
