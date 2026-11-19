import {
  BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Header, Headers, HttpCode, Injectable, Param, ParseUUIDPipe,
  Post, Query, Req, Res, UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { randomUUID } from 'node:crypto';
import {
  SCHOOL_CALL_DO_NOT_CALL_COMMAND, SCHOOL_CALL_READ_COMMAND, SCHOOL_CALL_RING_COMMAND, SCHOOL_CALL_SETTINGS_COMMAND, SCHOOL_CALL_START_COMMAND,
  SCHOOL_CALL_TOKEN_COMMAND, SCHOOL_CALL_UPDATE_COMMAND,
} from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import type { MembershipLifecycleContext } from '../billing/membership.service.js';
import { MembershipActivationHumanUiGuard } from '../billing/membership-activation-human-ui.guard.js';
import { SchoolCallsService } from './school-calls.service.js';

/** 0556: each calling call is its own same-origin browser command; reads are GET only. */
@Injectable()
export class SchoolCallReadGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = SCHOOL_CALL_READ_COMMAND;
}
@Injectable()
export class SchoolCallSettingsGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = SCHOOL_CALL_SETTINGS_COMMAND;
}
@Injectable()
export class SchoolCallRingGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = SCHOOL_CALL_RING_COMMAND;
}
@Injectable()
export class SchoolCallStartGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = SCHOOL_CALL_START_COMMAND;
}
@Injectable()
export class SchoolCallUpdateGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = SCHOOL_CALL_UPDATE_COMMAND;
}
@Injectable()
export class SchoolCallDoNotCallGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = SCHOOL_CALL_DO_NOT_CALL_COMMAND;
}

@Injectable()
export class SchoolCallTokenGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = SCHOOL_CALL_TOKEN_COMMAND;
}

const LIST_KEYS = new Set(['filter', 'personId', 'beforeAt', 'beforeId']);

/** The call log filters arrive as plain query strings; anything else, or a repeated key, is refused. */
export function schoolCallListQuery(query: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(query ?? {})) {
    if (!LIST_KEYS.has(key) || typeof value !== 'string') throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    if (key === 'filter' || key === 'personId') out[key] = value;
  }
  const at = query?.beforeAt, id = query?.beforeId;
  if ((at === undefined) !== (id === undefined)) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
  if (at !== undefined) out.before = { at, id };
  return out;
}

/**
 * Staff calling on the school number (0556). Route identifiers are never authority: the guarded boundary resolves the
 * scope from the verified session with communication.call.use (settings: communication.call.manage), and every
 * database call re-proves it.
 */
