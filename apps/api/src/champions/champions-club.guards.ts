import { BadRequestException, ForbiddenException, Injectable, ServiceUnavailableException, SetMetadata, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { configuredPublicOrigin } from '@hon/auth';
import type { ChampionsCommand } from '@hon/contracts';
import type { HonRequest } from '../foundation/hon-identity.service.js';

const COMMAND_METADATA = 'hon:champions-command';
/** Names the exact x-hon-human-command value a Champions Club command route requires. */
export const ChampionsCommandName = (command: ChampionsCommand) => SetMetadata(COMMAND_METADATA, command);
const READ_QUERY_METADATA = 'hon:champions-read-query';
/** The only query keys a Champions Club read route accepts (default: none). */
export const ChampionsReadQuery = (keys: readonly string[]) => SetMetadata(READ_QUERY_METADATA, keys);

/** Direct human identity only: tenant, family, delegated, nonhuman or Action Engine context is refused. */
export function assertChampionsHumanRequest(req: HonRequest): void {
  const contextual = ['honContext','honCommandContext','commandContext','actionContext','principalType','source','actionRequestId','delegatedByPrincipalId','organizationId','schoolId','familyId'];
  if (contextual.some(key => Object.hasOwn(req, key))
    || req.honIdentity && Object.keys(req.honIdentity).some(key => !['externalSubject','displayName','email'].includes(key))) {
    throw new ForbiddenException({ code: 'HUMAN_UI_REQUIRED' });
  }
}

function hasBody(req: HonRequest): boolean {
  const body: unknown = req.body;
  return body !== undefined && body !== null && (typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length > 0);
}

/** Reads: no-store, no body, and no query key beyond the route's declared ChampionsReadQuery. */
@Injectable()
export class ChampionsReadGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<HonRequest>();
    context.switchToHttp().getResponse().setHeader('Cache-Control', 'private, no-store');
    assertChampionsHumanRequest(req);
    const allowedQuery = this.reflector.get<readonly string[] | undefined>(READ_QUERY_METADATA, context.getHandler()) ?? [];
    if (req.method !== 'GET' || hasBody(req) || Object.keys(req.query ?? {}).some(key => !allowedQuery.includes(key))) {
      throw new BadRequestException({ code: 'INVALID_CHAMPIONS_INPUT' });
    }
    return true;
  }
}

/** Commands: trusted same-origin human JSON with the route's exact command header and no query string. */
@Injectable()
export class ChampionsCommandGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<HonRequest>();
    context.switchToHttp().getResponse().setHeader('Cache-Control', 'private, no-store');
    assertChampionsHumanRequest(req);
    const command = this.reflector.get<ChampionsCommand | undefined>(COMMAND_METADATA, context.getHandler());
    let origin: string | undefined;
    try { origin = configuredPublicOrigin(process.env); } catch { /* fail closed */ }
    if (!origin) throw new ServiceUnavailableException({ code: 'HUMAN_UI_ORIGIN_NOT_CONFIGURED' });
    if (!command || req.method !== 'POST' || req.headers.origin !== origin || req.headers['x-hon-human-command'] !== command
      || Object.keys(req.headers).some(key => key.toLowerCase().startsWith('x-hon-') && key.toLowerCase() !== 'x-hon-human-command')
      || req.headers['sec-fetch-site'] !== 'same-origin' || req.headers['sec-fetch-mode'] !== 'same-origin'
      || req.headers['sec-fetch-dest'] !== 'empty' || req.headers['sec-fetch-user'] !== undefined
      || typeof req.headers['content-type'] !== 'string' || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'])) {
      throw new ForbiddenException({ code: 'HUMAN_UI_REQUIRED' });
    }
    if (Object.keys(req.query ?? {}).length || req.originalUrl?.includes('?')) throw new BadRequestException({ code: 'INVALID_CHAMPIONS_INPUT' });
    return true;
  }
}
