'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { SAAS_SUBSCRIPTION_STATUSES, type SaasSubscription, type SaasSubscriptionStatus } from '@hon/contracts';
import { HqSaasReviewError, loadHqSaasReview, loadHqSaasAccount, type SaasReviewFailure, type SaasReviewOverview, type SaasAccountReview } from './saas-review-http';
import base from './hq-modern.module.css';
import shared from './champions-management.module.css';
import styles from './saas-review.module.css';

export const subscriptionStatus: Record<SaasSubscriptionStatus, string> = {
  PENDING_ACTIVATION: 'Pending activation', IN_SERVICE: 'Service period recorded', SUSPENDED: 'Suspended', VOIDED: 'Voided',
};
const offers = { REGULAR_MONTHLY: 'Regular monthly', FOUNDER_MONTHLY: 'Founder monthly', FOUNDER_LIFETIME: 'Paid founder lifetime' };
const n = (value: number) => value.toLocaleString('en-US');
const time = (value: string | null) => value === null ? 'Not recorded' : `${new Date(value).toLocaleString('en-US', { timeZone: 'UTC' })} UTC`;
/** Both contracts use USD; preserve every minor/micro unit, with no assumed unit economics. */
export function formatSaasMoney(value: number, precision: 2 | 6 = 2): string {
  const amount = BigInt(value), scale = 10n ** BigInt(precision);
  return `USD ${(amount / scale).toLocaleString('en-US')}.${(amount % scale).toString().padStart(precision, '0')}`;
}
type ReadState<T> = { key: string; kind: 'idle' } | { key: string; kind: 'loading' } | { key: string; kind: 'ready'; data: T; at: string }
  | { key: string; kind: 'failed'; failure: SaasReviewFailure };
function useReview<T>(key: string, load: ((signal: AbortSignal) => Promise<T>) | null): ReadState<T> {
  const [state, setState] = useState<ReadState<T>>({ key: '', kind: 'idle' });
  useEffect(() => {
    let current = true; const controller = new AbortController();
    if (!load) { setState({ key, kind: 'idle' }); return () => { current = false; controller.abort(); }; }
    setState({ key, kind: 'loading' });
    load(controller.signal).then((data) => { if (current) setState({ key, kind: 'ready', data, at: new Date().toISOString() }); },
      (error: unknown) => { if (current) setState({ key, kind: 'failed', failure: error instanceof HqSaasReviewError ? error.kind : 'UNAVAILABLE' }); });
    return () => { current = false; controller.abort(); };
  }, [key, load]);
  return state.key === key ? state : { key, kind: load ? 'loading' : 'idle' };
}
function ReadNotice<T>({ state }: { state: ReadState<T> }): React.ReactElement | null {
  if (state.kind === 'ready' || state.kind === 'idle') return null;
  const heading = state.kind === 'loading' ? 'Loading authorized subscription records…'
    : state.failure === 'UNAUTHORIZED' ? 'Sign in to review HON subscriptions'
    : state.failure === 'FORBIDDEN' ? 'HON billing access denied'
    : state.failure === 'INVALID_RESPONSE' ? 'Subscription records could not be verified'
    : state.failure === 'INVALID_SELECTION' ? 'Choose a valid organization or status' : 'HON subscription records unavailable';
  return <section className={base.panel} role="status"><h2>{heading}</h2><p>Previous facts are cleared. Refresh to check current records; if records changed during retrieval, refresh the overview.</p>{state.kind === 'failed' && state.failure === 'UNAUTHORIZED' && <Link href="/auth/login">Sign in to HON</Link>}</section>;
}
function RecordPrice({ subscription: s }: { subscription: SaasSubscription }): React.ReactElement {
  return <>{s.priceMinor === null ? 'No recorded price · legacy entitlement' : `${formatSaasMoney(s.priceMinor)}${s.billingInterval === 'MONTHLY' ? ' / month' : ' · one-time recorded price'}`}</>;
}

