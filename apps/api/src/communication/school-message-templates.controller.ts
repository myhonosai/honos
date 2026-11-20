import { Allow } from 'class-validator';
import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Header, Headers, HttpCode, HttpStatus, Injectable, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { SCHOOL_TEMPLATE_SAVE_COMMAND, SCHOOL_TEMPLATE_STATUS_COMMAND, SCHOOL_TEMPLATES_READ_COMMAND } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import type { MembershipLifecycleContext } from '../billing/membership.service.js';
import { MembershipActivationHumanUiGuard } from '../billing/membership-activation-human-ui.guard.js';
import { SchoolMessageTemplatesService } from './school-message-templates.service.js';

/** 0586: the list is a GET; save and archive/restore are their own same-origin browser commands. */
@Injectable()
export class SchoolTemplatesReadGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = SCHOOL_TEMPLATES_READ_COMMAND;
}
@Injectable()
export class SchoolTemplateSaveGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = SCHOOL_TEMPLATE_SAVE_COMMAND;
}
@Injectable()
export class SchoolTemplateStatusGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = SCHOOL_TEMPLATE_STATUS_COMMAND;
}

/** Every field is closed-validated by the shared contract validator in the service. */
export class SaveSchoolTemplateDto {
  @Allow() templateId?: unknown;
  @Allow() expectedVersion?: unknown;
  @Allow() channel?: unknown;
  @Allow() name?: unknown;
  @Allow() subject?: unknown;
  @Allow() body?: unknown;
}
export class SetSchoolTemplateStatusDto {
  @Allow() expectedVersion?: unknown;
  @Allow() status?: unknown;
}

function definedFields(input: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input ?? {}).filter(([, value]) => value !== undefined));
}

/**
 * The school's text and email templates (Texts and Email pages). Route identifiers are never authority: the guarded boundary
 * resolves the scope from the verified session with the needed permission, and every database call re-proves it.
 */
@Controller('organizations/:organizationId/schools/:schoolId/communications/templates')
@UseGuards(HonIdentityGuard)
export class SchoolMessageTemplatesController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly templates: SchoolMessageTemplatesService) {}

  @Get()
  @UseGuards(SchoolTemplatesReadGuard)
  @Header('Cache-Control', 'private, no-store')
  async list(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Query() query: Record<string, unknown>, @Headers('idempotency-key') key: string | undefined, @Req() request: HonRequest) {
    if (key !== undefined) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
    const input: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(query ?? {})) {
      if (!['channel', 'status'].includes(name) || typeof value !== 'string') throw new BadRequestException({ code: 'VALIDATION_FAILED' });
      input[name] = value;
    }
    const context = await this.context(request, organizationId, schoolId, '', 'communication.template.read');
    return { data: await this.templates.list(context, input), meta: { requestId: context.requestId } };
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @UseGuards(SchoolTemplateSaveGuard)
  @Header('Cache-Control', 'private, no-store')
  async save(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Headers('idempotency-key') key: string | undefined, @Body() body: SaveSchoolTemplateDto, @Req() request: HonRequest) {
    const context = await this.context(request, organizationId, schoolId, this.key(request, key), 'communication.template.manage');
    const result = await this.templates.save(context, definedFields(body));
    return { data: result.template, meta: { requestId: context.requestId, correlationId: context.correlationId, replayed: result.replayed } };
  }

  @Post(':templateId/status')
  @HttpCode(HttpStatus.OK)
  @UseGuards(SchoolTemplateStatusGuard)
  @Header('Cache-Control', 'private, no-store')
  async setStatus(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('templateId', new ParseUUIDPipe()) templateId: string, @Headers('idempotency-key') key: string | undefined,
    @Body() body: SetSchoolTemplateStatusDto, @Req() request: HonRequest) {
    const context = await this.context(request, organizationId, schoolId, this.key(request, key), 'communication.template.manage');
    const result = await this.templates.setStatus(context, { ...definedFields(body), templateId: templateId.toLowerCase() });
    return { data: result.template, meta: { requestId: context.requestId, correlationId: context.correlationId, replayed: result.replayed } };
  }

  private key(request: HonRequest, key: string | undefined): string {
    if (Object.keys(request.query ?? {}).length) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    const trimmed = key?.trim();
    if (!trimmed || trimmed !== key || trimmed.length > 200) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'A unique Idempotency-Key header is required.' });
    return trimmed;
  }

  private async context(request: HonRequest, organizationId: string, schoolId: string, idempotencyKey: string, permission: string): Promise<MembershipLifecycleContext> {
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException({ code: 'IDENTITY_REQUIRED' });
    const scope = await this.database.resolveAuthorizedScope(identity.externalSubject, schoolId, permission);
    if (!scope || scope.organizationId.toLowerCase() !== organizationId.toLowerCase() || scope.schoolId.toLowerCase() !== schoolId.toLowerCase()) {
      throw new ForbiddenException({ code: 'MESSAGE_TEMPLATE_FORBIDDEN' });
    }
    const requestId = randomUUID();
    return { ...scope, principalType: 'HUMAN_USER', requestId, correlationId: requestId, idempotencyKey, source: 'HUMAN_UI', externalSubject: identity.externalSubject };
  }
}
