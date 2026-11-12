import {
  BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post,
  Query, Req, ServiceUnavailableException, UseGuards,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { SAAS_COMMANDS } from '@hon/contracts';
import { HonIdentityGuard } from '../../foundation/hon-identity.guard.js';
import type { HonRequest } from '../../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../../foundation/runtime-database.service.js';
import { SaasCommandGuard, SaasCommandName } from '../../saas-billing/saas-billing.guards.js';
import { validateMissedCallSettingsInput } from './missed-call-text-back.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const E164 = /^\+[1-9][0-9]{7,14}$/;
const SERVICE_SID = /^MG[0-9a-f]{32}$/;

/** mmsConverterConfirmed: the HQ owner has turned on the Messaging Service's MMS Converter (required for ACTIVE). */
export interface SchoolTextSenderInput {
  phoneE164: string; messagingServiceSid: string; status: 'ACTIVE' | 'DISABLED'; mmsConverterConfirmed: boolean; expectedVersion?: number;
}

export function validateSchoolTextSenderInput(body: unknown): SchoolTextSenderInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException({ code: 'INVALID_SAAS_INPUT' });
  const input = body as Record<string, unknown>;
  const keys = Object.keys(input);
  if (keys.some((key) => !['phoneE164', 'messagingServiceSid', 'status', 'mmsConverterConfirmed', 'expectedVersion'].includes(key))
    || typeof input.phoneE164 !== 'string' || !E164.test(input.phoneE164)
    || typeof input.messagingServiceSid !== 'string' || !SERVICE_SID.test(input.messagingServiceSid)
    || (input.status !== 'ACTIVE' && input.status !== 'DISABLED') || typeof input.mmsConverterConfirmed !== 'boolean'
    || (input.expectedVersion !== undefined && (!Number.isSafeInteger(input.expectedVersion) || (input.expectedVersion as number) < 1))) {
    throw new BadRequestException({ code: 'INVALID_SAAS_INPUT' });
  }
  if (input.status === 'ACTIVE' && !input.mmsConverterConfirmed) throw new BadRequestException({ code: 'MMS_CONVERTER_NOT_CONFIRMED' });
  return { phoneE164: input.phoneE164, messagingServiceSid: input.messagingServiceSid, status: input.status, mmsConverterConfirmed: input.mmsConverterConfirmed,
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
        input.messagingServiceSid, input.status, String(input.mmsConverterConfirmed), input.expectedVersion === undefined ? null : String(input.expectedVersion)]);
      return { data };
    } catch (error) {
      const code = (error as { code?: string })?.code;
      if (code === '42501') throw new ForbiddenException({ code: 'SAAS_FORBIDDEN' });
      if (code === 'P0002') throw new NotFoundException({ code: 'HQ_SCHOOL_NOT_FOUND' });
      if (code === '40001') throw new ConflictException({ code: 'VERSION_CONFLICT' });
      if (code === '23505') throw new ConflictException({ code: 'TEXT_NUMBER_IN_USE' });
      if (code === '22023' && (error as { message?: string })?.message === 'MMS_CONVERTER_NOT_CONFIRMED') throw new BadRequestException({ code: 'MMS_CONVERTER_NOT_CONFIRMED' });
      if (code === '22023' || code === '23514') throw new BadRequestException({ code: 'INVALID_SAAS_INPUT' });
      throw new ServiceUnavailableException({ code: 'SAAS_UNAVAILABLE' });
    }
  }
}

/**
 * 0249: a human HON HQ owner sets the phone a school number forwards calls to, and whether an unanswered caller
 * gets one text back. Requires the school's sender to exist (0248); nothing is bought, dialed or sent here.
 */
@Controller('hq/saas/schools/:schoolId/missed-call-settings')
@UseGuards(HonIdentityGuard)
export class SchoolMissedCallHqController {
  constructor(private readonly database: RuntimeDatabaseService) {}

  @Post() @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.setSchoolMissedCallSettings)
  async set(@Req() req: HonRequest, @Param('schoolId') schoolId: string, @Body() body: unknown) {
    if (!req.honIdentity) throw new ForbiddenException({ code: 'SAAS_FORBIDDEN' });
    if (!UUID.test(schoolId)) throw new BadRequestException({ code: 'INVALID_SAAS_INPUT' });
    const input = validateMissedCallSettingsInput(body);
    try {
      const data = await this.database.callSaasBilling('setSchoolMissedCallSettings', [req.honIdentity.externalSubject, schoolId,
        input.forwardPhoneE164, String(input.textBack), String(input.expectedVersion)]);
      return { data };
    } catch (error) {
      const code = (error as { code?: string })?.code;
      if (code === '42501') throw new ForbiddenException({ code: 'SAAS_FORBIDDEN' });
      if (code === 'P0002') throw new NotFoundException({ code: 'HQ_TEXT_SENDER_NOT_FOUND' });
      if (code === '40001') throw new ConflictException({ code: 'VERSION_CONFLICT' });
      if (code === '22023' || code === '23514') throw new BadRequestException({ code: 'INVALID_SAAS_INPUT' });
      throw new ServiceUnavailableException({ code: 'SAAS_UNAVAILABLE' });
    }
  }
}

export interface MissedCallView { id: string; callerE164: string; dialStatus: string; textBack: string; receivedAt: string }

/** 0249: the school's recent missed calls to call back (communication.message.read), newest first, through the entitlement-gated definer read. */
@Controller('organizations/:organizationId/schools/:schoolId/communications/missed-calls')
@UseGuards(HonIdentityGuard)
export class SchoolMissedCallsController {
  constructor(private readonly database: RuntimeDatabaseService) {}

  @Get()
  async list(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Query('limit') limit: string | undefined,
    @Req() request: HonRequest,
  ): Promise<{ data: MissedCallView[] }> {
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException('HON identity context is missing.');
    const size = limit === undefined ? 50 : Number(limit);
    if (!Number.isSafeInteger(size) || size < 1 || size > 100) throw new BadRequestException('limit must be an integer from 1 to 100.');
    const scope = await this.database.resolveAuthorizedScope(identity.externalSubject, schoolId, 'communication.message.read');
    if (!scope || scope.organizationId !== organizationId || scope.schoolId !== schoolId) {
      throw new ForbiddenException('HON missed calls are not authorized for this school.');
    }
    const data = await this.database.withTenantTransaction({
      organizationId: scope.organizationId, schoolId: scope.schoolId, principalId: scope.principalId, principalType: 'HUMAN_USER', requestId: randomUUID(),
    }, async (client) => (await client.query<{ data: MissedCallView[] }>('SELECT hon.read_school_missed_calls($1, $2::uuid, $3) AS data',
      [identity.externalSubject, scope.schoolId, size])).rows[0]?.data ?? []).catch((error: unknown) => {
      // The definer read refuses a school whose entitlement is not in effect (B6A) or a scope revoked mid-read.
      if ((error as { code?: string } | null)?.code === '42501') throw new ForbiddenException('HON missed calls are not available for this school.');
      throw error;
    });
    return { data };
  }
}