export function SaasInventory({ catalog }: Pick<SaasReviewOverview, 'catalog'>): React.ReactElement {
  const inventory = catalog.founderInventory;
  const available = (value: number | null) => value === null ? 'Unavailable / undecided' : n(value);
  return <section className={base.panel}><div className={base.sectionHeader}><h2>Founder inventory</h2><span className={base.badge}>{inventory.status.replaceAll('_', ' ')}</span></div><p className={shared.note}>Available, reserved and allocated slots are reported by HON. Allocated does not mean paid. Monthly and lifetime pools remain separate.</p>
    <div className={styles.inventory} data-saas-inventory>{(['monthly', 'lifetime'] as const).map((pool) => <section key={pool}><h3>{pool === 'monthly' ? 'Founder monthly' : 'Paid founder lifetime'}</h3><dl className={shared.facts}><div><dt>Available slots</dt><dd data-founder-available={pool}>{available(inventory.remaining[pool])}</dd></div><div><dt>Reserved slots</dt><dd>{n(inventory[pool].held)}</dd></div><div><dt>Allocated slots</dt><dd>{n(inventory[pool].allocated)}</dd></div><div><dt>Configured limit</dt><dd>{available(pool === 'monthly' ? inventory.monthlyLimit : inventory.lifetimeLimit)}</dd></div></dl></section>)}</div>
    <p className={shared.note}>Total available slots: {available(inventory.remaining.total)} · total configured limit: {available(inventory.totalLimit)}. No availability is calculated from the recent subscription window.</p>
  </section>;
}

