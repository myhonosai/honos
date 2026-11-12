import { BadRequestException, ConflictException, ForbiddenException, Injectable, type ExecutionContext } from '@nestjs/common';
import { CRM_LEAD_CREATE_UUID } from '@hon/contracts';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { CurriculumHumanUiGuard } from '../curriculum/curriculum-human-ui.guard.js';
import { assertDirectHumanLeadCreateRequest } from './lead-create-human-ui.guard.js';

/** First-lead setup is a direct same-origin human command with an empty body: the starter funnel is server defined. */
@Injectable()
export class StarterPipelineHumanUiGuard extends CurriculumHumanUiGuard {
  protected override readonly command = 'crm-pipeline-starter';
  override canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<HonRequest>();
    context.switchToHttp().getResponse().setHeader('Cache-Control', 'private, no-store');
    if (Object.keys(req.query ?? {}).length || req.originalUrl?.includes('?')) throw new BadRequestException({ code: 'CREATE_SELECTORS_NOT_ACCEPTED' });
    assertDirectHumanLeadCreateRequest(req);
    if (req.method !== 'POST'
      || Object.keys(req.headers).some(key => key.toLowerCase().startsWith('x-hon-') && key.toLowerCase() !== 'x-hon-human-command')
      || req.headers['sec-fetch-site'] !== 'same-origin' || req.headers['sec-fetch-mode'] !== 'same-origin'
      || req.headers['sec-fetch-dest'] !== 'empty' || req.headers['sec-fetch-user'] !== undefined) {
      throw new ForbiddenException({ code: 'HUMAN_UI_REQUIRED' });
    }
    super.canActivate(context);
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || !CRM_LEAD_CREATE_UUID.test(key)) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
    const body: unknown = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) throw new BadRequestException({ code: 'STARTER_PIPELINE_TAKES_NO_INPUT' });
    return true;
  }
}
