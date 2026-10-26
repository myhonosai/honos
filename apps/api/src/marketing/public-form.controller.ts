import { Body, Controller, ForbiddenException, Get, Header, Headers, HttpCode, Injectable, NotFoundException, Param, ParseUUIDPipe, Post, Req, Res, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import type { PublicFormContext, PublicFormPermission } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { CampaignHumanUiGuard } from './campaign-human-ui.guard.js';
import { PublicFormService } from './public-form.service.js';
@Injectable()
export class PublicFormHumanUiGuard extends CampaignHumanUiGuard { protected readonly command: string = 'public-lead-form'; }
@Controller('marketing/forms')
@UseGuards(HonIdentityGuard, PublicFormHumanUiGuard)
export class StaffPublicFormController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly forms: PublicFormService) {}
  private async context(req: HonRequest, permission: PublicFormPermission, key = ''): Promise<PublicFormContext> {
    if (!req.honIdentity) throw new ForbiddenException({ code: 'FORM_FORBIDDEN' });
    const scope = await this.database.resolvePublicFormScope(req.honIdentity.externalSubject, permission);
    if (!scope) throw new ForbiddenException({ code: 'FORM_FORBIDDEN' });
    const id = randomUUID();
    return { ...scope, externalSubject: req.honIdentity.externalSubject, principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: id, correlationId: id, idempotencyKey: key };
  }
  @Get('intake-monitor') @Header('Cache-Control', 'private, no-store')
  async intakeMonitor(@Req() req: HonRequest) { const c = await this.context(req, 'marketing.form.read'); return { data: await this.forms.intakeMonitor(c) }; }
  @Get() @Header('Cache-Control', 'private, no-store')
  async list(@Req() req: HonRequest) { const c = await this.context(req, 'marketing.form.read'); return { data: await this.forms.list(c) }; }
  @Post() @HttpCode(200) @Header('Cache-Control', 'private, no-store')
  async create(@Req() req: HonRequest, @Headers('idempotency-key') key: string, @Body() input: unknown) {
    const c = await this.context(req, 'marketing.form.configure', key); const r = await this.forms.mutate(c,'configure',null,input); return { data: r.form, meta: { replayed: r.replayed } };
  }
  @Post(':formId/configuration') @HttpCode(200) @Header('Cache-Control', 'private, no-store')
  async configure(@Param('formId',new ParseUUIDPipe()) id: string, @Req() req: HonRequest, @Headers('idempotency-key') key: string, @Body() input: unknown) {
    const c = await this.context(req, 'marketing.form.configure', key); const r = await this.forms.mutate(c,'configure',id,input); return { data: r.form, meta: { replayed: r.replayed } };
  }
  @Post(':formId/publish') @HttpCode(200) @Header('Cache-Control', 'private, no-store')
  async publish(@Param('formId',new ParseUUIDPipe()) id: string, @Req() req: HonRequest, @Headers('idempotency-key') key: string, @Body() input: unknown) {
    const c = await this.context(req, 'marketing.form.publish', key); const r = await this.forms.mutate(c,'publish',id,input); return { data: r.form, meta: { replayed: r.replayed } };
  }
  @Post(':formId/disable') @HttpCode(200) @Header('Cache-Control', 'private, no-store')
  async disable(@Param('formId',new ParseUUIDPipe()) id: string, @Req() req: HonRequest, @Headers('idempotency-key') key: string, @Body() input: unknown) {
    const c = await this.context(req, 'marketing.form.disable', key); const r = await this.forms.mutate(c,'disable',id,input); return { data: r.form, meta: { replayed: r.replayed } };
  }
}
@Controller('public/forms')
export class PublishedFormController {
  constructor(private readonly forms: PublicFormService) {}
  @Get(':publicId') @Header('Cache-Control', 'no-store')
  async published(@Param('publicId') id: string) { const data = await this.forms.published(id); if (!data) throw new NotFoundException({ result: 'invalid' }); return { data }; }
  @Post(':publicId/submissions') @Header('Cache-Control', 'no-store')
  async submit(@Param('publicId') id: string, @Body() input: unknown, @Headers('idempotency-key') key: string, @Res() res: Response) {
    const result = await this.forms.submit(id,input,key);
    if (result === 'rate-limited') res.setHeader('Retry-After','3600');
    return res.status(result === 'accepted' ? 202 : result === 'invalid' ? 400 : result === 'rate-limited' ? 429 : 503).json({ result });
  }
}
