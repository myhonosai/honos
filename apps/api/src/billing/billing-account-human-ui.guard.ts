import { BadRequestException, ForbiddenException, Injectable, type ExecutionContext } from '@nestjs/common';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { CurriculumHumanUiGuard } from '../curriculum/curriculum-human-ui.guard.js';

/** Identity is normalized by HonIdentityGuard; browser transport supplies no authority. */
export function assertDirectHumanBillingAccountRequest(req: HonRequest): void {
  const contextual = ['honContext', 'honCommandContext', 'commandContext', 'actionContext', 'principalType', 'source', 'actionRequestId', 'delegatedByPrincipalId'];
  if (contextual.some(key => Object.hasOwn(req, key))
    || req.honIdentity && Object.keys(req.honIdentity).some(key => !['externalSubject', 'displayName', 'email'].includes(key))) {
    throw new ForbiddenException({ code: 'HUMAN_UI_REQUIRED' });
  }
}

/**
 * Fixed transport gate for the small billing-account create/reuse workbench.
 * The payer lookup is a protected POST read with this same direct-human marker;
 * controller/service authorization still independently decide scope and access.
 */
@Injectable()
export class BillingAccountHumanUiGuard extends CurriculumHumanUiGuard {
  protected override readonly command = 'billing.account.create';

  override canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<HonRequest>();
    context.switchToHttp().getResponse().setHeader('Cache-Control', 'private, no-store');
    if (Object.keys(req.query ?? {}).length || req.originalUrl?.includes('?')) {
      throw new BadRequestException({ code: 'CREATE_SELECTORS_NOT_ACCEPTED' });
    }
    assertDirectHumanBillingAccountRequest(req);
    if (req.method !== 'POST'
      || Object.keys(req.headers).some(key => key.toLowerCase().startsWith('x-hon-') && key.toLowerCase() !== 'x-hon-human-command')
      || req.headers['sec-fetch-site'] !== 'same-origin' || req.headers['sec-fetch-mode'] !== 'same-origin'
      || req.headers['sec-fetch-dest'] !== 'empty' || req.headers['sec-fetch-user'] !== undefined
      || typeof req.headers['content-type'] !== 'string' || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'])) {
      throw new ForbiddenException({ code: 'HUMAN_UI_REQUIRED' });
    }
    return super.canActivate(context);
  }
}
