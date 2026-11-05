import { Body, Controller, ForbiddenException, Headers, HttpCode, HttpStatus, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { ProvisionOrganizationDto } from './provision-organization.dto.js';
import { HqOnboardingService } from './hq-onboarding.service.js';
import { HQ_EXPECTED_PRINCIPAL_HEADER, HqSchoolProvisioningHumanGuard } from './hq-school-provisioning-human.guard.js';

@Controller('hq/organizations')
export class HqOnboardingController {
  constructor(
    private readonly database: RuntimeDatabaseService,
    private readonly onboarding: HqOnboardingService,
  ) {}

  /** Authority (HQ owner or hq.onboarding.manage) and the expected-principal binding are decided again in the database. */
  @Post()
  @UseGuards(HqSchoolProvisioningHumanGuard, HonIdentityGuard)
  @HttpCode(HttpStatus.CREATED)
  async provision(
    @Headers('idempotency-key') idempotencyKey: string,
    @Headers(HQ_EXPECTED_PRINCIPAL_HEADER) expectedPrincipalId: string,
    @Body() input: ProvisionOrganizationDto,
    @Req() request: HonRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException({ code: 'HUMAN_UI_REQUIRED' });
    if (!await this.database.resolveHqOperatorScope(identity.externalSubject, 'hq.onboarding.manage')) {
      throw new ForbiddenException({ code: 'HQ_PROVISIONING_FORBIDDEN' });
    }
    const result = await this.onboarding.provisionInitialSchool(identity, { ...input, idempotencyKey, expectedPrincipalId });
    response.status(result.replayed ? HttpStatus.OK : HttpStatus.CREATED);
    return { data: result, meta: { replayed: result.replayed } };
  }
}
