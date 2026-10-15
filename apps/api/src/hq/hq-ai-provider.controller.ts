import { Body, Controller, ForbiddenException, Get, Headers, HttpCode, HttpStatus, Post, Req, UseGuards } from '@nestjs/common';
import type { AiControlPlaneKind } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { HqAiProviderService } from './hq-ai-provider.service.js';

@Controller('hq/ai-providers')
@UseGuards(HonIdentityGuard)
export class HqAiProviderController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly controlPlane: HqAiProviderService) {}

  private async subject(request: HonRequest, permission: 'hq.ai.providers.read' | 'hq.ai.providers.manage'): Promise<string> {
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException('HON identity context is missing.');
    // Existing live HQ scope resolver requires an active HUMAN_USER, never a
    // tenant role, AI employee, delegated actor, or caller-supplied authority.
    if (!await this.database.resolveHqOperatorScope(identity.externalSubject, permission)) throw new ForbiddenException('HON HQ AI provider access is not provisioned for this account.');
    return identity.externalSubject;
  }

  @Get('configuration')
  async read(@Req() request: HonRequest) {
    return { data: await this.controlPlane.read(await this.subject(request, 'hq.ai.providers.read')) };
  }

  private async mutate(request: HonRequest, kind: AiControlPlaneKind, body: unknown, key: string | undefined) {
    const subject = await this.subject(request, 'hq.ai.providers.manage');
    const data = await this.controlPlane.write(subject, kind, body, key);
    return { data, meta: { replayed: data.replayed } };
  }

  @Post('connections')
  @HttpCode(HttpStatus.OK)
  writeConnection(@Req() request: HonRequest, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    return this.mutate(request, 'PROVIDER', body, key);
  }

  @Post('catalog')
  @HttpCode(HttpStatus.OK)
  writeCatalog(@Req() request: HonRequest, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    return this.mutate(request, 'CATALOG', body, key);
  }

  @Post('routing-policies')
  @HttpCode(HttpStatus.OK)
  writePolicy(@Req() request: HonRequest, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    return this.mutate(request, 'POLICY', body, key);
  }

  @Post('route-preview')
  @HttpCode(HttpStatus.OK)
  async preview(@Req() request: HonRequest, @Body() body: unknown) {
    // Read-only validation/selection: preview does not reserve budget or append
    // a business action, queue a job, probe health, or call any provider.
    return { data: await this.controlPlane.preview(await this.subject(request, 'hq.ai.providers.read'), body) };
  }
}
