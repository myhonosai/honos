import React from 'react';
import { SCHOOL_PAY_CAPABILITY_KEYS, type SchoolPayCapabilityKey, type SchoolPayConnection, type SchoolPayConnectionState, type SchoolPaymentProcessors } from '@hon/contracts';
import type { ProcessorCommand, ProcessorErrorKind, ProviderReturn } from './http';
import styles from '../membership-changes/membership-changes.module.css';

export type ProcessorsState = { state: 'LOADING' | 'DENIED' | 'UNAVAILABLE' } | { state: 'READY'; read: SchoolPaymentProcessors };
export type ProcessorForm = null | Readonly<{ kind: 'disconnect'; connectionId: string }>;
export type ProcessorOutcome = null | Readonly<{ kind: 'SENDING' | 'DONE' | 'REDIRECTING' | 'LINK_REPLAYED' | ProcessorErrorKind; action: ProcessorCommand; providerRevoked?: boolean }>;

export type PaymentProcessorsViewProps = Readonly<{
  language: string; waiting: boolean; concealed: boolean; hasSchool: boolean;
  list: ProcessorsState; returned: ProviderReturn | null; form: ProcessorForm; outcome: ProcessorOutcome; locked: boolean; canRetry: boolean;
  onRefreshList?: (() => void) | undefined; onConnect?: ((providerCode: string) => void) | undefined; onContinue?: ((connectionId: string) => void) | undefined;
  onFinish?: (() => void) | undefined; onDismissReturn?: (() => void) | undefined; onCheck?: ((connectionId: string) => void) | undefined;
  onDefault?: ((connectionId: string) => void) | undefined; onOpen?: ((form: ProcessorForm) => void) | undefined; onClose?: (() => void) | undefined;
  onDisconnect?: ((connectionId: string, reason: string) => void) | undefined; onTryAgain?: (() => void) | undefined;
}>;

const STATE_LABEL: Record<SchoolPayConnectionState, string> = {
  PENDING_ONBOARDING: 'Setup not finished',
  CONNECTED_RESTRICTED: 'Connected, but the provider still needs details before it can take payments',
  CONNECTED_ACTIVE: 'Ready to take payments (test mode)',
  REAUTHORIZATION_REQUIRED: 'Access needs to be renewed with the provider',
  DISCONNECTED: 'Disconnected',
  ABANDONED: 'Setup was not finished',
};
const CAPABILITY_LABEL: Record<SchoolPayCapabilityKey, string> = {
  oneTimeCard: 'One-time card payments', storedCard: 'Saved cards', offSessionRecurring: 'Autopay', bankDebit: 'US bank account payments', refunds: 'Refunds',
};
const OUTCOME_TEXT: Record<NonNullable<ProcessorOutcome>['kind'], string> = {
  SENDING: 'Working. Keep this page open.',
  DONE: 'Saved. The connections below were read again from the server.',
  REDIRECTING: 'Opening the provider so you can finish setup…',
  LINK_REPLAYED: 'That setup link was already used. Choose Continue setup to get a new one.',
  SESSION: 'Your session ended. Sign in again; nothing was saved by this page after that.',
  DENIED: 'You are not allowed to manage payment processors at this school. Nothing changed.',
  GONE: 'That connection is not available at this school. Nothing changed.',
  CHANGED: 'The connection changed since it was shown. Nothing changed; check the fresh status and try again.',
  STATE: 'The connection is not in a state that allows this. The fresh status is shown below.',
  EXISTS: 'This school already has an open connection to that provider.',
  STATE_MISMATCH: 'This return link is not the latest one for this connection. Choose Continue setup to start again.',
  LINKED_ELSEWHERE: 'That provider account is already connected to another organization in HON. Use a different account.',
  ACCOUNT_MISMATCH: 'The provider answered for a different account than this connection. Nothing changed.',
  NOT_CONFIGURED: 'This provider is not set up in this environment yet. Nothing was sent to it.',
  PROVIDER_REJECTED: 'The provider refused the request. Nothing changed in HON.',
  INVALID: 'The request was not accepted. Check the details (a disconnect needs a short reason) and try again.',
  RATE: 'Too many requests. Nothing changed; try again in a moment.',
  UNKNOWN: 'The result is not known yet. Try again sends the exact same request, so nothing happens twice.',
};
const instant = (language: string, value: string) => new Date(value).toLocaleString(language, { dateStyle: 'medium', timeStyle: 'short' });
/** Only the end of the provider account id is shown: enough to recognize it, nothing more. */
const accountTail = (ref: string | null) => ref ? `account ending ${ref.slice(-4)}` : 'no account yet';
const OPEN = (c: SchoolPayConnection) => c.state !== 'DISCONNECTED' && c.state !== 'ABANDONED';

