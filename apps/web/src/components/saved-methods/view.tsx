import React from 'react';
import type { SchoolPayExpiringMethods, SchoolPayMethod, SchoolPayMethodKind, SchoolPayPayerMethodsView } from '@hon/contracts';
import type { MethodCommand, MethodErrorKind, SetupReturn } from './http';
import styles from '../membership-changes/membership-changes.module.css';

export type PayerOption = Readonly<{ payerId: string; label: string }>;
export type PayersState = { state: 'LOADING' | 'DENIED' | 'UNAVAILABLE' } | { state: 'READY'; payers: readonly PayerOption[] };
export type PayerState = { state: 'NONE' | 'LOADING' | 'DENIED' | 'UNAVAILABLE' | 'GONE' } | { state: 'READY'; read: SchoolPayPayerMethodsView };
export type ExpiringState = { state: 'LOADING' | 'DENIED' | 'UNAVAILABLE' } | { state: 'READY'; read: SchoolPayExpiringMethods };
export type MethodForm = null | Readonly<{ kind: 'add' }> | Readonly<{ kind: 'remove'; methodId: string }>;
export type MethodOutcome = null | Readonly<{ kind: 'SENDING' | 'DONE' | 'REDIRECTING' | 'LINK_REPLAYED' | MethodErrorKind; action: MethodCommand; providerDetached?: boolean }>;

/** The consent each method kind records (by version); the payer must agree before the provider page opens. */
/** Consent is for one text on one processor: changing the kind or the connection clears it. */
export function consentScope(connectionId: string, kind: SchoolPayMethodKind): string { return `${connectionId}|${kind}`; }
export function consentGiven(agreedFor: string | null, connectionId: string, kind: SchoolPayMethodKind): boolean {
  return agreedFor !== null && agreedFor === consentScope(connectionId, kind);
}

export const CONSENT: Record<SchoolPayMethodKind, Readonly<{ version: string; text: (school: string) => string }>> = {
  CARD: { version: 'card-on-file-v1', text: (school) => `I allow ${school} to save this card with its payment processor and charge it for tuition and fees I agree to, until I ask to remove it.` },
  US_BANK_ACCOUNT: { version: 'ach-mandate-v1', text: (school) => `I allow ${school} to save this bank account with its payment processor and debit it for tuition and fees I agree to, until I ask to remove it.` },
};

export type SavedMethodsViewProps = Readonly<{
  language: string; waiting: boolean; concealed: boolean; hasSchool: boolean; schoolName: string;
  payers: PayersState; payerId: string | null; payer: PayerState; expiring: ExpiringState; returned: SetupReturn | null;
  form: MethodForm; outcome: MethodOutcome; locked: boolean; canRetry: boolean;
  onPickPayer?: ((payerId: string) => void) | undefined; onRefresh?: (() => void) | undefined; onOpen?: ((form: MethodForm) => void) | undefined; onClose?: (() => void) | undefined;
  onStart?: ((connectionId: string, kind: SchoolPayMethodKind) => void) | undefined; onFinish?: (() => void) | undefined; onDismissReturn?: (() => void) | undefined;
  onDefault?: ((methodId: string) => void) | undefined; onRemove?: ((methodId: string, reason: string) => void) | undefined; onTryAgain?: (() => void) | undefined;
}>;

const OUTCOME_TEXT: Record<NonNullable<MethodOutcome>['kind'], string> = {
  SENDING: 'Working. Keep this page open.',
  DONE: 'Saved. The details below were read again from the server.',
  REDIRECTING: 'Opening the payment processor page so the payer can enter the card or bank account…',
  LINK_REPLAYED: 'That setup link was already used. Choose Add a card or bank account again for a fresh one.',
  SESSION: 'Your session ended. Sign in again; nothing was saved by this page after that.',
  DENIED: 'You are not allowed to manage saved payment methods at this school. Nothing changed.',
  GONE: 'That payer, setup or saved method is not available at this school. Nothing changed.',
  CHANGED: 'It changed since it was shown. Nothing changed; check the fresh details and try again.',
  STATE: 'That is not possible any more (it was already removed, already the default, or already finished). The fresh details are shown below.',
  INCOMPLETE: 'The card or bank account was not saved on the processor page yet. Open it again, or start a new setup.',
  STATE_MISMATCH: 'This return link is not the latest one for this setup. Start a new setup.',
  EXPIRED: 'That setup expired (setups last one hour). Start a new one.',
  UNAVAILABLE: 'This payment processor cannot save that kind of payment method now. Nothing was saved.',
  CUSTOMER_MISMATCH: 'The payment processor answered for a different customer. Nothing was saved.',
  NOT_CONFIGURED: 'This payment processor is not set up in this environment yet. Nothing was sent to it.',
  PROVIDER_REJECTED: 'The payment processor refused the request. Nothing changed in HON.',
  INVALID: 'The request was not accepted. Check the details (removing needs a short reason, and the payer must agree) and try again.',
  RATE: 'Too many requests. Nothing changed; try again in a moment.',
  UNKNOWN: 'The result is not known yet. Try again sends the exact same request, so nothing happens twice.',
};
const BRAND: Record<SchoolPayMethod['brand'], string> = {
  VISA: 'Visa', MASTERCARD: 'Mastercard', AMEX: 'American Express', DISCOVER: 'Discover', JCB: 'JCB', DINERS: 'Diners Club', UNIONPAY: 'UnionPay', OTHER: 'Card', BANK: 'Bank account',
};
const month = (m: number, y: number) => `${String(m).padStart(2, '0')}/${y}`;
export function methodLabel(m: Pick<SchoolPayMethod, 'brand' | 'last4' | 'expMonth' | 'expYear'>): string {
  return `${BRAND[m.brand]} ending ${m.last4}${m.expMonth !== null && m.expYear !== null ? ` · expires ${month(m.expMonth, m.expYear)}` : ''}`;
}

