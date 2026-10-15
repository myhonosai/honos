import { BadRequestException, Controller, ForbiddenException, Get, Header, Injectable, Query, Req, UseGuards, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { ParentBillingViewService } from './parent-billing-view.service.js';

/** Reject every caller-controlled tenant, family, child, billing, and action selector. */
export function rejectParentBillingInputs(request: Pick<Request, 'method' | 'headers' | 'body' | 'originalUrl'>, query: Record<string, unknown>): void {
  if (request.method !== 'GET' || request.headers['sec-fetch-site'] === 'cross-site'
    || Object.keys(request.headers).some(key => key.toLowerCase().startsWith('x-hon-'))) {
    throw new ForbiddenException({ code: 'PARENT_BILLING_READ_ONLY' });
  }
  if (Object.keys(query).length || request.originalUrl?.includes('?') || (request.body !== undefined && request.body !== null)) {
    throw new BadRequestException({ code: 'PARENT_BILLING_SELECTORS_NOT_ACCEPTED', detail: 'Current guardian, family, child, and billing authority come only from the verified session and live family resolver.' });
  }
}

@Injectable()
export class ParentBillingReadGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    rejectParentBillingInputs(request, request.query);
    return true;
  }
}

@Controller('parent/billing')
@UseGuards(HonIdentityGuard, ParentBillingReadGuard)
export class ParentBillingViewController {
  constructor(private readonly billing: ParentBillingViewService) {}

  @Header('Cache-Control', 'private, no-store')
  @Header('Pragma', 'no-cache')
  @Header('Referrer-Policy', 'no-referrer')
  @Header('X-Robots-Tag', 'noindex, nofollow')
  @Get()
  async read(@Query() query: Record<string, unknown>, @Req() request: HonRequest) {
    rejectParentBillingInputs(request, query);
    if (!request.honIdentity) throw new ForbiddenException({ code: 'IDENTITY_REQUIRED' });
    return this.billing.get(request.honIdentity.externalSubject);
  }
}