function Connection({ p, connection, name, canManage }: { p: PaymentProcessorsViewProps; connection: SchoolPayConnection; name: string; canManage: boolean }) {
  const disconnecting = p.form?.kind === 'disconnect' && p.form.connectionId === connection.connectionId;
  const connected = connection.state === 'CONNECTED_ACTIVE' || connection.state === 'CONNECTED_RESTRICTED' || connection.state === 'REAUTHORIZATION_REQUIRED';
  return <div data-testid="processor-connection">
    <p data-testid="processor-state">{STATE_LABEL[connection.state]}{connection.isDefault ? ' · default for this school' : ''} · {accountTail(connection.accountRef)}</p>
    {connection.statusObservedAt ? <p className={styles.meta}>Status from {name} on {instant(p.language, connection.statusObservedAt)}.</p> : null}
    {connection.state === 'CONNECTED_ACTIVE'
      ? <p className={styles.meta}>Can do: {SCHOOL_PAY_CAPABILITY_KEYS.filter((k) => connection.capabilities[k]).map((k) => CAPABILITY_LABEL[k]).join(', ') || 'nothing yet'}.</p>
      : null}
    {connection.state === 'CONNECTED_RESTRICTED' ? <p className={styles.meta}>Finish the details {name} asks for in your {name} dashboard, then choose Check status.</p> : null}
    {canManage && !disconnecting ? <div className={styles.row}>
      {connection.state === 'PENDING_ONBOARDING' ? <button type="button" className={styles.primary} disabled={p.locked} onClick={() => p.onContinue?.(connection.connectionId)}>Continue setup</button> : null}
      {connected ? <button type="button" className={styles.secondary} disabled={p.locked} onClick={() => p.onCheck?.(connection.connectionId)}>Check status</button> : null}
      {connection.state === 'CONNECTED_ACTIVE' && !connection.isDefault
        ? <button type="button" className={styles.secondary} disabled={p.locked} onClick={() => p.onDefault?.(connection.connectionId)}>Make default</button> : null}
      <button type="button" className={styles.secondary} disabled={p.locked} onClick={() => p.onOpen?.({ kind: 'disconnect', connectionId: connection.connectionId })}>Disconnect</button>
    </div> : null}
    {disconnecting ? <form className={`${styles.form} ${styles.danger}`} data-testid="disconnect-form" onSubmit={(e) => {
      e.preventDefault(); p.onDisconnect?.(connection.connectionId, String(new FormData(e.currentTarget).get('reason') ?? ''));
    }}>
      <label className={styles.field}>Why are you disconnecting?<textarea name="reason" rows={2} maxLength={500} required/></label>
      <p className={styles.meta}>HON stops using this {name} account for the school, then asks {name} to remove HON&apos;s access. Money already in your {name} account stays there.</p>
      <div className={styles.row}><button type="submit" className={styles.primary} disabled={p.locked}>Disconnect {name}</button>
        <button type="button" className={styles.secondary} disabled={p.locked} onClick={p.onClose}>Close</button></div>
    </form> : null}
  </div>;
}

