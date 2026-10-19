import type { SaasInvoiceDetail, SaasInvoiceList, SaasInvoiceStatus, SaasOrganizationSubscription, SaasPaymentStanding, SaasRefundEligibility, SaasRefundRequestList } from '@hon/contracts';
export function saasId(id: number): string;
export function invoiceId(id: number): string;
export function invoiceFixture(id?: number, options?: { updated?: boolean; empty?: boolean }): SaasInvoiceDetail;
export function invoiceListFixture(options?: { status?: SaasInvoiceStatus | null; empty?: boolean; updated?: boolean }): SaasInvoiceList;
export function invoiceAccountFixture(id?: number, options?: { updated?: boolean; empty?: boolean; historical?: boolean }): { invoice: SaasInvoiceDetail; account: SaasOrganizationSubscription; standing: SaasPaymentStanding };
export function invoiceRefundFixture(id?: number, options?: { updated?: boolean; empty?: boolean }): { eligibility: SaasRefundEligibility; requests: SaasRefundRequestList };
