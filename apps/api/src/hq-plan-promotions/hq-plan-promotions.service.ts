import { BadRequestException, Injectable } from '@nestjs/common';
import { saasUuid, validateHqPlanPromotionCreateInput, validateHqPlanPromotionDetail, validateHqPlanPromotionList,
  validateHqPlanPromotionListQuery, validateHqPlanPromotionReceipt, validateHqPlanPromotionStatusInput, validateHqPlanPromotionUpdateInput,
  validateSchoolPlanPromotionEventInput, validateSchoolPlanPromotionEventReceipt, validateSchoolPlanPromotions } from '@hon/contracts';
import { SaasBillingService } from '../saas-billing/saas-billing.service.js';

function parse<T>(f: () => T): T { try { return f(); } catch { throw new BadRequestException({ code: 'INVALID_SAAS_INPUT' }); } }
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * HQ plan promotions (0308). The database decides HQ authority (owner-only commands, owner or marketing operator reads)
 * and, for schools, whether a promotion is shown: live, the school is in the audience and the subscription page's own
 * offer read lists the promoted offer as ELIGIBLE. Nothing here changes a price, an offer, a checkout or a plan.
 */
@Injectable()
export class HqPlanPromotionsService {
  constructor(private readonly billing: SaasBillingService) {}
  async list(subject: string, query: unknown) {
    const q = parse(() => validateHqPlanPromotionListQuery(query));
    return this.billing.call('readPlanPromotions', [subject, q.status, q.cursor?.createdAt ?? null, q.cursor?.promotionId ?? null, String(q.limit)], (v) => {
      const list = validateHqPlanPromotionList(v);
      if (list.limit !== q.limit || list.promotions.some(p => q.status !== null && (q.status === 'OPEN' ? p.status === 'ENDED' : p.status !== q.status))) throw new Error('mismatch');
      return list;
    });
  }
  async read(subject: string, id: unknown) {
    const promotionId = parse(() => saasUuid(id));
    return this.billing.call('readPlanPromotion', [subject, promotionId], (v) => {
      const d = validateHqPlanPromotionDetail(v); if (!same(d.promotion.promotionId, promotionId)) throw new Error('mismatch'); return d;
    });
  }
  async create(subject: string, body: unknown, key: unknown) {
    const [input, k] = parse(() => [validateHqPlanPromotionCreateInput(body), saasUuid(key)] as const);
    return this.billing.call('createPlanPromotion', [subject, JSON.stringify(input), k], validateHqPlanPromotionReceipt);
  }
  async update(subject: string, id: unknown, body: unknown, key: unknown) {
    const [promotionId, input, k] = parse(() => [saasUuid(id), validateHqPlanPromotionUpdateInput(body), saasUuid(key)] as const);
    return this.billing.call('updatePlanPromotion', [subject, promotionId, JSON.stringify(input), k], (v) => {
      const r = validateHqPlanPromotionReceipt(v); if (!same(r.promotion.promotionId, promotionId)) throw new Error('mismatch'); return r;
    });
  }
  async status(subject: string, id: unknown, body: unknown, key: unknown) {
    const [promotionId, input, k] = parse(() => [saasUuid(id), validateHqPlanPromotionStatusInput(body), saasUuid(key)] as const);
    return this.billing.call('setPlanPromotionStatus', [subject, promotionId, JSON.stringify(input), k], (v) => {
      const r = validateHqPlanPromotionReceipt(v); if (!same(r.promotion.promotionId, promotionId)) throw new Error('mismatch'); return r;
    });
  }
  async school(subject: string, school: unknown) {
    const schoolId = parse(() => saasUuid(school));
    return this.billing.call('readSchoolPlanPromotions', [subject, schoolId], (v) => {
      const r = validateSchoolPlanPromotions(v); if (!same(r.schoolId, schoolId)) throw new Error('mismatch'); return r;
    });
  }
  async schoolEvent(subject: string, school: unknown, id: unknown, body: unknown) {
    const [schoolId, promotionId, input] = parse(() => [saasUuid(school), saasUuid(id), validateSchoolPlanPromotionEventInput(body)] as const);
    return this.billing.call('recordSchoolPlanPromotionEvent', [subject, schoolId, promotionId, JSON.stringify(input)], (v) => {
      const r = validateSchoolPlanPromotionEventReceipt(v);
      if (!same(r.promotionId, promotionId) || r.kind !== input.kind) throw new Error('mismatch');
      return r;
    });
  }
}
