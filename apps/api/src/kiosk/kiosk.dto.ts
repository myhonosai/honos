import { type CanActivate, type ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { configuredPublicOrigin } from '@hon/auth';
import { Matches } from 'class-validator';
import { KIOSK_SECRET, KIOSK_UUID } from '@hon/domain';
import type { Request, Response } from 'express';
@Injectable()
export class KioskHumanUiGuard implements CanActivate {
 canActivate(context: ExecutionContext): boolean {
  const req = context.switchToHttp().getRequest<Request>();
  context.switchToHttp().getResponse<Response>().setHeader('Cache-Control', 'private, no-store');
  let origin: string | undefined;
  try { origin = configuredPublicOrigin(process.env); } catch { /* fail closed */ }
  const extraHonHeader = Object.keys(req.headers).some(key => key.toLowerCase().startsWith('x-hon-') && key.toLowerCase() !== 'x-hon-human-command');
  if (!origin || req.headers['x-hon-human-command'] !== 'kiosk' || req.headers.authorization !== undefined || extraHonHeader || req.originalUrl.includes('?')
   || req.headers['sec-fetch-site'] === 'cross-site' || (req.headers.origin !== undefined && req.headers.origin !== origin)
   || req.method === 'POST' && (req.headers.origin !== origin || !/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')))
   throw new ForbiddenException({ code: 'KIOSK_FORBIDDEN' });
  return true;
 }
}
export class KioskTerminalDto {
 @Matches(KIOSK_UUID) terminalSessionId!: string;
 @Matches(KIOSK_SECRET) terminalSession!: string;
}
export class KioskClaimDto {
 @Matches(KIOSK_UUID) studentProfileId!: string;
 @Matches(KIOSK_UUID) classSessionId!: string;
 @Matches(KIOSK_SECRET) claim!: string;
}
export class KioskPublicDto {
 @Matches(KIOSK_SECRET) terminalSession!: string;
 @Matches(KIOSK_SECRET) claim!: string;
}
export class KioskRetireDto {}
