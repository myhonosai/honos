import { BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, Injectable, Post, Req, UseGuards,
  ServiceUnavailableException, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { configuredPublicOrigin } from '@hon/auth';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { assertHqEntitlementHumanRequest } from '../hq/hq-entitlement.dto.js';
import { ZernioIntegrationService } from './zernio.service.js';

@Injectable()
export class ZernioHumanUiGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<HonRequest>();
    const res = context.switchToHttp().getResponse();
    res.setHeader('Cache-Control', 'private, no-store'); res.setHeader('Referrer-Policy', 'no-referrer');
    assertHqEntitlementHumanRequest(req);
    if (Object.keys(req.query ?? {}).length || req.originalUrl?.includes('?')) throw new BadRequestException({ code: 'INVALID_ZERNIO_REQUEST' });
    if (req.headers.authorization || Object.keys(req.headers).some(k => k.startsWith('x-hon-') && k !== 'x-hon-human-command')) {
      throw new ForbiddenException({ code: 'HUMAN_UI_REQUIRED' });
    }
    if (req.method === 'GET') {
      if (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin') throw new ForbiddenException({ code: 'HUMAN_UI_REQUIRED' });
      return true;
    }
    let origin: string | undefined;
    try { origin = configuredPublicOrigin(process.env); } catch { /* fail closed */ }
    if (!origin) throw new ServiceUnavailableException({ code: 'HUMAN_UI_ORIGIN_NOT_CONFIGURED' });
    if (req.method !== 'POST' || req.headers.origin !== origin || req.headers['x-hon-human-command'] !== 'zernio-credential-verify'
      || req.headers['sec-fetch-site'] !== 'same-origin' || req.headers['sec-fetch-mode'] !== 'same-origin'
      || req.headers['sec-fetch-dest'] !== 'empty' || !/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) {
      throw new ForbiddenException({ code: 'HUMAN_UI_REQUIRED' });
    }
    return true;
  }
}

@Controller('hq/integrations/zernio')
@UseGuards(ZernioHumanUiGuard, HonIdentityGuard)
export class ZernioIntegrationController {
  constructor(private readonly integration: ZernioIntegrationService) {}
  private subject(req: HonRequest): string {
    assertHqEntitlementHumanRequest(req);
    if (!req.honIdentity) throw new ForbiddenException({ code: 'ZERNIO_HQ_OWNER_REQUIRED' });
    return req.honIdentity.externalSubject;
  }
  @Get('configuration')
  async configuration(@Req() req: HonRequest) { return { data: await this.integration.configuration(this.subject(req)) }; }
  @Post('verify')
  @HttpCode(200)
  async verify(@Req() req: HonRequest, @Body() body: unknown) { return { data: await this.integration.verify(this.subject(req), body) }; }
}
