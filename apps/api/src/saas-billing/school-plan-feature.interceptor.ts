import { CallHandler, ExecutionContext, ForbiddenException, HttpException, Injectable, NestInterceptor, ServiceUnavailableException } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { schoolPlanFeatureForRoute } from '@hon/contracts';
import type { Observable } from 'rxjs';
import { HonIdentityService, type HonRequest } from '../foundation/hon-identity.service.js';
import { SaasBillingService } from './saas-billing.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function paths(value: unknown): string[] { return Array.isArray(value) ? value.map(String) : [typeof value === 'string' ? value : '']; }

/**
 * Plan features, server side (piece 4 of the HQ plan builder; owner decision 2026-11-26 "Locked, with an Upgrade button",
 * 2026-11-28 "Those should be both true"). Runs after every route's own guards. A request to a school feature area whose
 * feature the school's HQ-assigned plan leaves out (0699 read) is refused with 403 PLAN_FEATURE_LOCKED before the handler
 * runs, so a direct link, the staff app or a script gets the same answer as the menu. It only ever refuses: anyone the plan
 * read does not recognise as staff of the exact school passes to the route's own authorization unchanged, and a plan read
 * that fails for any other reason refuses (503) rather than letting a locked feature through.
 */
@Injectable()
export class SchoolPlanFeatureInterceptor implements NestInterceptor {
  constructor(private readonly billing: SaasBillingService, private readonly identity: HonIdentityService) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    if (context.getType() !== 'http') return next.handle();
    const controller = paths(Reflect.getMetadata(PATH_METADATA, context.getClass()));
    const handler = paths(Reflect.getMetadata(PATH_METADATA, context.getHandler()));
    const capability = controller.flatMap(c => handler.map(h => schoolPlanFeatureForRoute(`${c}/${h}`))).find(Boolean) ?? null;
    if (!capability) return next.handle();
    const req = context.switchToHttp().getRequest<HonRequest>();
    const schoolId = (req.params as Record<string, string | undefined> | undefined)?.schoolId;
    if (typeof schoolId !== 'string' || !UUID.test(schoolId)) return next.handle();
    let subject = req.honIdentity?.externalSubject;
    if (!subject) { try { subject = this.identity.authenticate(req).externalSubject; } catch { return next.handle(); } }
    let locked: readonly string[];
    try { locked = (await this.billing.readSchoolPlanFeatures(subject, schoolId)).locked; }
    catch (error) {
      if (error instanceof HttpException && [400, 403, 404].includes(error.getStatus())) return next.handle();
      throw new ServiceUnavailableException({ code: 'SAAS_UNAVAILABLE' });
    }
    if (locked.includes(capability)) throw new ForbiddenException({ code: 'PLAN_FEATURE_LOCKED', capability });
    return next.handle();
  }
}
