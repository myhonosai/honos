import {
  saasUuid, validateSaasInvoiceDetail, validateSaasInvoiceList, validateSaasInvoiceStatusFilter,
  validateSaasOrganizationSubscription, validateSaasPaymentStanding, validateSaasRefundEligibility, validateSaasRefundRequestList,
  type SaasInvoiceDetail, type SaasInvoiceList, type SaasInvoiceStatus, type SaasOrganizationSubscription,
  type SaasPaymentStanding, type SaasRefundEligibility, type SaasRefundRequest,
} from '@hon/contracts';

export type InvoiceReadFailure = 'UNAUTHORIZED' | 'FORBIDDEN' | 'UNAVAILABLE' | 'INVALID_RESPONSE' | 'INVALID_SELECTION';
export class HqInvoiceReadError extends Error {
  constructor(readonly kind: InvoiceReadFailure) { super('Authorized HON invoice records could not be verified.'); }
}

/** Private, fixed-resource reader. No public URL executor, role/scope headers or commands. */
async function read<T>(path: string, validate: (data: unknown) => T, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/v1/hq/saas/${path}`, {
      method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' }, ...(signal ? { signal } : {}),
    });
  } catch (error) { if (signal?.aborted) throw error; throw new HqInvoiceReadError('UNAVAILABLE'); }
  // A rejected read's body is not an authorized projection and is never read or echoed.
  if (!response.ok) throw new HqInvoiceReadError(response.status === 401 ? 'UNAUTHORIZED' : response.status === 403 ? 'FORBIDDEN' : 'UNAVAILABLE');
  try {
    const envelope: unknown = await response.json();
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) || Object.keys(envelope).length !== 1 || !Object.hasOwn(envelope, 'data')) throw Error();
    return validate((envelope as { data: unknown }).data);
  } catch { throw new HqInvoiceReadError('INVALID_RESPONSE'); }
}
function id(value: string): string {
  try { return saasUuid(value); } catch { throw new HqInvoiceReadError('INVALID_SELECTION'); }
}
const invalid = (): never => { throw new HqInvoiceReadError('INVALID_RESPONSE'); };

export async function loadHqInvoiceList(status: SaasInvoiceStatus | null, signal?: AbortSignal): Promise<SaasInvoiceList> {
  let filter: SaasInvoiceStatus | null;
  try { filter = validateSaasInvoiceStatusFilter(status === null ? undefined : status); }
  catch { throw new HqInvoiceReadError('INVALID_SELECTION'); }
  const data = await read(`invoices${filter ? `?status=${filter}` : ''}`, validateSaasInvoiceList, signal);
  if (filter && data.invoices.some((invoice) => invoice.status !== filter)) invalid();
  if (new Set(data.invoices.map((invoice) => invoice.invoiceId)).size !== data.invoices.length) invalid();
  return data;
}

export type InvoiceAccountReview = { invoice: SaasInvoiceDetail; account: SaasOrganizationSubscription; standing: SaasPaymentStanding };
export async function loadHqInvoiceAccount(invoiceId: string, signal?: AbortSignal): Promise<InvoiceAccountReview> {
  const invoice = await read(`invoices/${id(invoiceId)}`, validateSaasInvoiceDetail, signal);
  if (invoice.invoiceId !== invoiceId) invalid();
  const evidence = new Map(invoice.evidence.map((entry) => [entry.evidenceId, entry]));
  if (evidence.size !== invoice.evidence.length || invoice.evidence.some((entry) => entry.invoiceId !== invoiceId
    || entry.relatedEvidenceId !== null && evidence.get(entry.relatedEvidenceId)?.kind !== 'PAYMENT_RECEIVED')) invalid();
  const organization = invoice.organizationId;
  const [account, standing] = await Promise.all([
    read(`organizations/${organization}/subscription`, validateSaasOrganizationSubscription, signal),
    read(`organizations/${organization}/payment-standing`, validateSaasPaymentStanding, signal),
  ]);
  if (account.organizationId !== organization || standing.organizationId !== organization
    || account.current && account.current.organizationId !== organization
    || account.founderReservations.some((r) => r.organizationId !== organization)
    || standing.subscriptionId !== (account.current?.subscriptionId ?? null) || standing.verified.firstPaidAt !== null) invalid();
  // The invoice may belong to an older subscription. Never rewrite historical commercial terms
  // to match today's current subscription, tier, founder offer or entitlement.
  return { invoice, account, standing };
}

export type InvoiceRefundReview = { eligibility: SaasRefundEligibility; matchingRequests: SaasRefundRequest[]; limit: 200 };
export async function loadHqInvoiceRefunds(
  invoice: Pick<SaasInvoiceDetail, 'invoiceId' | 'organizationId' | 'subscriptionId' | 'offerKind'>,
  signal?: AbortSignal,
): Promise<InvoiceRefundReview> {
  const invoiceId = id(invoice.invoiceId), organizationId = id(invoice.organizationId); id(invoice.subscriptionId);
  const [eligibility, requests] = await Promise.all([
    read(`organizations/${organizationId}/refund-eligibility`, validateSaasRefundEligibility, signal),
    read('refunds', validateSaasRefundRequestList, signal),
  ]);
  if (eligibility.organizationId !== organizationId || eligibility.evidenceStrength === 'PROVIDER_VERIFIED'
    || eligibility.invoiceId === invoiceId && (eligibility.subscriptionId !== invoice.subscriptionId || eligibility.offerKind !== invoice.offerKind)
    || requests.refundRequests.some((r) => r.invoiceId === invoiceId && (r.organizationId !== organizationId
      || r.subscriptionId !== invoice.subscriptionId || r.offerKind !== invoice.offerKind || r.evidenceStrength === 'PROVIDER_VERIFIED'))) invalid();
  if (eligibility.invoiceId !== null && [eligibility.invoiceNumber, eligibility.subscriptionId, eligibility.offerKind, eligibility.firstPaidAt, eligibility.windowEndsAt, eligibility.evidenceStrength].some((v) => v === null)) invalid();
  if (eligibility.invoiceId === null && (eligibility.refundableMinor !== 0 || [eligibility.invoiceNumber, eligibility.subscriptionId, eligibility.offerKind, eligibility.windowEndsAt, eligibility.evidenceStrength].some((v) => v !== null))) invalid();
  // This is explicitly a matching subset of a bounded global window, never a complete school,
  // organization or invoice refund history and never evidence that an older request is absent.
  return { eligibility, matchingRequests: requests.refundRequests.filter((r) => r.invoiceId === invoiceId), limit: requests.limit };
}
