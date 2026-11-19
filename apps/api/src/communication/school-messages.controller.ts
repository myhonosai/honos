import { BadRequestException, ConflictException, Controller, ForbiddenException, Get, Header, Headers, Injectable, Param, ParseUUIDPipe, Query, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { SCHOOL_MESSAGE_HISTORY_READ_COMMAND, SCHOOL_OPTED_OUT_READ_COMMAND } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import type { MembershipLifecycleContext } from '../billing/membership.service.js';
import { MembershipActivationHumanUiGuard } from '../billing/membership-activation-human-ui.guard.js';
import { SchoolMessagesService } from './school-messages.service.js';

/** 0572: each list read is its own same-origin browser command; GET only. */
@Injectable()
export class SchoolMessageHistoryReadGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = SCHOOL_MESSAGE_HISTORY_READ_COMMAND;
}
@Injectable()
export class SchoolOptedOutReadGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = SCHOOL_OPTED_OUT_READ_COMMAND;
}

/** Plain query strings only; anything else, or a repeated key, is refused. beforeAt and beforeId come together. */
export function listQuery(query: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(query ?? {})) {
    if ((!keys.includes(key) && key !== 'beforeAt' && key !== 'beforeId') || typeof value !== 'string') throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    if (keys.includes(key)) out[key] = value;
  }
  const at = query?.beforeAt, id = query?.beforeId;
  if ((at === undefined) !== (id === undefined)) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
  if (at !== undefined) out.before = { at, id };
  return out;
}

/**
 * The school's message History and Opted out lists (Texts and Email pages). Route identifiers are never authority: the guarded
 * boundary resolves the scope from the verified session with the needed permission, and every database call re-proves it.
 */
@Controller('organizations/:organizationId/schools/:schoolId/communications')
@UseGuards(HonIdentityGuard)
export class SchoolMessagesController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly messages: SchoolMessagesService) {}

  @Get('history')
  @UseGuards(SchoolMessageHistoryReadGuard)
  @Header('Cache-Control', 'private, no-store')
  async history(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Query() query: Record<string, unknown>, @Headers('idempotency-key') key: string | undefined, @Req() request: HonRequest) {
    if (key !== undefined) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
    const input = listQuery(query, ['channel', 'outcome', 'origin', 'range', 'search']);
    const context = await this.context(request, organizationId, schoolId, 'communication.message.read');
    return { data: await this.messages.history(context, input), meta: { requestId: context.requestId } };
  }

  @Get('opted-out')
  @UseGuards(SchoolOptedOutReadGuard)
  @Header('Cache-Control', 'private, no-store')
  async optedOut(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Query() query: Record<string, unknown>, @Headers('idempotency-key') key: string | undefined, @Req() request: HonRequest) {
    if (key !== undefined) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
    const input = listQuery(query, ['channel', 'search']);
    const context = await this.context(request, organizationId, schoolId, 'communication.consent.read');
    return { data: await this.messages.optedOut(context, input), meta: { requestId: context.requestId } };
  }

  private async context(request: HonRequest, organizationId: string, schoolId: string, permission: string): Promise<MembershipLifecycleContext> {
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException({ code: 'IDENTITY_REQUIRED' });
    const scope = await this.database.resolveAuthorizedScope(identity.externalSubject, schoolId, permission);
    if (!scope || scope.organizationId.toLowerCase() !== organizationId.toLowerCase() || scope.schoolId.toLowerCase() !== schoolId.toLowerCase()) {
      throw new ForbiddenException({ code: 'SCHOOL_MESSAGES_FORBIDDEN' });
    }
    const requestId = randomUUID();
    return { ...scope, principalType: 'HUMAN_USER', requestId, correlationId: requestId, idempotencyKey: '', source: 'HUMAN_UI', externalSubject: identity.externalSubject };
  }
}
