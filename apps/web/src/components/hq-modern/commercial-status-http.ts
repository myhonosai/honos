import {
  validateSaasCreditProgramView, validateSaasPaymentsView,
  type SaasCreditProgram, type SaasPaymentProgram,
} from '@hon/contracts';

export type CommercialStatusFailure = 'UNAUTHORIZED' | 'FORBIDDEN' | 'UNAVAILABLE' | 'INVALID_RESPONSE';
export class HqCommercialStatusError extends Error {
  constructor(readonly kind: CommercialStatusFailure) { super('The HQ commercial program status could not be verified.'); }
}

/** Only the program fields are kept; checkouts, provider events and organizations in the same response are discarded. */
export type PaymentProgramStatus = Pick<SaasPaymentProgram, 'status' | 'mode' | 'liveMode' | 'refundExecution' | 'changedAt'> & { asOf: string };
export type CreditProgramStatus = Pick<SaasCreditProgram, 'status' | 'topUps' | 'overage' | 'purchases' | 'changedAt'>;

/** Private fixed-resource reader. No caller-supplied URLs, actor, tenant scope or commands. */
async function read<T>(resource: 'payments' | 'credits', validate: (value: unknown) => T, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/v1/hq/saas/${resource}`, {
      method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' }, ...(signal ? { signal } : {}),
    });
  } catch (error) { if (signal?.aborted) throw error; throw new HqCommercialStatusError('UNAVAILABLE'); }
  // Error bodies can contain private details and are never authorized projections.
  if (!response.ok) throw new HqCommercialStatusError(response.status === 401 ? 'UNAUTHORIZED' : response.status === 403 ? 'FORBIDDEN' : 'UNAVAILABLE');
  try {
    const envelope: unknown = await response.json();
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) || Object.keys(envelope).length !== 1 || !Object.hasOwn(envelope, 'data')) throw Error();
    return validate((envelope as { data: unknown }).data);
  } catch { throw new HqCommercialStatusError('INVALID_RESPONSE'); }
}

export async function loadHqPaymentProgramStatus(signal?: AbortSignal): Promise<PaymentProgramStatus> {
  const view = await read('payments', validateSaasPaymentsView, signal);
  const { status, mode, liveMode, refundExecution, changedAt } = view.program;
  return { status, mode, liveMode, refundExecution, changedAt, asOf: view.asOf };
}

export async function loadHqCreditProgramStatus(signal?: AbortSignal): Promise<CreditProgramStatus> {
  const view = await read('credits', validateSaasCreditProgramView, signal);
  const { status, topUps, overage, purchases, changedAt } = view.program;
  return { status, topUps, overage, purchases, changedAt };
}
