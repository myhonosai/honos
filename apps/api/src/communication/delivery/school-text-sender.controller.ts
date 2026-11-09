import {
  BadRequestException, Body, ConflictException, Controller, ForbiddenException, HttpCode, NotFoundException, Param, Post, Req,
  ServiceUnavailableException, UseGuards,
} from '@nestjs/common';
import { SAAS_COMMANDS } from '@hon/contracts';
import { HonIdentityGuard } from '../../foundation/hon-identity.guard.js';
import type { HonRequest } from '../../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../../foundation/runtime-database.service.js';
import { SaasCommandGuard, SaasCommandName } from '../../saas-billing/saas-billing.guards.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const E164 = /^\+[1-9][0-9]{7,14}$/;
const SERVICE_SID = /^MG[0-9a-f]{32}$/;

export interface SchoolTextSenderInput { phoneE164: string; messagingServiceSid: string; status: 'ACTIVE' | 'DISABLED'; expectedVersion?: number }

export function validateSchoolTextSenderInput(body: unknown): SchoolTextSenderInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException({ code: 'INVALID_SAAS_INPUT' });
  const input = body as Record<string, unknown>;
  const keys = Object.keys(input);
  if (keys.some((key) => !['phoneE164', 'messagingServiceSid', 'status', 'expectedVersion'].includes(key))
    || typeof input.phoneE164 !== 'string' || !E164.test(input.phoneE164)
    || typeof input.messagingServiceSid !== 'string' || !SERVICE_SID.test(input.messagingServiceSid)
    || (input.status !== 'ACTIVE' && input.status !== 'DISABLED')
    || (input.expectedVersion !== undefined && (!Number.isSafeInteger(input.expectedVersion) || (input.expectedVersion as number) < 1))) {
    throw new BadRequestException({ code: 'INVALID_SAAS_INPUT' });
  }
  return { phoneE164: input.phoneE164, messagingServiceSid: input.messagingServiceSid, status: input.status,
    ...(input.expectedVersion === undefined ? {} : { expectedVersion: input.expectedVersion as number }) };
}

/**
 * 0248: a human HON HQ owner records which Twilio Messaging Service and number a school texts from, or
 * disables it. Recording a number buys nothing and sends nothing; texts stay held until it is ACTIVE.
 */
@Controller('hq/saas/schools/:schoolId/text-sender')
@UseGuards(HonIdentityGuard)
export class SchoolTextSenderHqController {
  constructor(private readonly database: RuntimeDatabaseService) {}

  @Post() @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.setSchoolTextSender)
  async set(@Req() req: HonRequest, @Param('schoolId') schoolId: string, @Body() body: unknown) {
    if (!req.honIdentity) throw new ForbiddenException({ code: 'SAAS_FORBIDDEN' });
    if (!UUID.test(schoolId)) throw new BadRequestException({ code: 'INVALID_SAAS_INPUT' });
    const input = validateSchoolTextSenderInput(body);
    try {
      const data = await this.database.callSaasBilling('setSchoolTextSender', [req.honIdentity.externalSubject, schoolId, input.phoneE164,
        input.messagingServiceSid, input.status, input.expectedVersion === undefined ? null : String(input.expectedVersion)]);
      return { data };
    } catch (error) {
      const code = (error as { code?: string })?.code;
      if (code === '42501') throw new ForbiddenException({ code: 'SAAS_FORBIDDEN' });
      if (code === 'P0002') throw new NotFoundException({ code: 'HQ_SCHOOL_NOT_FOUND' });
      if (code === '40001') throw new ConflictException({ code: 'VERSION_CONFLICT' });
      if (code === '23505') throw new ConflictException({ code: 'TEXT_NUMBER_IN_USE' });
      if (code === '22023' || code === '23514') throw new BadRequestException({ code: 'INVALID_SAAS_INPUT' });
      throw new ServiceUnavailableException({ code: 'SAAS_UNAVAILABLE' });
    }
  }
}
