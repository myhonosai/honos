import type { SaasCheckoutReceipt, SaasPublicPlanCode, SaasOfferKind, SaasProviderCode, SaasSchoolPlanOptions, SaasSchoolCredits } from '@hon/contracts';
export function checkoutId(n: number): string;
export const schoolContext: { state: 'RESOLVED'; organizationId: string; schoolId: string };
export type FixtureOptions = { tier?: SaasPublicPlanCode; state?: string; provider?: SaasProviderCode; kind?: SaasOfferKind; price?: number; stock?: number; service?: 'IN_SERVICE' | 'SUSPENDED' | 'PENDING_ACTIVATION' | 'VOIDED' };
export function schoolPlanFixture(options?: FixtureOptions): SaasSchoolPlanOptions;
export function schoolCreditsFixture(plan: SaasSchoolPlanOptions, mode?: 'ready' | 'inactive' | 'absent' | 'expired' | 'empty'): SaasSchoolCredits;
export function schoolCheckoutReceipt(options?: FixtureOptions): SaasCheckoutReceipt & { providerCall: 'OPENED' };
