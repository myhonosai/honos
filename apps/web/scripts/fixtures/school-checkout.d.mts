import type { SaasCheckoutReceipt, SaasPublicPlanCode, SaasOfferKind, SaasProviderCode, SaasSchoolPlanOptions, SaasSchoolCredits } from '@hon/contracts';
export function checkoutId(n: number): string;
export const schoolContext: { state: 'RESOLVED'; organizationId: string; schoolId: string };
export type FixtureOptions = { tier?: SaasPublicPlanCode; state?: string; provider?: SaasProviderCode; kind?: SaasOfferKind; price?: number; stock?: number };
export function schoolPlanFixture(options?: FixtureOptions): SaasSchoolPlanOptions;
export function schoolCreditsFixture(plan: SaasSchoolPlanOptions): SaasSchoolCredits;
export function schoolCheckoutReceipt(options?: FixtureOptions): SaasCheckoutReceipt & { providerCall: 'OPENED' };
