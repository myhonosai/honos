'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { HqInvoiceReadError, type InvoiceReadFailure } from './invoice-history-http';
import { formatSaasMoney } from './saas-review';
import base from './hq-modern.module.css';

export type InvoiceReadState<T> = { key: string; kind: 'idle' } | { key: string; kind: 'loading' }
  | { key: string; kind: 'ready'; data: T; retrievedAt: string } | { key: string; kind: 'failed'; failure: InvoiceReadFailure };
export function useInvoiceRead<T>(key: string, load: ((signal: AbortSignal) => Promise<T>) | null): InvoiceReadState<T> {
  const [state, setState] = useState<InvoiceReadState<T>>({ key: '', kind: 'idle' });
  useEffect(() => {
    const controller = new AbortController(); let current = true;
    if (!load) { setState({ key, kind: 'idle' }); return () => { current = false; controller.abort(); }; }
    setState({ key, kind: 'loading' });
    load(controller.signal).then((data) => { if (current) setState({ key, kind: 'ready', data, retrievedAt: new Date().toISOString() }); },
      (error: unknown) => { if (current) setState({ key, kind: 'failed', failure: error instanceof HqInvoiceReadError ? error.kind : 'UNAVAILABLE' }); });
    return () => { current = false; controller.abort(); };
  }, [key, load]);
  // Clear prior-scope facts during render, before the next request effect runs.
  return state.key === key ? state : { key, kind: load ? 'loading' : 'idle' };
}
export const invoiceStatus = { DRAFT: 'Draft', ISSUED: 'Issued record', VOID: 'Void' };
export const invoiceOffer = { REGULAR_MONTHLY: 'Regular monthly', FOUNDER_MONTHLY: 'Founder monthly', FOUNDER_LIFETIME: 'Paid founder lifetime offer' };
export const settlementLabel = {
  NOT_ISSUED: 'Not issued', VOID: 'Void', UNPAID: 'No payment recorded', PARTIALLY_PAID: 'Partially paid in recorded evidence',
  PAID_ATTESTED: 'Recorded as paid by HQ (not processor-confirmed)', PAID_VERIFIED: 'Provider-confirmed payment', REVERSED: 'Reversed in recorded evidence',
};
export const invoiceTime = (value: string | null): string => value === null ? 'Not recorded' : `${new Date(value).toLocaleString('en-US', { timeZone: 'UTC' })} UTC`;
export const invoiceAmount = (value: number | null): string => value === null ? 'Unavailable / tax unresolved' : `${value < 0 ? '−' : ''}${formatSaasMoney(Math.abs(value))}`;

export function InvoiceReadNotice<T>({ state, area }: { state: InvoiceReadState<T>; area: string }): React.ReactElement | null {
  if (state.kind === 'ready' || state.kind === 'idle') return null;
  const heading = state.kind === 'loading' ? `Loading ${area}…` : state.failure === 'UNAUTHORIZED' ? 'Sign in to review HON billing records'
    : state.failure === 'FORBIDDEN' ? 'HON billing access denied' : state.failure === 'INVALID_RESPONSE' ? `${area} could not be verified`
    : state.failure === 'INVALID_SELECTION' ? 'Choose a valid invoice or status' : `${area} unavailable`;
  return <section className={base.panel} role="status"><h2>{heading}</h2><p>Previous facts are cleared. Refresh to request current authorized records. No cached or sample result is substituted.</p>{state.kind === 'failed' && state.failure === 'UNAUTHORIZED' && <Link href="/auth/login">Sign in to HON</Link>}</section>;
}
