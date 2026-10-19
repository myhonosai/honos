import type { SaasSubscription, SaasSubscriptionStatus } from '@hon/contracts';
import type { SaasAccountReview, SaasReviewOverview } from '../../src/components/hq-modern/saas-review-http';
export function saasId(id: number): string;
export function subscriptionFixture(id?: number): SaasSubscription;
export function saasOverviewFixture(options?: { status?: SaasSubscriptionStatus | null; empty?: boolean; updated?: boolean }): SaasReviewOverview;
export function saasAccountFixture(options?: { organizationId?: string; empty?: boolean; updated?: boolean; mismatch?: boolean }): SaasAccountReview;
