import {
  saasUuid, validateSaasCatalogView, validateSaasSubscriptionList, validateSaasSubscriptionStatusFilter,
  validateSaasCreditProgramView, validateSaasOrganizationSubscription, validateSaasPaymentStanding, validateSaasOrganizationCredits,
  type SaasCatalogView, type SaasSubscriptionList, type SaasSubscriptionStatus, type SaasCreditProgramView,
  type SaasOrganizationSubscription, type SaasPaymentStanding, type SaasOrganizationCredits,
} from '@hon/contracts';

export type SaasReviewFailure = 'UNAUTHORIZED' | 'FORBIDDEN' | 'UNAVAILABLE' | 'INVALID_RESPONSE' | 'INVALID_SELECTION';
export class HqSaasReviewError extends Error {
  constructor(readonly kind: SaasReviewFailure) { super('The authorized HON subscription records could not be verified.'); }
}

/** Private fixed-resource reader. No caller-supplied URLs, actor, tenant scope or commands. */
async function read<T>(path: string, validate: (value: unknown) => T, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/v1/hq/saas/${path}`, {
      method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' }, ...(signal ? { signal } : {}),
    });
  } catch (error) { if (signal?.aborted) throw error; throw new HqSaasReviewError('UNAVAILABLE'); }
  // Error bodies can contain private details and are never authorized projections.
  if (!response.ok) throw new HqSaasReviewError(response.status === 401 ? 'UNAUTHORIZED' : response.status === 403 ? 'FORBIDDEN' : 'UNAVAILABLE');
  try {
    const envelope: unknown = await response.json();
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) || Object.keys(envelope).length !== 1 || !Object.hasOwn(envelope, 'data')) throw Error();
    return validate((envelope as { data: unknown }).data);
  } catch { throw new HqSaasReviewError('INVALID_RESPONSE'); }
}

export type SaasReviewOverview = { catalog: SaasCatalogView; subscriptions: SaasSubscriptionList; credits: SaasCreditProgramView };
export async function loadHqSaasReview(status: SaasSubscriptionStatus | null, signal?: AbortSignal): Promise<SaasReviewOverview> {
  let filter: SaasSubscriptionStatus | null;
  try { filter = validateSaasSubscriptionStatusFilter(status === null ? undefined : status); }
  catch { throw new HqSaasReviewError('INVALID_SELECTION'); }
  const [catalog, subscriptions, credits] = await Promise.all([
    read('catalog', validateSaasCatalogView, signal),
    read(`subscriptions${filter ? `?status=${filter}` : ''}`, validateSaasSubscriptionList, signal),
    read('credits', validateSaasCreditProgramView, signal),
  ]);
  if (filter && subscriptions.subscriptions.some((s) => s.status !== filter)) throw new HqSaasReviewError('INVALID_RESPONSE');
  return { catalog, subscriptions, credits };
}

export type SaasAccountReview = { subscription: SaasOrganizationSubscription; standing: SaasPaymentStanding; credits: SaasOrganizationCredits };
export async function loadHqSaasAccount(organizationId: string, signal?: AbortSignal): Promise<SaasAccountReview> {
  let org: string;
  try { org = saasUuid(organizationId); } catch { throw new HqSaasReviewError('INVALID_SELECTION'); }
  const [subscription, standing, credits] = await Promise.all([
    read(`organizations/${org}/subscription`, validateSaasOrganizationSubscription, signal),
    read(`organizations/${org}/payment-standing`, validateSaasPaymentStanding, signal),
    read(`organizations/${org}/credits`, validateSaasOrganizationCredits, signal),
  ]);
  // Separate reads are not atomic. Refuse changed current subscriptions or mixed organizations.
  if ([subscription.organizationId, standing.organizationId, credits.organizationId].some((id) => id !== org)
    || subscription.current && subscription.current.organizationId !== org
    || subscription.founderReservations.some((r) => r.organizationId !== org)
    || credits.allowances.some((a) => a.organizationId !== org) || credits.reservations.some((r) => r.organizationId !== org)
    || standing.subscriptionId !== (subscription.current?.subscriptionId ?? null)
    || credits.subscriptionId !== (subscription.current?.subscriptionId ?? null)
    || standing.verified.firstPaidAt !== null) throw new HqSaasReviewError('INVALID_RESPONSE');
  return { subscription, standing, credits };
}
