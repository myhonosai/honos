import { ForbiddenException, Injectable, type ExecutionContext } from '@nestjs/common';
import { CurriculumHumanUiGuard } from '../curriculum/curriculum-human-ui.guard.js';

/** GET-only surface: this guard rejects cross-site browser contexts and shares no write command path. */
@Injectable()
export class RetentionReviewHumanUiGuard extends CurriculumHumanUiGuard {
  protected readonly command = 'retention-review-signals';
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{ method: string; headers: Record<string, unknown> }>();
    if (request.method !== 'GET') throw new ForbiddenException({ code: 'HUMAN_UI_REQUIRED' });
    if (request.headers['sec-fetch-site'] !== undefined && request.headers['sec-fetch-site'] !== 'same-origin') throw new ForbiddenException({ code: 'HUMAN_UI_REQUIRED' });
    return super.canActivate(context);
  }
}
