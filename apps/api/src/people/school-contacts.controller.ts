import { BadRequestException, ConflictException, Controller, ForbiddenException, Get, Header, Headers, Injectable, Param, ParseUUIDPipe, Query, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { MembershipActivationHumanUiGuard } from '../billing/membership-activation-human-ui.guard.js';
import { SchoolContactsService } from './school-contacts.service.js';

/** C1 (0373): the contacts list is its own same-origin browser read. */
@Injectable()
export class SchoolContactsHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'people.school-contacts';
}

const KEYS = new Set(['segment', 'query', 'rankId', 'programId', 'planId', 'endsWithinDays', 'options', 'cursor']);

/**
 * C1 (0373): contacts with segment counts and filters. Route identifiers are never authority: the scope is resolved from
 * the verified session and the database function re-proves people.read.
 */
@Controller('organizations/:organizationId/schools/:schoolId/contacts')
@UseGuards(HonIdentityGuard, SchoolContactsHumanUiGuard)
export class SchoolContactsController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly contacts: SchoolContactsService) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  async list(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined, @Query() query: Record<string, unknown>, @Req() request: HonRequest) {
    if (idempotencyKey !== undefined) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
    if (Object.keys(query ?? {}).some(key => !KEYS.has(key)) || Object.values(query ?? {}).some(value => typeof value !== 'string')) {
      throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    }
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException('HON identity context is missing.');
    const scope = await this.database.resolveAuthorizedScope(identity.externalSubject, schoolId, 'people.read');
    if (!scope || scope.organizationId.toLowerCase() !== organizationId.toLowerCase() || scope.schoolId.toLowerCase() !== schoolId.toLowerCase()) {
      throw new ForbiddenException({ code: 'SCHOOL_CONTACTS_FORBIDDEN' });
    }
    const requestId = randomUUID();
    const context = { ...scope, principalType: 'HUMAN_USER' as const, requestId, correlationId: requestId, idempotencyKey: '', source: 'HUMAN_UI' as const,
      externalSubject: identity.externalSubject };
    const { cursor, ...filters } = query as Record<string, string | undefined>;
    return { data: await this.contacts.list(context, filters, cursor), meta: { requestId, correlationId: requestId } };
  }
}
