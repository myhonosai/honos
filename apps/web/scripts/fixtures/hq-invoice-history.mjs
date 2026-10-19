/** Authorized synthetic localhost records only. Never imported by application source. */
import { saasId, saasAccountFixture } from './hq-saas-review.mjs';
export { saasId };
const at = '2026-10-01T00:00:00.000Z';
const paidAt = '2026-10-02T00:00:00.000Z';
export const invoiceId = (id) => saasId(2000 + id);
export function invoiceFixture(id = 1, { updated = false, empty = false } = {}) {
  const organization = id === 3 ? 3 : id === 2 || id === 5 ? 2 : 1;
  const draft = id === 4, voided = id === 5, lifetime = id === 3;
  const totals = id === 1 ? { subtotalMinor: 4100, taxMinor: 410, totalMinor: 4510 } : lifetime ? { subtotalMinor: 189600, taxMinor: 0, totalMinor: 189600 } : { subtotalMinor: 14900, taxMinor: draft ? null : 0, totalMinor: draft ? null : 14900 };
  const received = empty || draft || voided ? 0 : id === 1 ? updated ? 5010 : 4510 : totals.totalMinor;
  const refunded = empty || draft || voided ? 0 : id === 1 ? 1000 : lifetime ? 189600 : 0;
  const chargebacks = !empty && id === 1 ? 500 : 0;
  const net = empty || draft || voided || lifetime ? 0 : id === 1 ? updated ? 3510 : 3010 : 14900;
  const lines = id === 1 ? [
    { lineKind: 'PLAN_FEE', description: 'HON Core regular monthly · synthetic', amountMinor: 14900, reference: null },
    { lineKind: 'DISCOUNT', description: 'Recorded commercial discount · synthetic', amountMinor: -1000, reference: 'SYNTHETIC-DISCOUNT' },
    { lineKind: 'CORRECTION', description: 'Recorded account correction · synthetic', amountMinor: 200, reference: 'SYNTHETIC-CORRECTION' },
    { lineKind: 'ACCOUNT_CREDIT', description: 'Historically applied subscription account credit · synthetic', amountMinor: -10000, reference: 'SYNTHETIC-CREDIT-RECORD' },
    { lineKind: 'TAX', description: 'Owner-verified tax line · synthetic, not a configured rate', amountMinor: 410, reference: 'SYNTHETIC-TAX' },
  ] : [{ lineKind: 'PLAN_FEE', description: `${lifetime ? 'Paid founder lifetime' : organization === 2 ? 'Founder monthly' : 'Core regular monthly'} · synthetic`, amountMinor: totals.subtotalMinor, reference: null }];
  const evidence = empty || draft || voided ? [] : [
    { evidenceId: saasId(3000 + id * 10), kind: 'PAYMENT_RECEIVED', amountMinor: id === 1 ? 4510 : totals.totalMinor, occurredAt: paidAt, relatedEvidenceId: null, reference: 'SYNTHETIC-PAYMENT-RECORD' },
    ...(refunded ? [{ evidenceId: saasId(3001 + id * 10), kind: 'REFUND', amountMinor: refunded, occurredAt: '2026-10-04T00:00:00.000Z', relatedEvidenceId: saasId(3000 + id * 10), reference: 'SYNTHETIC-REFUND-RECORD' }] : []),
    ...(chargebacks ? [{ evidenceId: saasId(3002 + id * 10), kind: 'CHARGEBACK', amountMinor: 500, occurredAt: '2026-10-06T00:00:00.000Z', relatedEvidenceId: saasId(3000 + id * 10), reference: 'SYNTHETIC-CHARGEBACK-RECORD' }] : []),
    ...(id === 1 && updated ? [{ evidenceId: saasId(3003 + id * 10), kind: 'PAYMENT_RECEIVED', amountMinor: 500, occurredAt: '2026-10-07T00:00:00.000Z', relatedEvidenceId: null, reference: 'SYNTHETIC-REFRESH-PAYMENT' }] : []),
  ].map((e) => ({ ...e, invoiceId: invoiceId(id), source: 'HQ_ATTESTATION', providerVerified: false, currency: 'USD', note: 'Synthetic accounting evidence, no processor connection.', recordedAt: e.occurredAt }));
  return { invoiceId: invoiceId(id), invoiceNumber: draft ? null : `HON-2026-${String(id).padStart(6, '0')}`,
    organizationId: saasId(organization), organizationName: saasAccountFixture({ organizationId: saasId(organization) }).subscription.organizationName,
    subscriptionId: saasId(100 + organization), kind: lifetime ? 'LIFETIME_PURCHASE' : 'SUBSCRIPTION_PERIOD', periodIndex: lifetime ? null : id === 1 ? 1 : 0,
    servicePeriod: { startsAt: draft ? '2026-09-01T00:00:00.000Z' : at, endsAt: lifetime ? null : draft ? at : '2026-11-01T00:00:00.000Z' },
    planCode: organization === 2 ? 'COMPLETE' : 'CORE', offerKind: lifetime ? 'FOUNDER_LIFETIME' : organization === 2 ? 'FOUNDER_MONTHLY' : 'REGULAR_MONTHLY',
    description: `${lifetime ? 'One-time lifetime purchase' : 'HON SaaS service period'} · synthetic authorized fixture`, currency: 'USD',
    status: draft ? 'DRAFT' : voided ? 'VOID' : 'ISSUED', version: updated && id === 1 ? 7 : 6, ...totals,
    taxStatus: draft ? 'UNRESOLVED' : id === 1 ? 'TAX_LINES' : 'NO_TAX_APPLICABLE', taxVerificationReference: draft ? null : 'SYNTHETIC-OWNER-TAX-VERIFICATION',
    settlement: { receivedMinor: received, refundedMinor: refunded, chargedBackMinor: chargebacks, netMinor: net, verifiedNetMinor: 0,
      balanceMinor: draft || voided ? null : id === 1 ? empty ? 4510 : updated ? 1000 : 1500 : lifetime ? 189600 : empty ? 14900 : 0,
      state: draft ? 'NOT_ISSUED' : voided ? 'VOID' : empty ? 'UNPAID' : lifetime ? 'REVERSED' : id === 1 ? 'PARTIALLY_PAID' : 'PAID_ATTESTED' },
    delivery: 'NOT_SENT', collection: 'DISABLED', createdAt: draft ? '2026-09-01T00:00:00.000Z' : id === 2 ? paidAt : at,
    issuedAt: draft ? null : id === 2 ? paidAt : at, voidedAt: voided ? at : null, voidReason: voided ? 'SUPERSEDED' : null,
    updatedAt: updated && id === 1 ? '2026-10-07T00:00:00.000Z' : id === 1 ? '2026-10-06T00:00:00.000Z' : draft ? '2026-09-01T00:00:00.000Z' : lifetime ? '2026-10-04T00:00:00.000Z' : id === 2 ? paidAt : at,
    lines: lines.map((line, index) => ({ lineNumber: index + 1, ...line })), evidence };
}
export function invoiceListFixture({ status = null, empty = false, updated = false } = {}) {
  return { invoices: empty ? [] : [2, 1, 3, 5, 4].map((id) => { const { lines, evidence, ...summary } = invoiceFixture(id, { updated }); return summary; }).filter((i) => !status || i.status === status), limit: 200, collection: 'DISABLED' };
}
export function invoiceAccountFixture(id = 1, { updated = false, empty = false, historical = false } = {}) {
  const invoice = invoiceFixture(id, { updated, empty });
  const { subscription: account, standing } = saasAccountFixture({ organizationId: invoice.organizationId, empty });
  if (account.current && invoice.organizationId === saasId(1)) { account.current.serviceStartedAt = '2026-09-01T00:00:00.000Z'; account.current.currentPeriod.index = 1; }
  if (historical && account.current) { account.current.subscriptionId = saasId(999); standing.subscriptionId = saasId(999); }
  const facts = { firstPaidAt: null, paidThroughAt: null, lifetimePaid: false, paidInvoiceCount: 0, refundedInvoiceCount: 0, chargebackInvoiceCount: 0 };
  standing.verified = { ...facts }; standing.recorded = { ...facts, ...(!empty && invoice.organizationId === saasId(2) ? { firstPaidAt: paidAt, paidInvoiceCount: 1, paidThroughAt: '2026-11-01T00:00:00.000Z' } : {}),
    refundedInvoiceCount: !empty && invoice.organizationId !== saasId(2) ? 1 : 0, chargebackInvoiceCount: !empty && invoice.organizationId === saasId(1) ? 1 : 0 };
  standing.evidence.hqAttested = empty ? 0 : invoice.organizationId === saasId(1) ? updated ? 4 : 3 : invoice.organizationId === saasId(3) ? 2 : 1;
  if (account.history.length) { account.history[0].periodIndex = invoice.organizationId === saasId(1) ? 1 : 0; account.history[0].periodStartsAt = at; account.history[0].periodEndsAt = invoice.organizationId === saasId(3) ? null : '2026-11-01T00:00:00.000Z'; }
  return { invoice, account, standing };
}
function refundRequest(id) {
  const lifetime = id === 3, invoice = invoiceFixture(id);
  return { refundRequestId: saasId(4000 + id), organizationId: invoice.organizationId, organizationName: invoice.organizationName,
    subscriptionId: invoice.subscriptionId, invoiceId: invoice.invoiceId, invoiceNumber: invoice.invoiceNumber, offerKind: invoice.offerKind,
    firstPaidAt: paidAt, windowEndsAt: '2026-11-01T00:00:00.000Z', requestReceivedAt: '2026-10-03T00:00:00.000Z',
    customerReference: lifetime ? 'UNRELATED-PRIVATE-REFUND-REFERENCE' : 'SYNTHETIC-CUSTOMER-REQUEST', requestedAmountMinor: lifetime ? 189600 : 4510,
    approvedAmountMinor: lifetime ? 189600 : 4510, evidenceStrength: 'HQ_ATTESTED', status: lifetime ? 'REFUND_EVIDENCED' : 'APPROVED',
    statusReason: lifetime ? 'REFUND_EVIDENCE_RECORDED' : 'GUARANTEE_APPROVED', version: lifetime ? 3 : 2, note: 'Synthetic refund request · no execution',
    execution: 'UNAVAILABLE', executionStatus: 'NOT_EXECUTED', subscriptionConsequence: 'BLOCKED_PENDING_TERMS', refundEvidencedMinor: lifetime ? 189600 : 1000,
    createdAt: '2026-10-03T00:00:00.000Z', decidedAt: lifetime ? '2026-10-04T00:00:00.000Z' : '2026-10-03T01:00:00.000Z' };
}
export function invoiceRefundFixture(id = 1, { updated = false, empty = false } = {}) {
  const invoice = invoiceFixture(id), firstId = id === 4 ? 1 : id === 5 ? 2 : id;
  const first = invoiceFixture(firstId), lifetime = firstId === 3;
  return {
    eligibility: { organizationId: invoice.organizationId, eligible: !empty && firstId === 2,
      refusal: empty ? 'SAAS_REFUND_NO_PAID_PURCHASE' : firstId === 2 ? null : lifetime ? 'SAAS_REFUND_ALREADY_GRANTED' : 'SAAS_REFUND_REQUEST_OPEN',
      invoiceId: empty ? null : first.invoiceId, invoiceNumber: empty ? null : first.invoiceNumber, subscriptionId: empty ? null : first.subscriptionId,
      offerKind: empty ? null : first.offerKind, firstPaidAt: empty ? null : paidAt, windowEndsAt: empty ? null : '2026-11-01T00:00:00.000Z',
      requestReceivedAt: '2026-10-19T00:00:00.000Z', refundableMinor: empty || lifetime ? 0 : firstId === 2 ? 14900 : updated ? 3510 : 3010,
      evidenceStrength: empty ? null : 'HQ_ATTESTED', execution: 'UNAVAILABLE' },
    requests: { refundRequests: empty ? [] : [refundRequest(3), refundRequest(1)], limit: 200, execution: 'UNAVAILABLE' },
  };
}
