import { ForbiddenException, Injectable, type ExecutionContext } from '@nestjs/common';
import { CurriculumHumanUiGuard } from '../curriculum/curriculum-human-ui.guard.js';

/** Only same-origin direct-human read and the exact evidence acknowledgement command. */
@Injectable()
export class RetentionReviewHumanUiGuard extends CurriculumHumanUiGuard {
  protected readonly command = 'retention-review-acknowledgement';
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{ method: string; headers: Record<string, unknown> }>();
    if (!['GET', 'POST'].includes(request.method)) throw new ForbiddenException({ code: 'HUMAN_UI_REQUIRED' });
    if (request.headers['sec-fetch-site'] !== undefined && request.headers['sec-fetch-site'] !== 'same-origin') throw new ForbiddenException({ code: 'HUMAN_UI_REQUIRED' });
    return super.canActivate(context);
  }
}
