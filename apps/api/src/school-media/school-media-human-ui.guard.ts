import { ForbiddenException, Injectable, ServiceUnavailableException, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { configuredPublicOrigin } from '@hon/auth';
import { SCHOOL_MEDIA_COMMANDS, SCHOOL_MEDIA_READ_COMMAND, SCHOOL_MEDIA_TYPES } from '@hon/contracts';
import type { Request } from 'express';
import { MembershipActivationHumanUiGuard } from '../billing/membership-activation-human-ui.guard.js';

/** 0628: each read and JSON command is its own same-origin browser command. */
@Injectable()
export class SchoolMediaReadHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = SCHOOL_MEDIA_READ_COMMAND;
}
@Injectable()
export class SchoolMediaRenameHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = SCHOOL_MEDIA_COMMANDS.rename;
}
@Injectable()
export class SchoolMediaDeleteHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = SCHOOL_MEDIA_COMMANDS.delete;
}

/**
 * The upload carries raw picture bytes, so it cannot use the JSON guard: same browser rules (POST, exact configured Origin,
 * not cross-site, its own X-HON-Human-Command, no source or delegation headers), but the body type must be one of the
 * three picture types. Native (bearer) requests are refused: staff upload from the web app.
 */
@Injectable()
export class SchoolMediaUploadHumanUiGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    let origin: string | undefined;
    try { origin = configuredPublicOrigin(process.env); } catch { /* fail closed */ }
    if (!origin) throw new ServiceUnavailableException({ code: 'HUMAN_UI_ORIGIN_NOT_CONFIGURED' });
    const type = (request.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
    if (request.method !== 'POST' || request.headers.origin !== origin || request.headers['x-hon-human-command'] !== SCHOOL_MEDIA_COMMANDS.upload
      || request.headers['sec-fetch-site'] === 'cross-site' || (request.headers['sec-fetch-site'] !== undefined && request.headers['sec-fetch-site'] !== 'same-origin')
      || ['x-hon-source', 'x-hon-action-request-id', 'x-hon-delegated-by-principal-id'].some(key => request.headers[key] !== undefined)
      || !(SCHOOL_MEDIA_TYPES as readonly string[]).includes(type)) throw new ForbiddenException({ code: 'HUMAN_UI_REQUIRED' });
    return true;
  }
}