@Controller('organizations/:organizationId/schools/:schoolId/calls')
@UseGuards(HonIdentityGuard)
export class SchoolCallsController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly calls: SchoolCallsService) {}

  @Get('overview')
  @UseGuards(SchoolCallReadGuard)
  @Header('Cache-Control', 'private, no-store')
  async overview(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Query() query: Record<string, unknown>, @Headers('idempotency-key') key: string | undefined, @Req() request: HonRequest) {
    noQuery(request, query); noKey(key);
    const context = await this.context(request, organizationId, schoolId, 'communication.call.use', '');
    return { data: await this.calls.overview(context), meta: { requestId: context.requestId } };
  }

  @Get()
  @UseGuards(SchoolCallReadGuard)
  @Header('Cache-Control', 'private, no-store')
  async list(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Query() query: Record<string, unknown>, @Headers('idempotency-key') key: string | undefined, @Req() request: HonRequest) {
    noKey(key);
    const filters = schoolCallListQuery(query);
    const context = await this.context(request, organizationId, schoolId, 'communication.call.use', '');
    return { data: await this.calls.list(context, filters), meta: { requestId: context.requestId } };
  }

  @Post('settings')
  @HttpCode(200)
  @UseGuards(SchoolCallSettingsGuard)
  @Header('Cache-Control', 'private, no-store')
  async settings(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Query() query: Record<string, unknown>, @Headers('idempotency-key') key: string | undefined, @Body() body: unknown, @Req() request: HonRequest) {
    noQuery(request, query); noKey(key);
    const context = await this.context(request, organizationId, schoolId, 'communication.call.manage', '');
    return { data: await this.calls.setSettings(context, body), meta: { requestId: context.requestId } };
  }

  @Post('ring-me')
  @HttpCode(200)
  @UseGuards(SchoolCallRingGuard)
  @Header('Cache-Control', 'private, no-store')
  async ringMe(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Query() query: Record<string, unknown>, @Headers('idempotency-key') key: string | undefined, @Body() body: unknown, @Req() request: HonRequest) {
    noQuery(request, query); noKey(key);
    const context = await this.context(request, organizationId, schoolId, 'communication.call.use', '');
    return { data: await this.calls.setRinging(context, body), meta: { requestId: context.requestId } };
  }

  /** The browser phone's one-hour Twilio Voice token (never cached, never logged). */
  @Post('phone-token')
  @HttpCode(200)
  @UseGuards(SchoolCallTokenGuard)
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  async phoneToken(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Query() query: Record<string, unknown>, @Headers('idempotency-key') key: string | undefined, @Body() body: unknown, @Req() request: HonRequest) {
    noQuery(request, query); noKey(key);
    if (body !== undefined && (typeof body !== 'object' || body === null || Array.isArray(body) || Object.keys(body).length)) {
      throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    }
    const context = await this.context(request, organizationId, schoolId, 'communication.call.use', '');
    return { data: await this.calls.phoneToken(context), meta: { requestId: context.requestId } };
  }

  @Post('do-not-call')
  @HttpCode(200)
  @UseGuards(SchoolCallDoNotCallGuard)
  @Header('Cache-Control', 'private, no-store')
  async doNotCall(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Query() query: Record<string, unknown>, @Headers('idempotency-key') key: string | undefined, @Body() body: unknown, @Req() request: HonRequest) {
    noQuery(request, query); noKey(key);
    const context = await this.context(request, organizationId, schoolId, 'communication.call.use', '');
    return { data: await this.calls.setDoNotCall(context, body), meta: { requestId: context.requestId } };
  }

  /** Records an outgoing call and returns its id; the browser phone connects it within two minutes. */
  @Post()
  @UseGuards(SchoolCallStartGuard)
  @Header('Cache-Control', 'private, no-store')
  async start(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Query() query: Record<string, unknown>, @Headers('idempotency-key') key: string | undefined, @Body() body: unknown, @Req() request: HonRequest,
    @Res({ passthrough: true }) response: Response) {
    noQuery(request, query);
    if (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(key)) {
      throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'A unique Idempotency-Key header is required.' });
    }
    const context = await this.context(request, organizationId, schoolId, 'communication.call.use', key);
    const started = await this.calls.start(context, body);
    response.status(started.replayed ? 200 : 201);
    return { data: started, meta: { requestId: context.requestId, replayed: started.replayed } };
  }

  @Post(':callId')
  @HttpCode(200)
  @UseGuards(SchoolCallUpdateGuard)
  @Header('Cache-Control', 'private, no-store')
  async update(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('callId', new ParseUUIDPipe()) callId: string, @Query() query: Record<string, unknown>, @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown, @Req() request: HonRequest) {
    noQuery(request, query); noKey(key);
    const context = await this.context(request, organizationId, schoolId, 'communication.call.use', '');
    return { data: await this.calls.update(context, callId.toLowerCase(), body), meta: { requestId: context.requestId } };
  }

  private async context(request: HonRequest, organizationId: string, schoolId: string, permission: string, idempotencyKey: string): Promise<MembershipLifecycleContext> {
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException({ code: 'IDENTITY_REQUIRED' });
    const scope = await this.database.resolveAuthorizedScope(identity.externalSubject, schoolId, permission);
    if (!scope || scope.organizationId.toLowerCase() !== organizationId.toLowerCase() || scope.schoolId.toLowerCase() !== schoolId.toLowerCase()) {
      throw new ForbiddenException({ code: 'CALLING_FORBIDDEN' });
    }
    const requestId = randomUUID();
    return { ...scope, principalType: 'HUMAN_USER', requestId, correlationId: requestId, idempotencyKey, source: 'HUMAN_UI', externalSubject: identity.externalSubject };
  }
}

function noQuery(request: HonRequest, query: Record<string, unknown>): void {
  if (Object.keys(query ?? {}).length || request.originalUrl?.includes('?')) throw new BadRequestException({ code: 'CALL_SELECTORS_NOT_ACCEPTED' });
}
function noKey(key: string | undefined): void {
  if (key !== undefined) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
}
