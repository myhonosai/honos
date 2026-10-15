import { Injectable, ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { CurriculumHumanUiGuard } from '../curriculum/curriculum-human-ui.guard.js';
@Injectable()
export class CampaignHumanUiGuard extends CurriculumHumanUiGuard {
  protected readonly command: string = 'marketing-campaign';
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{ method: string; headers: Record<string, unknown> }>();
    const site = request.headers['sec-fetch-site'];
    if (request.method !== 'GET' && site !== undefined && site !== 'same-origin') throw new ForbiddenException({ code: 'HUMAN_UI_REQUIRED' });
    return super.canActivate(context);
  }
}