function Method({ p, m, canManage }: { p: SavedMethodsViewProps; m: SchoolPayMethod; canManage: boolean }) {
  const removing = p.form?.kind === 'remove' && p.form.methodId === m.methodId;
  const removed = m.status === 'REMOVED';
  return <li data-testid="saved-method">
    <p>{methodLabel(m)}{m.isDefault ? ' · default' : ''}{removed ? ' · removed' : ''}</p>
    {removed && m.removeReason ? <p className={styles.meta}>Removed: {m.removeReason}</p> : null}
    {canManage && !removed && !removing ? <div className={styles.row}>
      {!m.isDefault ? <button type="button" className={styles.secondary} disabled={p.locked} onClick={() => p.onDefault?.(m.methodId)}>Make default</button> : null}
      <button type="button" className={styles.secondary} disabled={p.locked} onClick={() => p.onOpen?.({ kind: 'remove', methodId: m.methodId })}>Remove</button>
    </div> : null}
    {removing ? <form className={`${styles.form} ${styles.danger}`} data-testid="remove-form" onSubmit={(e) => {
      e.preventDefault(); p.onRemove?.(m.methodId, String(new FormData(e.currentTarget).get('reason') ?? ''));
    }}>
      <label className={styles.field}>Why is it being removed?<textarea name="reason" rows={2} maxLength={500} required/></label>
      <p className={styles.meta}>HON stops using it, then asks the payment processor to remove it from the payer.</p>
      <div className={styles.row}><button type="submit" className={styles.primary} disabled={p.locked}>Remove</button>
        <button type="button" className={styles.secondary} disabled={p.locked} onClick={p.onClose}>Close</button></div>
    </form> : null}
  </li>;
}

function AddForm({ p, read }: { p: SavedMethodsViewProps; read: SchoolPayPayerMethodsView }) {
  const [connectionId, setConnectionId] = React.useState(read.connections[0]?.connectionId ?? '');
  const [kind, setKind] = React.useState<SchoolPayMethodKind>('CARD');
  const connection = read.connections.find((c) => c.connectionId === connectionId);
  const effectiveKind: SchoolPayMethodKind = kind === 'US_BANK_ACCOUNT' && !connection?.bankDebit ? 'CARD' : kind;
  const consentFor = consentScope(connectionId, effectiveKind);
  const [agreedFor, setAgreedFor] = React.useState<string | null>(null);
  const agreed = consentGiven(agreedFor, connectionId, effectiveKind);
  return <form className={styles.form} data-testid="add-form" onSubmit={(e) => { e.preventDefault(); if (agreed && connection) p.onStart?.(connection.connectionId, effectiveKind); }}>
    <label className={styles.field}>Payment processor
      <select value={connectionId} onChange={(e) => setConnectionId(e.target.value)}>
        {read.connections.map((c) => <option key={c.connectionId} value={c.connectionId}>{c.displayName}{c.isDefault ? ' (school default)' : ''}</option>)}
      </select></label>
    <fieldset className={styles.field}><legend>What to save</legend>
      <label><input type="radio" name="kind" checked={effectiveKind === 'CARD'} onChange={() => setKind('CARD')}/> Card</label>
      {connection?.bankDebit ? <label><input type="radio" name="kind" checked={effectiveKind === 'US_BANK_ACCOUNT'} onChange={() => setKind('US_BANK_ACCOUNT')}/> US bank account</label> : null}
    </fieldset>
    <label><input type="checkbox" checked={agreed} onChange={(e) => setAgreedFor(e.target.checked ? consentFor : null)} data-testid="consent"/> {CONSENT[effectiveKind].text(p.schoolName || 'the school')}</label>
    <p className={styles.meta}>The payer enters the details on the payment processor&apos;s own page. HON never sees the card or account number. Nothing is charged now.</p>
    <div className={styles.row}><button type="submit" className={styles.primary} disabled={p.locked || !agreed || !connection}>Continue to the payment processor</button>
      <button type="button" className={styles.secondary} disabled={p.locked} onClick={p.onClose}>Close</button></div>
  </form>;
}

