import { BadRequestException, Body, Controller, ForbiddenException, Get, Header, Headers, HttpCode, Injectable, Param, ParseUUIDPipe, Post, Query, Req, Res, UseGuards,
  type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Request, Response } from 'express';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { MembershipActivationHumanUiGuard } from '../billing/membership-activation-human-ui.guard.js';
import { EianService } from './eian.service.js';

/** Reads take nothing from the caller: no query, no body and no x-hon-* header (as the parent billing read). */
export function rejectEianReadInputs(request: Pick<Request, 'method' | 'headers' | 'body' | 'originalUrl'>, query: Record<string, unknown>): void {
  if (request.method !== 'GET' || request.headers['sec-fetch-site'] === 'cross-site'
    || Object.keys(request.headers).some(key => key.toLowerCase().startsWith('x-hon-'))) {
    throw new ForbiddenException({ code: 'EIAN_READ_ONLY' });
  }
  if (Object.keys(query ?? {}).length || request.originalUrl?.includes('?') || (request.body !== undefined && request.body !== null && Object.keys(Object(request.body)).length > 0)) {
    throw new BadRequestException({ code: 'EIAN_SELECTORS_NOT_ACCEPTED' });
  }
}
@Injectable()
export class EianReadGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    rejectEianReadInputs(request, request.query);
    return true;
  }
}
/** Each question is its own same-origin browser (or native app) command. */
@Injectable()
export class EianAskGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'parent.eian.ask';
}

/** E-AI1: the signed-in guardian's Eian. The family, school and organization come only from the verified session. */
@Controller('parent/eian')
@UseGuards(HonIdentityGuard)
export class EianController {
  constructor(private readonly eian: EianService) {}

  @Get('status')
  @UseGuards(EianReadGuard)
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  async status(@Query() query: Record<string, unknown>, @Req() request: HonRequest) {
    rejectEianReadInputs(request, query);
    if (!request.honIdentity) throw new ForbiddenException({ code: 'IDENTITY_REQUIRED' });
    return { data: await this.eian.status(request.honIdentity.externalSubject) };
  }

  @Post('turns')
  @HttpCode(201)
  @UseGuards(EianAskGuard)
  @Header('Cache-Control', 'private, no-store')
  async ask(@Query() query: Record<string, unknown>, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined, @Req() request: HonRequest,
    @Res({ passthrough: true }) response: Response) {
    if (Object.keys(query ?? {}).length || request.originalUrl?.includes('?')) throw new BadRequestException({ code: 'EIAN_SELECTORS_NOT_ACCEPTED' });
    if (!request.honIdentity) throw new ForbiddenException({ code: 'IDENTITY_REQUIRED' });
    const result = await this.eian.ask(request.honIdentity.externalSubject, body, key);
    response.status(result.replayed ? 200 : 201);
    return { data: result.turn, meta: { replayed: result.replayed } };
  }

  @Get('turns/:turnId')
  @UseGuards(EianReadGuard)
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  async read(@Param('turnId', new ParseUUIDPipe()) turnId: string, @Query() query: Record<string, unknown>, @Req() request: HonRequest) {
    rejectEianReadInputs(request, query);
    if (!request.honIdentity) throw new ForbiddenException({ code: 'IDENTITY_REQUIRED' });
    return { data: await this.eian.read(request.honIdentity.externalSubject, turnId) };
  }
}
