import { BadRequestException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { saasUuid, validateSaasPaidReviewCursor, validateSaasPaidReviewQueue, validateSaasPaidReviewResolveInput, validateSaasPaidReviewResolveReceipt,
  validateSaasPaidReviewVerifyInput, validateSaasPaidReviewVerifyReceipt } from '@hon/contracts';
import { SaasBillingService } from '../saas-billing/saas-billing.service.js';

const parse = <T>(fn: () => T): T => { try { return fn(); } catch { throw new BadRequestException({ code: 'INVALID_SAAS_INPUT' }); } };

/**
 * Piece 3 (0237): HQ review queue for money HON holds. HQ owner only for the two commands (database-enforced); HQ billing
 * operators may read. Nothing here contacts a provider or executes a refund: REFUND_OWED records an obligation, and
 * verification only reads the provider refund evidence already stored by the verified webhook path.
 */
@Injectable()
export class SaasPaidReviewService {
  constructor(private readonly billing: SaasBillingService) {}

  async list(subject: string, cursor: unknown) {
    return this.billing.call('readPaidReviews', [subject, parse(() => validateSaasPaidReviewCursor(cursor))], validateSaasPaidReviewQueue);
  }
  async resolve(subject: string, body: unknown, key: unknown) {
    const [input, k] = parse(() => [validateSaasPaidReviewResolveInput(body), saasUuid(key)] as const);
    return this.billing.call('resolvePaidReview', [subject, JSON.stringify(input), k, randomUUID(), randomUUID()], validateSaasPaidReviewResolveReceipt);
  }
  async verifyRefund(subject: string, resolution: unknown, body: unknown, key: unknown) {
    const [r, input, k] = parse(() => [saasUuid(resolution), validateSaasPaidReviewVerifyInput(body), saasUuid(key)] as const);
    return this.billing.call('verifyPaidReviewRefund', [subject, r, JSON.stringify(input), k, randomUUID(), randomUUID()], validateSaasPaidReviewVerifyReceipt);
  }
}
