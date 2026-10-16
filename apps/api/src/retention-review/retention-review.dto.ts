import { ForbiddenException, ServiceUnavailableException, Injectable, type ExecutionContext } from '@nestjs/common';
import { configuredPublicOrigin } from '@hon/auth';
import { CurriculumHumanUiGuard } from '../curriculum/curriculum-human-ui.guard.js';

/** Only same-origin direct-human reads and the three exact closed human commands. */
@Injectable()
export class RetentionReviewHumanUiGuard extends CurriculumHumanUiGuard {
  protected readonly command = 'retention-review-acknowledgement';
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{ method: string; path?: string; url?: string; headers: Record<string, unknown> }>();
    if (!['GET', 'POST'].includes(request.method)) throw new ForbiddenException({ code: 'HUMAN_UI_REQUIRED' });
    if (request.headers['sec-fetch-site'] !== undefined && request.headers['sec-fetch-site'] !== 'same-origin') throw new ForbiddenException({ code: 'HUMAN_UI_REQUIRED' });
    // Express may retain a trailing slash depending on proxy normalization;
    // normalize only that presentation variance before matching the fixed,
    // closed command routes. No prefix or parameterized route is accepted.
    const path = (request.path ?? request.url?.split('?')[0] ?? '').replace(/\/+$/, '');
    const attentionCommand = new Map<string, string>([
      ['/v1/staff/retention/review/attention-alerts/record', 'retention-attention-record'],
      ['/v1/staff/retention/review/attention-alerts/resolve', 'retention-attention-resolve'],
      ['/api/v1/staff/retention/review/attention-alerts/record', 'retention-attention-record'],
      ['/api/v1/staff/retention/review/attention-alerts/resolve', 'retention-attention-resolve'],
    ]).get(path) ?? null;
    if (request.method === 'POST' && attentionCommand) {
      let origin: string | undefined; try { origin = configuredPublicOrigin(process.env); } catch { /* fail closed */ }
      if (!origin) throw new ServiceUnavailableException({ code: 'HUMAN_UI_ORIGIN_NOT_CONFIGURED' });
      if (request.headers.origin !== origin || request.headers['x-hon-human-command'] !== attentionCommand || typeof request.headers['content-type'] !== 'string' || !/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'])) throw new ForbiddenException({ code: 'HUMAN_UI_REQUIRED' });
      return true;
    }
    return super.canActivate(context);
  }
}
