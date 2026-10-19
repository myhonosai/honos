'use client';

import React, { useCallback, useState } from 'react';
import Link from 'next/link';
import { SAAS_INVOICE_STATUSES, type SaasInvoiceList, type SaasInvoiceStatus } from '@hon/contracts';
import { loadHqInvoiceList } from './invoice-history-http';
import { useInvoiceRead, InvoiceReadNotice, invoiceAmount, invoiceTime, invoiceOffer, invoiceStatus, settlementLabel } from './invoice-history-shared';
import base from './hq-modern.module.css';
import shared from './champions-management.module.css';
import styles from './invoice-history.module.css';

export function InvoiceListResults({ data, organizationId, query }: { data: SaasInvoiceList; organizationId: string; query: string }): React.ReactElement {
  const search = query.trim().toLocaleLowerCase('en-US');
  const records = data.invoices.filter((invoice) => (!organizationId || invoice.organizationId === organizationId)
    && `${invoice.invoiceNumber ?? ''} ${invoice.organizationName} ${invoice.description}`.toLocaleLowerCase('en-US').includes(search));
  return <section className={base.panel} data-invoice-list><h2>Recent HON invoices</h2>
    <p className={shared.note}>Newest 200 matching invoices at most, in server order. Organization and text filters search only this returned window. This is not complete school history or a revenue total.</p>
    {!records.length && <p role="status">No invoice records in the returned window match this selection.</p>}
    <ul className={styles.records}>{records.map((invoice) => <li key={invoice.invoiceId}>
      <div className={base.sectionHeader}><h3>{invoice.invoiceNumber ?? (invoice.status === 'VOID' ? 'Unnumbered void record' : 'Unnumbered draft record')}</h3><span className={base.badge}>{invoiceStatus[invoice.status]}</span></div>
      <p dir="auto"><strong>{invoice.organizationName}</strong></p><p>{invoice.planCode} · {invoiceOffer[invoice.offerKind]}</p>
      <p className={styles.amount}>Recorded total: {invoiceAmount(invoice.totalMinor)}</p>
      <p>{settlementLabel[invoice.settlement.state]}</p>
      <p className={shared.note}>{invoice.kind === 'LIFETIME_PURCHASE' ? 'One-time lifetime purchase; no recurring service end.' : `Service period ${invoiceTime(invoice.servicePeriod.startsAt)} – ${invoiceTime(invoice.servicePeriod.endsAt)}`}</p>
      <Link className={shared.link} href={`/hq/revenue/invoices/${invoice.invoiceId}`} prefetch={false} aria-label={`Review ${invoice.invoiceNumber ?? (invoice.status === 'VOID' ? 'void invoice' : 'draft invoice')} for ${invoice.organizationName}`}>Review invoice &amp; payment history →</Link>
    </li>)}</ul>
  </section>;
}

export function HqInvoiceHistory(): React.ReactElement {
  const [status, setStatus] = useState<SaasInvoiceStatus | null>(null);
  const [revision, setRevision] = useState(0);
  const [query, setQuery] = useState('');
  const [organizationId, setOrganizationId] = useState('');
  const load = useCallback((signal: AbortSignal) => loadHqInvoiceList(status, signal), [status]);
  const state = useInvoiceRead(`${status}:${revision}`, load);
  const organizations = state.kind === 'ready' ? [...new Map(state.data.invoices.map((invoice) => [invoice.organizationId, invoice.organizationName])).entries()] : [];
  return <div className={shared.management}>
    <section className={`${base.panel} ${shared.intro}`}><span className={base.badge}>HON billing · read only</span><div className={shared.introHeading}><h2>Invoices &amp; payment history</h2><button type="button" disabled={state.kind === 'loading'} onClick={() => { setQuery(''); setOrganizationId(''); setRevision((r) => r + 1); }}>Refresh invoices</button></div>
      <p>Review HON SaaS billing records for authorized organizations. An organization may cover multiple schools. School-to-family billing is separate.</p><div className={styles.links}><Link className={shared.link} href="/hq/revenue">← Subscription account review</Link><Link className={shared.link} href="/hq/schools">School directory</Link></div>
    </section>
    <section className={base.panel}><div className={styles.filters}>
      <div><label htmlFor="hon-invoice-status">Invoice status</label><select id="hon-invoice-status" value={status ?? ''} onChange={(e) => { setOrganizationId(''); setQuery(''); setStatus(e.target.value ? e.target.value as SaasInvoiceStatus : null); }}><option value="">All recorded states</option>{SAAS_INVOICE_STATUSES.map((value) => <option key={value} value={value}>{invoiceStatus[value]}</option>)}</select></div>
      <div><label htmlFor="hon-invoice-organization">Billing organization in returned invoices</label><select id="hon-invoice-organization" value={organizationId} disabled={state.kind !== 'ready'} onChange={(e) => setOrganizationId(e.target.value)}><option value="">All returned organizations</option>{organizations.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></div>
      <div><label htmlFor="hon-invoice-search">Search returned invoice records</label><input id="hon-invoice-search" type="search" autoComplete="off" disabled={state.kind !== 'ready'} value={query} onChange={(e) => setQuery(e.target.value)}/></div>
    </div></section>
    <div className={shared.results} aria-live="polite" aria-busy={state.kind === 'loading'}><InvoiceReadNotice state={state} area="Invoice list"/>{state.kind === 'ready' && <><p className={shared.note} role="status">Retrieved {invoiceTime(state.retrievedAt)} · refresh to recheck.</p><InvoiceListResults data={state.data} organizationId={organizationId} query={query}/></>}</div>
    <section className={base.panel}><h2>School history availability</h2><p className={shared.note}>Verified school-to-billing-organization selection and complete paginated school invoice history require a backend contract. Names are not used to infer that relationship. This workspace reviews authoritative organization invoices from the returned window.</p><p className={shared.note}>Collection, invoice delivery and financial commands remain unavailable here. No charge, refund, founder reservation or subscription change can be made.</p></section>
  </div>;
}
