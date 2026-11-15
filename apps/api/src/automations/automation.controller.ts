import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Header, Headers, HttpCode, HttpStatus, Param, ParseIntPipe, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import {
  AutomationArchiveHumanUiGuard, AutomationCreateHumanUiGuard, AutomationReadHumanUiGuard, AutomationRestoreHumanUiGuard, AutomationSaveHumanUiGuard,
  ContactTagAddHumanUiGuard, ContactTagLookupHumanUiGuard, ContactTagRemoveHumanUiGuard,
} from './automation.guard.js';
import { AutomationService, type AutomationContext } from './automation.service.js';

type Permission = 'automation.workflow.read' | 'automation.workflow.manage' | 'contact.tag.read' | 'contact.tag.manage';

/** Shared scope resolution: route ids are never authority; the verified session decides and the database re-proves it. */
abstract class AutomationScope {
  constructor(protected readonly database: RuntimeDatabaseService, protected readonly automations: AutomationService) {}

  protected key(idempotencyKey: string | undefined): string {
    if (!idempotencyKey || idempotencyKey.length > 200 || idempotencyKey.trim() !== idempotencyKey) throw new BadRequestException({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
    return idempotencyKey;
  }
  protected noKey(idempotencyKey: string | undefined): '' {
    if (idempotencyKey !== undefined) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
    return '';
  }
  protected async context(request: HonRequest, organizationId: string, schoolId: string, permission: Permission, idempotencyKey: string): Promise<AutomationContext> {
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException('HON identity context is missing.');
    if (Object.keys(request.query ?? {}).length) throw new BadRequestException({ code: 'AUTOMATION_INVALID' });
    const scope = await this.database.resolveAuthorizedScope(identity.externalSubject, schoolId, permission);
    if (!scope || scope.organizationId !== organizationId || scope.schoolId !== schoolId) throw new ForbiddenException({ code: 'AUTOMATION_FORBIDDEN' });
    const requestId = randomUUID();
    return { ...scope, principalType: 'HUMAN_USER', requestId, correlationId: requestId, idempotencyKey, source: 'HUMAN_UI', externalSubject: identity.externalSubject };
  }
  protected meta(context: AutomationContext, replayed?: boolean) {
    return { requestId: context.requestId, correlationId: context.correlationId, ...(replayed === undefined ? {} : { replayed }) };
  }
}

/** Automation workflow definitions (0367): list, read, create, save a version, restore a version, archive a draft. Nothing runs. */
@Controller('organizations/:organizationId/schools/:schoolId/automations')
@UseGuards(HonIdentityGuard)
export class AutomationWorkflowController extends AutomationScope {
  constructor(database: RuntimeDatabaseService, automations: AutomationService) { super(database, automations); }

  @Get()
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @UseGuards(AutomationReadHumanUiGuard)
  async list(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Headers('idempotency-key') key: string | undefined, @Req() request: HonRequest) {
    const context = await this.context(request, organizationId, schoolId, 'automation.workflow.read', this.noKey(key));
    return { data: await this.automations.listWorkflows(context), meta: this.meta(context) };
  }

  @Get(':workflowId')
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @UseGuards(AutomationReadHumanUiGuard)
  async detail(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('workflowId', new ParseUUIDPipe()) workflowId: string, @Headers('idempotency-key') key: string | undefined, @Req() request: HonRequest) {
    const context = await this.context(request, organizationId, schoolId, 'automation.workflow.read', this.noKey(key));
    return { data: await this.automations.getWorkflow(context, workflowId), meta: this.meta(context) };
  }

  @Get(':workflowId/versions/:version')
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @UseGuards(AutomationReadHumanUiGuard)
  async version(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('workflowId', new ParseUUIDPipe()) workflowId: string, @Param('version', new ParseIntPipe()) version: number,
    @Headers('idempotency-key') key: string | undefined, @Req() request: HonRequest) {
    if (!Number.isInteger(version) || version < 1 || version > 500) throw new BadRequestException({ code: 'AUTOMATION_INVALID' });
    const context = await this.context(request, organizationId, schoolId, 'automation.workflow.read', this.noKey(key));
    return { data: await this.automations.getVersion(context, workflowId, version), meta: this.meta(context) };
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @UseGuards(AutomationCreateHumanUiGuard)
  async create(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Headers('idempotency-key') key: string | undefined, @Body() input: unknown, @Req() request: HonRequest) {
    const context = await this.context(request, organizationId, schoolId, 'automation.workflow.manage', this.key(key));
    const result = await this.automations.create(context, input);
    return { data: result.record, meta: this.meta(context, result.replayed) };
  }

  @Post(':workflowId/versions')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @UseGuards(AutomationSaveHumanUiGuard)
  async save(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('workflowId', new ParseUUIDPipe()) workflowId: string, @Headers('idempotency-key') key: string | undefined, @Body() input: unknown, @Req() request: HonRequest) {
    const context = await this.context(request, organizationId, schoolId, 'automation.workflow.manage', this.key(key));
    const result = await this.automations.save(context, workflowId, input);
    return { data: result.record, meta: this.meta(context, result.replayed) };
  }

  @Post(':workflowId/restore')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @UseGuards(AutomationRestoreHumanUiGuard)
  async restore(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('workflowId', new ParseUUIDPipe()) workflowId: string, @Headers('idempotency-key') key: string | undefined, @Body() input: unknown, @Req() request: HonRequest) {
    const context = await this.context(request, organizationId, schoolId, 'automation.workflow.manage', this.key(key));
    const result = await this.automations.restore(context, workflowId, input);
    return { data: result.record, meta: this.meta(context, result.replayed) };
  }

  @Post(':workflowId/archive')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @UseGuards(AutomationArchiveHumanUiGuard)
  async archive(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('workflowId', new ParseUUIDPipe()) workflowId: string, @Headers('idempotency-key') key: string | undefined, @Body() input: unknown, @Req() request: HonRequest) {
    const context = await this.context(request, organizationId, schoolId, 'automation.workflow.manage', this.key(key));
    const result = await this.automations.archive(context, workflowId, input);
    return { data: result.record, meta: this.meta(context, result.replayed) };
  }
}

/** Contact tags (0367), the one tags model shared by the contact list and Automation. */
@Controller('organizations/:organizationId/schools/:schoolId')
@UseGuards(HonIdentityGuard)
export class ContactTagController extends AutomationScope {
  constructor(database: RuntimeDatabaseService, automations: AutomationService) { super(database, automations); }

  @Get('contact-tags')
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @UseGuards(AutomationReadHumanUiGuard)
  async school(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Headers('idempotency-key') key: string | undefined, @Req() request: HonRequest) {
    const context = await this.context(request, organizationId, schoolId, 'contact.tag.read', this.noKey(key));
    return { data: await this.automations.schoolTags(context), meta: this.meta(context) };
  }

  @Post('contact-tags/lookup')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @UseGuards(ContactTagLookupHumanUiGuard)
  async lookup(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Headers('idempotency-key') key: string | undefined, @Body() input: unknown, @Req() request: HonRequest) {
    const context = await this.context(request, organizationId, schoolId, 'contact.tag.read', this.noKey(key));
    return { data: await this.automations.lookupTags(context, input), meta: this.meta(context) };
  }

  @Get('people/:personId/tags')
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @UseGuards(AutomationReadHumanUiGuard)
  async person(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('personId', new ParseUUIDPipe()) personId: string, @Headers('idempotency-key') key: string | undefined, @Req() request: HonRequest) {
    const context = await this.context(request, organizationId, schoolId, 'contact.tag.read', this.noKey(key));
    return { data: await this.automations.personTags(context, personId), meta: this.meta(context) };
  }

  @Post('people/:personId/tags')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @UseGuards(ContactTagAddHumanUiGuard)
  async add(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('personId', new ParseUUIDPipe()) personId: string, @Headers('idempotency-key') key: string | undefined, @Body() input: unknown, @Req() request: HonRequest) {
    const context = await this.context(request, organizationId, schoolId, 'contact.tag.manage', this.key(key));
    const result = await this.automations.addTag(context, personId, input);
    return { data: result.record, meta: this.meta(context, result.replayed) };
  }

  @Post('people/:personId/tags/remove')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @UseGuards(ContactTagRemoveHumanUiGuard)
  async remove(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('personId', new ParseUUIDPipe()) personId: string, @Headers('idempotency-key') key: string | undefined, @Body() input: unknown, @Req() request: HonRequest) {
    const context = await this.context(request, organizationId, schoolId, 'contact.tag.manage', this.key(key));
    const result = await this.automations.removeTag(context, personId, input);
    return { data: result.record, meta: this.meta(context, result.replayed) };
  }
}
