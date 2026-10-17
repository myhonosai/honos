import { BadRequestException, Body, Controller, ForbiddenException, Get, Header, Headers, HttpCode, Injectable, Post, Query, Req, Res, UseGuards, type ExecutionContext } from '@nestjs/common';
import type { Response } from 'express';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { CurriculumHumanUiGuard } from '../curriculum/curriculum-human-ui.guard.js';
import { CreateParentPlannedAbsenceDto } from './create-parent-planned-absence.dto.js';
import { ParentPlannedAbsenceRequestService } from './parent-planned-absence-request.service.js';

export function rejectParentAbsenceSelectors(request: HonRequest, query: Record<string, unknown>): void {
  if (Object.keys(query).length || request.originalUrl?.includes('?')) throw new BadRequestException({ code: 'PARENT_ABSENCE_SELECTORS_NOT_ACCEPTED' });
  if (Object.keys(request.headers).some(key => key.toLowerCase().startsWith('x-hon-') && (request.method === 'GET' || key.toLowerCase() !== 'x-hon-human-command'))) throw new ForbiddenException({ code: 'PARENT_ABSENCE_SELECTORS_NOT_ACCEPTED' });
  if (request.method === 'GET' && (request.headers['sec-fetch-site'] === 'cross-site' || request.body !== undefined && request.body !== null)) throw new ForbiddenException({ code: 'PARENT_ABSENCE_CONTEXT_READ_REQUIRED' });
}
@Injectable()
export class ParentPlannedAbsenceRequestGuard extends CurriculumHumanUiGuard {
  protected override readonly command = 'parent-planned-absence';
  override canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<HonRequest>();
    rejectParentAbsenceSelectors(request, request.query);
    return super.canActivate(context);
  }
}
@Controller('parent/planned-absences')
@UseGuards(HonIdentityGuard, ParentPlannedAbsenceRequestGuard)
export class ParentPlannedAbsenceRequestController {
  constructor(private readonly requests: ParentPlannedAbsenceRequestService) {}
  @Get('context')
  @Header('Cache-Control', 'private, no-store')
  @Header('Pragma', 'no-cache')
  @Header('Referrer-Policy', 'no-referrer')
  @Header('X-Robots-Tag', 'noindex, nofollow')
  async context(@Query() query: Record<string, unknown>, @Req() request: HonRequest) {
    rejectParentAbsenceSelectors(request, query);
    if (!request.honIdentity) throw new ForbiddenException({ code: 'IDENTITY_REQUIRED' });
    return this.requests.context(request.honIdentity.externalSubject);
  }
  @Post()
  @HttpCode(201)
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @Header('X-Robots-Tag', 'noindex, nofollow')
  async submit(@Query() query: Record<string, unknown>, @Body() input: CreateParentPlannedAbsenceDto, @Headers('idempotency-key') key: string | undefined, @Req() request: HonRequest, @Res({ passthrough: true }) response: Response) {
    rejectParentAbsenceSelectors(request, query);
    if (!request.honIdentity) throw new ForbiddenException({ code: 'IDENTITY_REQUIRED' });
    const result = await this.requests.submit(request.honIdentity.externalSubject, input, key ?? '');
    response.status(result.meta.replayed ? 200 : 201);
    return result;
  }
}