function Payer({ p }: { p: SavedMethodsViewProps }) {
  const payer = p.payer;
  if (payer.state === 'NONE') return null;
  if (payer.state === 'LOADING') return <p role="status">Loading the payer&apos;s saved payment methods…</p>;
  if (payer.state === 'DENIED') return <p role="alert">You are not allowed to see saved payment methods at this school.</p>;
  if (payer.state === 'GONE') return <p role="alert">That payer is not in this school.</p>;
  if (payer.state === 'UNAVAILABLE') return <p role="alert">Saved payment methods are not available right now. <button type="button" className={styles.secondary} onClick={p.onRefresh}>Try again</button></p>;
  if (payer.state !== 'READY') return null;
  const read = payer.read;
  const active = read.methods.filter((m) => m.status === 'ACTIVE'), removed = read.methods.filter((m) => m.status === 'REMOVED');
  return <section aria-labelledby="payer-methods" data-testid="payer-methods">
    <h2 id="payer-methods">{read.payerName || 'Payer'}</h2>
    {active.length ? <ul>{active.map((m) => <Method key={m.methodId} p={p} m={m} canManage={read.canManage}/>)}</ul> : <p>No saved card or bank account yet.</p>}
    {read.canManage && p.form?.kind !== 'add' ? (read.connections.length
      ? <button type="button" className={styles.primary} disabled={p.locked} onClick={() => p.onOpen?.({ kind: 'add' })}>Add a card or bank account</button>
      : <p className={styles.meta}>Connect a payment processor that can save cards first (Billing, Payment processors).</p>) : null}
    {p.form?.kind === 'add' ? <AddForm p={p} read={read}/> : null}
    {removed.length ? <details><summary>Removed ({removed.length})</summary><ul>{removed.map((m) => <Method key={m.methodId} p={p} m={m} canManage={false}/>)}</ul></details> : null}
    <p className={styles.meta}>HON takes no fee on any payment your school collects.</p>
  </section>;
}

function Expiring({ p }: { p: SavedMethodsViewProps }) {
  if (p.expiring.state === 'LOADING') return <p role="status">Loading cards that are expiring…</p>;
  if (p.expiring.state !== 'READY') return null;
  const { methods } = p.expiring.read;
  return <section aria-labelledby="expiring" data-testid="expiring">
    <h2 id="expiring">Cards expiring soon</h2>
    {methods.length ? <ul>{methods.map((m) => <li key={m.methodId} data-testid="expiring-method">
      <button type="button" className={styles.secondary} disabled={p.locked} onClick={() => p.onPickPayer?.(m.billingAccountId)}>{m.payerName || 'Payer'}</button>
      {' · '}{methodLabel(m)}{m.expired ? ' · expired' : ''}{m.isDefault ? ' · default' : ''}
    </li>)}</ul> : <p>No saved card expires this month or next.</p>}
  </section>;
}

export function SavedMethodsView(p: SavedMethodsViewProps): React.ReactElement {
  if (p.concealed) return <p role="status">Hidden while this window is not in use.</p>;
  if (p.waiting) return <p role="status">Loading…</p>;
  if (!p.hasSchool) return <p role="alert">Choose a school first.</p>;
  return <main className={styles.page}>
    <header><h1>Saved payment methods</h1>
      <p>Save a family&apos;s card or bank account with your school&apos;s payment processor so tuition can be collected later. Test mode only.</p></header>
    {p.outcome ? <p role={p.outcome.kind === 'SENDING' || p.outcome.kind === 'DONE' || p.outcome.kind === 'REDIRECTING' ? 'status' : 'alert'} data-testid="method-outcome">
      {OUTCOME_TEXT[p.outcome.kind]}{p.outcome.kind === 'DONE' && p.outcome.action === 'remove' && p.outcome.providerDetached === false ? ' The payment processor did not confirm removing it; check its dashboard.' : ''}
      {p.canRetry ? <> <button type="button" className={styles.secondary} onClick={p.onTryAgain}>Try again</button></> : null}</p> : null}
    {p.returned ? <section className={styles.form} data-testid="setup-return" aria-labelledby="setup-return">
      <h2 id="setup-return">Back from the payment processor</h2>
      <p>Finish saving to record the card or bank account the payer entered. HON asks the payment processor what was saved.</p>
      <div className={styles.row}><button type="button" className={styles.primary} disabled={p.locked || p.payer.state !== 'READY'} onClick={p.onFinish}>Finish saving</button>
        <button type="button" className={styles.secondary} disabled={p.locked} onClick={p.onDismissReturn}>Not now</button></div>
    </section> : null}
    <section aria-labelledby="pick-payer"><h2 id="pick-payer">Payer</h2>
      {p.payers.state === 'READY' ? <label className={styles.field}>Choose a payer
        <select value={p.payerId ?? ''} disabled={p.locked} onChange={(e) => { if (e.target.value) p.onPickPayer?.(e.target.value); }} data-testid="payer-picker">
          <option value="">Choose…</option>
          {p.payers.payers.map((o) => <option key={o.payerId} value={o.payerId}>{o.label}</option>)}
        </select></label>
        : p.payers.state === 'LOADING' ? <p role="status">Loading payers…</p> : <p className={styles.meta}>Payers could not be listed; open a payer from the expiring list below.</p>}
    </section>
    <Payer p={p}/>
    <Expiring p={p}/>
  </main>;
}
