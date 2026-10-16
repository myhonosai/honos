import { ForbiddenException, Injectable, type ExecutionContext } from '@nestjs/common';
import { CurriculumHumanUiGuard } from '../curriculum/curriculum-human-ui.guard.js';
@Injectable()
export class OwnerLaunchHumanUiGuard extends CurriculumHumanUiGuard {
  protected readonly command='owner-launch-student-registration';
  canActivate(context: ExecutionContext): boolean {
    const request=context.switchToHttp().getRequest<{method:string;headers:Record<string,unknown>}>();
    if (!['GET','POST'].includes(request.method) || (request.headers['sec-fetch-site']!==undefined && request.headers['sec-fetch-site']!=='same-origin')) throw new ForbiddenException({code:'HUMAN_UI_REQUIRED'});
    return super.canActivate(context);
  }
}
