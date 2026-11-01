import { BadRequestException, ForbiddenException, Injectable, type ExecutionContext } from '@nestjs/common';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { CurriculumHumanUiGuard } from '../curriculum/curriculum-human-ui.guard.js';

/**
 * Human-UI transport guard for trial scheduling and trial outcomes. Both commands are browser-originated
 * human actions: they require the configured public origin, the fixed `crm-trial-appointment` command
 * marker, JSON, no cross-site fetch metadata, no query selectors and no caller-supplied HON context headers.
 * Authorization (identity, school scope, permission) is still resolved server-side by the controller.
 */
@Injectable()
export class TrialAppointmentHumanUiGuard extends CurriculumHumanUiGuard {
  protected override readonly command = 'crm-trial-appointment';
  override canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<HonRequest>();
    context.switchToHttp().getResponse().setHeader('Cache-Control', 'private, no-store');
    if (Object.keys(req.query ?? {}).length || req.originalUrl?.includes('?')) throw new BadRequestException({ code: 'TRIAL_SELECTORS_NOT_ACCEPTED' });
    if (req.method !== 'POST'
      || Object.keys(req.headers).some((key) => key.toLowerCase().startsWith('x-hon-') && key.toLowerCase() !== 'x-hon-human-command')
      || (req.headers['sec-fetch-site'] !== undefined && req.headers['sec-fetch-site'] !== 'same-origin')) {
      throw new ForbiddenException({ code: 'HUMAN_UI_REQUIRED' });
    }
    return super.canActivate(context);
  }
}

/**
 * Read transport guard for trial reconciliation: GET only, no query selectors, no caller-supplied HON context
 * headers, no cross-site fetch metadata and never cached. Identity, exact school scope and permission are still
 * resolved server-side by the controller.
 */
@Injectable()
export class TrialAppointmentReadGuard {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<HonRequest>();
    context.switchToHttp().getResponse().setHeader('Cache-Control', 'private, no-store');
    if (Object.keys(req.query ?? {}).length || req.originalUrl?.includes('?')) throw new BadRequestException({ code: 'TRIAL_SELECTORS_NOT_ACCEPTED' });
    if (req.method !== 'GET'
      || Object.keys(req.headers).some((key) => key.toLowerCase().startsWith('x-hon-'))
      || (req.headers['sec-fetch-site'] !== undefined && !['same-origin', 'none'].includes(String(req.headers['sec-fetch-site'])))) {
      throw new ForbiddenException({ code: 'HUMAN_UI_REQUIRED' });
    }
    return true;
  }
}