function Providers({ p }: { p: PaymentProcessorsViewProps }) {
  const list = p.list;
  return <article className={styles.card} aria-labelledby="processors-title" data-testid="processors">
    <div className={styles.cardHead}><h2 id="processors-title">Processors</h2>
      <button type="button" className={styles.secondary} disabled={p.locked} onClick={p.onRefreshList}>Refresh</button></div>
    {list.state === 'LOADING' ? <p className={styles.meta} role="status">Reading payment processors…</p>
      : list.state === 'DENIED' ? <p className={styles.meta} role="status">You need the payment processor permission at this school to see this page.</p>
      : list.state !== 'READY' ? <p className={styles.meta} role="status">Payment processors are not available right now. Nothing changed.</p>
      : <>
        {!list.read.canManage ? <p className={styles.meta}>You can see the connections. Connecting or changing them needs the manage payment processors permission.</p> : null}
        <ul className={styles.list}>
          {list.read.providers.map((provider) => {
            const open = list.read.connections.find((c) => c.providerCode === provider.providerCode && OPEN(c));
            return <li key={provider.providerCode} data-testid="processor-provider">
              <h3>{provider.displayName}</h3>
              {open ? <Connection p={p} connection={open} name={provider.displayName} canManage={list.read.canManage}/>
                : <>
                  <p className={styles.meta}>Not connected.</p>
                  {list.read.canManage ? <button type="button" className={styles.primary} disabled={p.locked} onClick={() => p.onConnect?.(provider.providerCode)}>Connect {provider.displayName}</button> : null}
                </>}
            </li>;
          })}
        </ul>
        {list.read.connections.some((c) => !OPEN(c)) ? <>
          <h3>Earlier connections</h3>
          <ul className={styles.list}>{list.read.connections.filter((c) => !OPEN(c)).map((c) => <li key={c.connectionId} className={styles.meta}>
            {list.read.providers.find((x) => x.providerCode === c.providerCode)?.displayName ?? c.providerCode}: {STATE_LABEL[c.state]}
            {c.endedAt ? ` on ${instant(p.language, c.endedAt)}` : ''}{c.endReason ? ` (${c.endReason})` : ''}
          </li>)}</ul>
        </> : null}
      </>}
  </article>;
}

function Returned({ p }: { p: PaymentProcessorsViewProps }) {
  const back = p.returned;
  if (!back || p.list.state !== 'READY') return null;
  const read = p.list.read, connection = read.connections.find((c) => c.connectionId === back.connectionId);
  const name = connection ? read.providers.find((x) => x.providerCode === connection.providerCode)?.displayName ?? 'the provider' : 'the provider';
  if (!connection || connection.state !== 'PENDING_ONBOARDING' || !read.canManage) return null;
  return <div className={styles.notice} role="status" data-testid="processor-return">
    {back.providerError
      ? <p>{name} reported that setup was cancelled or refused. You can choose Continue setup to try again.</p>
      : <p>You are back from {name}. Choose Finish connecting so HON can confirm the account with {name}.</p>}
    <div className={styles.row}>
      {!back.providerError ? <button type="button" className={styles.primary} disabled={p.locked} onClick={p.onFinish}>Finish connecting {name}</button> : null}
      <button type="button" className={styles.secondary} disabled={p.locked} onClick={p.onDismissReturn}>Dismiss</button>
    </div>
  </div>;
}

/** The payment processors page body: pure, every state comes from props. */
export function PaymentProcessorsView(p: PaymentProcessorsViewProps): React.ReactElement {
  return <section className={styles.page} aria-labelledby="payment-processors-title">
    <header className={styles.head}><div>
      <h1 id="payment-processors-title">Payment processors</h1>
      <p className={styles.intro}>Connect your school&apos;s own Stripe or Square account so families can pay tuition by card. Payments go straight to your school&apos;s account, and HON takes no fee on any payment your school collects.</p>
      <p className={styles.meta} data-testid="processors-test-mode">Test mode only: no real cards are charged and no real money moves.</p>
    </div></header>
    {p.concealed ? <p className={styles.notice} role="status">Hidden while this tab was in the background. Return to the page to show it again.</p>
      : p.waiting ? <p className={styles.notice} role="status">Checking your school…</p>
      : !p.hasSchool ? <p className={styles.notice} role="status">Choose a school to see its payment processors.</p>
      : <>
        {p.outcome ? <div className={`${styles.notice} ${['DONE', 'SENDING', 'REDIRECTING'].includes(p.outcome.kind) ? '' : styles.warn}`} role="status" data-testid="processor-outcome">
          <p>{OUTCOME_TEXT[p.outcome.kind]}</p>
          {p.outcome.kind === 'DONE' && p.outcome.action === 'disconnect' ? <p className={styles.meta}>{p.outcome.providerRevoked
            ? 'The provider confirmed HON\'s access was removed.'
            : 'The provider did not confirm that HON\'s access was removed. HON no longer uses the account; you can also remove HON from the provider\'s dashboard.'}</p> : null}
          {p.canRetry ? <button type="button" className={styles.primary} onClick={p.onTryAgain}>Try again</button> : null}
        </div> : null}
        <Returned p={p}/>
        <Providers p={p}/>
      </>}
  </section>;
}
