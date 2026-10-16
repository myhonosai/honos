import { BadRequestException, Controller, ForbiddenException, Get, Header, Injectable, Query, Req, UseGuards, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { ParentClassPassViewService } from './parent-classpass-view.service.js';
export function rejectParentClassPassInputs(request: Pick<Request, 'method'|'headers'|'body'|'originalUrl'>, query: Record<string, unknown>): void {
  if (request.method !== 'GET' || request.headers['sec-fetch-site'] === 'cross-site'
    || Object.keys(request.headers).some(k => k.toLowerCase().startsWith('x-hon-'))) throw new ForbiddenException({ code: 'PARENT_CLASSPASS_READ_ONLY' });
  if (Object.keys(query).length || request.originalUrl?.includes('?') || (request.body !== undefined && request.body !== null))
    throw new BadRequestException({ code: 'PARENT_CLASSPASS_SELECTORS_NOT_ACCEPTED' });
}
@Injectable()
export class ParentClassPassReadGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean { const request = context.switchToHttp().getRequest<Request>(); rejectParentClassPassInputs(request, request.query); return true; }
}
@Controller('parent/classpass')
@UseGuards(HonIdentityGuard, ParentClassPassReadGuard)
export class ParentClassPassViewController {
  constructor(private readonly service: ParentClassPassViewService) {}
  @Header('Cache-Control', 'private, no-store')
  @Header('Pragma', 'no-cache')
  @Header('Referrer-Policy', 'no-referrer')
  @Header('X-Robots-Tag', 'noindex, nofollow')
  @Get()
  async read(@Query() query: Record<string, unknown>, @Req() request: HonRequest) {
    rejectParentClassPassInputs(request, query);
    if (!request.honIdentity) throw new ForbiddenException({ code: 'IDENTITY_REQUIRED' });
    return this.service.get(request.honIdentity.externalSubject);
  }
}
