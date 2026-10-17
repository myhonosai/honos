import { Allow } from 'class-validator';
import { BadRequestException, ForbiddenException, Injectable, type ExecutionContext } from '@nestjs/common';
import type { CloseCrmLeadInput } from '@hon/contracts';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { CurriculumHumanUiGuard } from '../curriculum/curriculum-human-ui.guard.js';

export class CloseCrmLeadDto implements CloseCrmLeadInput {
  @Allow() declare status: 'WON' | 'LOST';
  @Allow() declare expectedVersion: number;
  @Allow() declare closeNote?: string;
}
@Injectable()
export class LeadCloseHumanUiGuard extends CurriculumHumanUiGuard {
  protected override readonly command = 'crm-lead-close';
  override canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<HonRequest>();
    context.switchToHttp().getResponse().setHeader('Cache-Control', 'private, no-store');
    if (Object.keys(req.query ?? {}).length || req.originalUrl?.includes('?')) throw new BadRequestException({ code: 'CLOSE_SELECTORS_NOT_ACCEPTED' });
    if (req.method !== 'POST' || Object.keys(req.headers).some(k => k.toLowerCase().startsWith('x-hon-') && k.toLowerCase() !== 'x-hon-human-command')
      || req.headers['sec-fetch-site'] !== undefined && req.headers['sec-fetch-site'] !== 'same-origin') throw new ForbiddenException({ code: 'HUMAN_UI_REQUIRED' });
    return super.canActivate(context);
  }
}
