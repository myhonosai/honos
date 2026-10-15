import { BadRequestException, Controller, ForbiddenException, Get, Header, Injectable, Query, Req, UseGuards, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import { ParentTestingStatusService } from './parent-testing-status.service.js';

export function rejectParentTestingStatusInputs(request: Pick<Request, 'method' | 'headers' | 'body' | 'originalUrl'>, query: Record<string, unknown>): void {
  if (request.method !== 'GET' || request.headers['sec-fetch-site'] === 'cross-site' || Object.keys(request.headers).some(key => key.toLowerCase().startsWith('x-hon-'))) {
    throw new ForbiddenException({ code: 'PARENT_TESTING_STATUS_READ_ONLY' });
  }
  if (Object.keys(query).length || request.originalUrl?.includes('?') || (request.body !== undefined && request.body !== null)) {
    throw new BadRequestException({ code: 'PARENT_TESTING_STATUS_SELECTORS_NOT_ACCEPTED', detail: 'Family and child status scope comes only from the verified session and live server-side family resolver.' });
  }
}

@Injectable()
export class ParentTestingStatusReadGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    rejectParentTestingStatusInputs(request, request.query);
    return true;
  }
}

@Controller('parent/testing/status')
@UseGuards(HonIdentityGuard, ParentTestingStatusReadGuard)
export class ParentTestingStatusController {
  constructor(private readonly status: ParentTestingStatusService) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @Header('X-Robots-Tag', 'noindex, nofollow')
  async read(@Query() query: Record<string, unknown>, @Req() request: HonRequest) {
    rejectParentTestingStatusInputs(request, query);
    if (!request.honIdentity) throw new ForbiddenException({ code: 'IDENTITY_REQUIRED' });
    return this.status.get(request.honIdentity.externalSubject);
  }
}