export function SaasCatalogAndCosts({ data }: { data: SaasReviewOverview }): React.ReactElement {
  const published = data.catalog.published;
  return <>
    <details className={`${base.panel} ${styles.disclosure}`}><summary>Published plans, offers and functional entitlements</summary>
      {!published ? <p>No published catalog was returned. Drafts and approved commercial intent are not active offers.</p> : <><p className={shared.note}>Catalog v{published.catalogVersion}. Recorded prices are not revenue, charges or received payments. Functional access remains governed by each organization's live entitlement.</p><div className={styles.inventory}>{published.plans.map((plan) => <section key={plan.planCode}><h3>{plan.displayName}</h3><p>{plan.availability === 'LEGACY_ONLY' ? 'Legacy only · preserved' : 'Public plan'}</p><p className={shared.note}>Planned monthly premium allowance: {plan.plannedMonthlyPremiumCredits === null ? 'Not configured' : n(plan.plannedMonthlyPremiumCredits)} · not a granted balance.</p><ul>{plan.capabilities.map((capability) => <li key={capability}>{capability}</li>)}</ul>{published.offers.filter((offer) => offer.planCode === plan.planCode).map((offer) => <p key={offer.offerId}>{offers[offer.offerKind]} · {formatSaasMoney(offer.priceMinor)}{offer.billingInterval === 'MONTHLY' ? ' / month' : ' one-time'}</p>)}</section>)}</div></>}
    </details>
    <details className={`${base.panel} ${styles.disclosure}`} id="saas-provider-costs"><summary>Verified provider-cost evidence and premium program</summary><p>Credit accounting program: {data.credits.program.status}. Purchases and overage remain disabled; top-ups unavailable. Ordinary HON use does not deduct premium credits.</p><p className={shared.note}>Newest 50 HQ owner-verified provider-billing evidence records at most. These are recorded cost evidence, not live rates, payment verification or total company AI spend.</p>
      {!data.credits.costEvidence.length && <p>No verified provider-cost evidence was returned. Missing evidence is not a zero cost.</p>}
      <ul className={styles.records}>{data.credits.costEvidence.map((evidence) => <li key={evidence.costEvidenceId}><h3>{evidence.providerId} · {evidence.modelCode}</h3><dl className={shared.facts}><div><dt>Recorded billed cost</dt><dd>{formatSaasMoney(evidence.billedCostMicrounits, 6)}</dd></div><div><dt>Fully loaded cost</dt><dd>{formatSaasMoney(evidence.fullyLoadedCostMicrounits, 6)}</dd></div><div><dt>Measured units / unit</dt><dd>{n(evidence.measuredUnits)} / {evidence.costUnit}</dd></div><div><dt>Fully loaded cost per unit</dt><dd>{formatSaasMoney(evidence.fullyLoadedCostMicrounitsPerUnit, 6)}</dd></div><div><dt>Evidence source</dt><dd>HQ owner-verified provider billing<small>{evidence.evidenceReference}</small></dd></div><div><dt>Covered period</dt><dd>{time(evidence.periodStart)} – {time(evidence.periodEnd)}</dd></div></dl></li>)}</ul>
      <p className={shared.note}>Published premium pricing: {data.credits.publishedPricing ? `v${data.credits.publishedPricing.pricingVersion}` : 'Unavailable / unpublished'}. This screen cannot publish pricing or activate the program.</p>
    </details>
  </>;
}

export function SaasAccountResults({ data }: { data: SaasAccountReview }): React.ReactElement {
  const { subscription: account, standing, credits } = data;
  return <div className={shared.results} data-saas-account={account.organizationId}>
    <section className={base.panel}><div className={base.sectionHeader}><h2 dir="auto">{account.organizationName}</h2><span className={base.badge}>{account.organizationStatus}</span></div><dl className={shared.facts}>
      <div><dt>Entitlement record</dt><dd>{account.entitlement ? `${account.entitlement.tier} · ${account.entitlement.status}` : 'No entitlement record'}<small>{account.entitlement && `Effective ${time(account.entitlement.effectiveFrom)} · ${account.entitlement.effectiveUntil ? `until ${time(account.entitlement.effectiveUntil)}` : 'no scheduled end'}`}</small></dd></div>
      <div><dt>Subscription / entitlement alignment</dt><dd>{account.alignment.replaceAll('_', ' ')}<small>Server-reported alignment. Recording a subscription does not grant or change functional access.</small></dd></div>
      <div><dt>Current subscription</dt><dd>{account.current ? `${account.current.planCode} · ${subscriptionStatus[account.current.status]}` : 'No current subscription'}<small>{account.current && (account.current.offerKind ? offers[account.current.offerKind] : 'Legacy entitlement')}</small></dd></div>
      {account.current && <><div><dt>Recorded price</dt><dd><RecordPrice subscription={account.current}/><small>Not paid or charged</small></dd></div><div><dt>Recorded service period</dt><dd>{account.current.currentPeriod ? `${time(account.current.currentPeriod.startsAt)} – ${account.current.currentPeriod.endsAt ? time(account.current.currentPeriod.endsAt) : 'no recorded service end'}` : 'No recorded service period'}<small>{account.current.billingInterval === 'LIFETIME' ? 'Lifetime has no recorded service end; it is not proof of payment.' : 'Recorded service periods are not proof of payment.'}</small></dd></div></>}
    </dl></section>
    <section className={base.panel}><h2>Recorded versus provider-verified payments</h2><p className={shared.note}>HQ bookkeeping evidence is not processor confirmation. Payment collection and provider verification are not configured. Recorded standing cannot qualify a Champions referral.</p><div className={styles.inventory}>{(['recorded', 'verified'] as const).map((kind) => <section key={kind}><h3>{kind === 'recorded' ? 'Recorded standing · includes HQ attestations' : 'Provider-verified standing'}</h3><dl className={shared.facts}><div><dt>Paid invoices in this standing</dt><dd>{n(standing[kind].paidInvoiceCount)}</dd></div><div><dt>Refunded / chargeback invoices</dt><dd>{n(standing[kind].refundedInvoiceCount)} / {n(standing[kind].chargebackInvoiceCount)}</dd></div><div><dt>First recorded paid date</dt><dd>{time(standing[kind].firstPaidAt)}</dd></div><div><dt>Paid through in this standing</dt><dd>{time(standing[kind].paidThroughAt)}</dd></div><div><dt>Lifetime purchase recorded paid</dt><dd>{standing[kind].lifetimePaid ? 'Recorded in this standing' : 'Not established'}</dd></div></dl></section>)}</div><p className={shared.note}>HQ-attested evidence entries: {n(standing.evidence.hqAttested)} · provider-verified evidence entries: {n(standing.evidence.providerVerified)}. Provider verification: not configured. Invoice list, invoice detail and individual evidence history are not available in this screen yet.</p></section>
    <section className={base.panel}><h2>AI credit allowance records</h2><p className={shared.note}>Account program: {credits.program.status}. Up to 12 allowance periods returned, each with its own backend-calculated balance. No aggregate balance or spend authority is inferred. No rollover, top-ups or automatic overage.</p>
      {!credits.allowances.length && <p>No allowance records were returned. A planned catalog allowance is not a granted balance.</p>}
      <ul className={styles.records}>{credits.allowances.map((a) => <li key={a.allowanceId}><h3>{a.planCode} · {a.allowanceBasis} · {a.status}</h3><p className={shared.note}>{time(a.periodStart)} – {time(a.periodEnd)}</p><dl className={shared.states}>{[['Allowance', a.balance.allowanceCredits], ['Consumed', a.balance.consumedCredits], ['Held', a.balance.heldCredits], ['Expired', a.balance.expiredCredits], ['Available', a.balance.availableCredits]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{n(value as number)}</dd></div>)}</dl><p className={shared.note}>Recorded committed usage: {a.balance.usedPercent}% · availability applies to this recorded period, not authorization to spend. Threshold events: {a.thresholds.length ? a.thresholds.map((t) => `${t.thresholdPercent}% reached; notification not sent`).join(' · ') : 'None returned'}.</p></li>)}</ul>
      <h3>Ordinary use this UTC month</h3><p>{n(credits.ordinaryUsageThisMonth.events)} recorded events · recorded provider usage cost {formatSaasMoney(credits.ordinaryUsageThisMonth.providerCostMicrounits, 6)}.</p><p className={shared.note}>Premium deduction: none. Usage-ledger cost is separate from verified provider-billing evidence.</p>
    </section>
    <section className={base.panel}><h2>Recent premium reservations</h2><p className={shared.note}>Newest 50 reservations at most. Reserved or unknown outcomes remain held; they are not successful jobs or collected money. Costs below are usage records, not verified provider invoices.</p>{!credits.reservations.length && <p>No premium reservations were returned.</p>}<ul className={styles.records}>{credits.reservations.map((r) => <li key={r.reservationId}><h3>{r.operationCode} · {r.status.replaceAll('_', ' ')}</h3><p>{n(r.reservedCredits)} reserved credits · {r.finalCredits === null ? 'No finalized usage' : `${n(r.finalCredits)} finalized credits`}.</p><p>{r.providerId} / {r.modelCode} · {r.providerCostMicrounits === null ? 'Provider usage cost not recorded' : `Recorded usage cost ${formatSaasMoney(r.providerCostMicrounits, 6)}`}</p><p className={shared.note}>Reserved {time(r.reservedAt)} · {r.statusReason.replaceAll('_', ' ')}. No resolve or retry command is available here.</p></li>)}</ul></section>
    <details className={`${base.panel} ${styles.disclosure}`}><summary>Subscription history and founder reservations</summary><p className={shared.note}>Newest 50 subscription events and 20 founder reservations at most; not complete account history.</p>{!account.history.length && <p>No subscription history events returned.</p>}<ul>{account.history.map((h, i) => <li key={`${h.subscriptionId}:${h.version}:${i}`}>{subscriptionStatus[h.status]} · {h.statusReason.replaceAll('_', ' ')} · {time(h.occurredAt)}</li>)}</ul>{!account.founderReservations.length && <p>No founder reservations returned.</p>}<ul>{account.founderReservations.map((r) => <li key={r.reservationId}>{offers[r.offerKind]} · {r.status}{r.holdExpired ? ' · hold expired' : ''} · hold expiry {time(r.holdExpiresAt)}</li>)}</ul></details>
  </div>;
}

export function HqSaasReview(): React.ReactElement {
  const [status, setStatus] = useState<SaasSubscriptionStatus | null>(null);
  const [revision, setRevision] = useState(0);
  const [query, setQuery] = useState('');
  const overviewKey = `${status}:${revision}`;
  const overviewLoad = useCallback((signal: AbortSignal) => loadHqSaasReview(status, signal), [status]);
  const overview = useReview(overviewKey, overviewLoad);
  const [selected, setSelected] = useState<{ key: string; organizationId: string } | null>(null);
  const [accountRevision, setAccountRevision] = useState(0);
  const accountHeading = useRef<HTMLHeadingElement>(null);
  const accountOpener = useRef<HTMLElement | null>(null);
  const organizationId = overview.kind === 'ready' && selected?.key === overviewKey
    && overview.data.subscriptions.subscriptions.some((s) => s.organizationId === selected.organizationId) ? selected.organizationId : null;
  const accountLoad = useCallback((signal: AbortSignal) => loadHqSaasAccount(organizationId!, signal), [organizationId]);
  const account = useReview(`${overviewKey}:${organizationId}:${accountRevision}`, organizationId ? accountLoad : null);
  useEffect(() => { if (organizationId) { accountHeading.current?.focus(); accountHeading.current?.scrollIntoView({ block: 'start', behavior: 'auto' }); } }, [organizationId]);
  const records = overview.kind === 'ready' ? overview.data.subscriptions.subscriptions.filter((s) => `${s.organizationName} ${s.planCode} ${s.offerKind ?? 'legacy'}`.toLocaleLowerCase('en-US').includes(query.trim().toLocaleLowerCase('en-US'))) : [];
  return <div className={shared.management}>
    <section className={`${base.panel} ${shared.intro}`}><span className={base.badge}>HON billing · HQ only</span><div className={shared.introHeading}><h2>Subscription account review</h2><button type="button" disabled={overview.kind === 'loading'} onClick={() => { setSelected(null); setQuery(''); setRevision((r) => r + 1); }}>Refresh subscription overview</button></div><p>HON subscriptions belong to organizations and may cover multiple schools. Financial activation remains disabled. School-to-family billing is separate.</p></section>
    <section className={base.panel}><div className={styles.filters}><div><label htmlFor="saas-subscription-status">Subscription status</label><select id="saas-subscription-status" value={status ?? ''} onChange={(e) => { setSelected(null); setStatus(e.target.value ? e.target.value as SaasSubscriptionStatus : null); }}><option value="">All recorded states</option>{SAAS_SUBSCRIPTION_STATUSES.map((s) => <option key={s} value={s}>{subscriptionStatus[s]}</option>)}</select></div><div><label htmlFor="saas-record-search">Find organization in returned records</label><input id="saas-record-search" type="search" autoComplete="off" value={query} disabled={overview.kind !== 'ready'} onChange={(e) => { setQuery(e.target.value); setSelected(null); }}/></div></div></section>
    {organizationId && <div className={styles.accountHeading}><h2 ref={accountHeading} tabIndex={-1}>Selected organization</h2><button type="button" disabled={account.kind === 'loading'} onClick={() => setAccountRevision((r) => r + 1)}>Refresh account records</button><button type="button" onClick={() => { setSelected(null); requestAnimationFrame(() => accountOpener.current?.focus()); }}>Close account review</button></div>}
    <div className={shared.results} aria-live="polite" aria-busy={account.kind === 'loading'}><ReadNotice state={account}/>{account.kind === 'ready' && <><p className={shared.note} role="status">Account retrieved {time(account.at)} · separate reads, refresh to recheck.</p><SaasAccountResults data={account.data}/></>}</div>
    <div className={shared.results} aria-live="polite" aria-busy={overview.kind === 'loading'}><ReadNotice state={overview}/>{overview.kind === 'ready' && <>
      <p className={shared.note} role="status">Overview retrieved {time(overview.at)} · refresh to recheck. Separate service reads are not an atomic snapshot.</p>
      <section className={base.panel}><h2>Recent subscription records</h2><p className={shared.note}>Newest 200 matching records at most, in server order. Search only filters this returned window; it is not a complete directory or company total. Select an organization explicitly to review current account facts.</p>{!records.length && <p role="status">No subscription records in the returned window match this selection.</p>}<ul className={styles.records}>{records.map((s) => <li key={s.subscriptionId}><div className={base.sectionHeader}><h3 dir="auto">{s.organizationName}</h3><span className={base.badge}>{subscriptionStatus[s.status]}</span></div><p>{s.planCode} · {s.offerKind ? offers[s.offerKind] : 'Legacy entitlement'} · <RecordPrice subscription={s}/></p><p className={shared.note}>Recorded terms only, not revenue or payment. Billing marker: not billed; review payment standing separately. Planned premium allowance: {s.premiumCredits.plannedMonthlyAllowance === null ? 'Not configured' : n(s.premiumCredits.plannedMonthlyAllowance)} · not a granted balance.</p><button type="button" aria-label={`Review ${s.organizationName} account`} aria-pressed={organizationId === s.organizationId} onClick={() => { accountOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setSelected({ key: overviewKey, organizationId: s.organizationId }); setAccountRevision((r) => r + 1); }}>Review organization</button></li>)}</ul></section>
    </>}</div>
    {overview.kind === 'ready' && <><SaasInventory catalog={overview.data.catalog}/><SaasCatalogAndCosts data={overview.data}/></>}
    <section className={base.panel}><h2>Read-only financial review</h2><p className={shared.note}>This screen cannot charge, collect, grant credits, change subscriptions or entitlements, reserve founder slots, fulfill rewards, publish contests or call providers. Invoice list/detail and individual payment-evidence history are the next integration slice. Company revenue totals are unavailable; subscription prices are not MRR.</p><Link className={shared.link} href="/hq/growth/rewards">Champions reward accounting →</Link></section>
  </div>;
}
