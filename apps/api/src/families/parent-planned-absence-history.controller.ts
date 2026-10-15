import { BadRequestException, Controller, ForbiddenException, Get, Header, Injectable, Query, Req, UseGuards, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { ParentPlannedAbsenceHistoryService } from './parent-planned-absence-history.service.js';

/** Reject every caller-controlled family, child, request, schedule, date, staff, review, and action selector. */
export function rejectParentPlannedAbsenceHistoryInputs(request: Pick<Request, 'method' | 'headers' | 'body' | 'originalUrl'>, query: Record<string, unknown>): void {
  if (request.method !== 'GET' || request.headers['sec-fetch-site'] === 'cross-site'
    || Object.keys(request.headers).some(key => key.toLowerCase().startsWith('x-hon-'))) {
    throw new ForbiddenException({ code: 'PARENT_PLANNED_ABSENCE_HISTORY_READ_ONLY' });
  }
  if (Object.keys(query).length || request.originalUrl?.includes('?') || (request.body !== undefined && request.body !== null)) {
    throw new BadRequestException({ code: 'PARENT_PLANNED_ABSENCE_HISTORY_SELECTORS_NOT_ACCEPTED', detail: 'Current guardian, family, child, and planned-absence history scope come only from the verified session and live family resolver.' });
  }
}

@Injectable()
export class ParentPlannedAbsenceHistoryReadGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    rejectParentPlannedAbsenceHistoryInputs(request, request.query);
    return true;
  }
}

@Controller('parent/planned-absences/history')
@UseGuards(HonIdentityGuard, ParentPlannedAbsenceHistoryReadGuard)
export class ParentPlannedAbsenceHistoryController {
  constructor(private readonly history: ParentPlannedAbsenceHistoryService) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  @Header('Pragma', 'no-cache')
  @Header('Referrer-Policy', 'no-referrer')
  @Header('X-Robots-Tag', 'noindex, nofollow')
  async read(@Query() query: Record<string, unknown>, @Req() request: HonRequest) {
    rejectParentPlannedAbsenceHistoryInputs(request, query);
    if (!request.honIdentity) throw new ForbiddenException({ code: 'IDENTITY_REQUIRED' });
    return this.history.get(request.honIdentity.externalSubject);
  }
}
