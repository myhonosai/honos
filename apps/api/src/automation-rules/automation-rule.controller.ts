import { Body, Controller, ForbiddenException, Get, Header, Headers, HttpCode, Param, ParseIntPipe, Post, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AutomationRuleContext, AutomationRulePermission } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { AutomationRuleService, automationUuid } from './automation-rule.service.js';
import { AutomationRuleDto, AutomationDryRunDto, AutomationRuleHumanUiGuard } from './automation-rule.dto.js';
@Controller('staff/automation/rules')
@UseGuards(HonIdentityGuard, AutomationRuleHumanUiGuard)
export class AutomationRuleController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly rules: AutomationRuleService) {}
  private async context(req: HonRequest, permission: AutomationRulePermission, key = ''): Promise<AutomationRuleContext> {
    if (!req.honIdentity) throw new ForbiddenException({ code: 'IDENTITY_REQUIRED' });
    const subject = req.honIdentity.externalSubject;
    const scope = await this.database.resolveAutomationRuleScope(subject, permission);
    if (!scope) throw new ForbiddenException({ code: 'STAFF_SCOPE_DENIED' });
    const id = randomUUID();
    return { ...scope, externalSubject: subject, principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: id, correlationId: id, idempotencyKey: key };
  }
  private envelope<T>(c: AutomationRuleContext, data: T, replayed = false) { return { data, meta: { requestId: c.requestId, correlationId: c.correlationId, replayed } }; }
  @Header('Cache-Control', 'private, no-store') @Get()
  async list(@Req() req: HonRequest) { const c = await this.context(req, 'automation.rule.read'); return this.envelope(c, await this.rules.list(c)); }
  @Header('Cache-Control', 'private, no-store') @Get(':id')
  async read(@Param('id') id: string, @Req() req: HonRequest) { automationUuid(id); const c = await this.context(req, 'automation.rule.read'); return this.envelope(c, await this.rules.read(c, id)); }
  @Header('Cache-Control', 'private, no-store') @Get(':id/versions/:version')
  async saved(@Param('id') id: string, @Param('version', new ParseIntPipe()) version: number, @Req() req: HonRequest) { automationUuid(id); const c = await this.context(req, 'automation.rule.read'); return this.envelope(c, await this.rules.read(c, id, version)); }
  @Header('Cache-Control', 'private, no-store') @Post() @HttpCode(200)
  async create(@Headers('idempotency-key') key: string | undefined, @Body() input: AutomationRuleDto, @Req() req: HonRequest) { const c = await this.context(req, 'automation.rule.manage', key ?? ''); const r = await this.rules.save(c, null, input); return this.envelope(c, r.rule, r.replayed); }
  @Header('Cache-Control', 'private, no-store') @Post(':id/versions') @HttpCode(200)
  async revise(@Param('id') id: string, @Headers('idempotency-key') key: string | undefined, @Body() input: AutomationRuleDto, @Req() req: HonRequest) { automationUuid(id); const c = await this.context(req, 'automation.rule.manage', key ?? ''); const r = await this.rules.save(c, id, input); return this.envelope(c, r.rule, r.replayed); }
  @Header('Cache-Control', 'private, no-store') @Post(':id/dry-run') @HttpCode(200)
  async dryRun(@Param('id') id: string, @Body() input: AutomationDryRunDto, @Req() req: HonRequest) { automationUuid(id); const c = await this.context(req, 'automation.rule.dry_run'); return this.envelope(c, await this.rules.dryRun(c, id, input)); }
}
