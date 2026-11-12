'use client';
import React, { useEffect, useId, useState } from 'react';
import type { SchoolMembershipListItem } from '@hon/contracts';
import { MembershipListError, membershipListApi, type MembershipListApi, type MembershipListScope, type Owned } from './membership-list/http';
import { schoolLocalToInstant, validTimeZone } from './school-time';

/**
 * Invoice pickers for the school the shell verified: who the invoice is for comes from the existing school membership
 * list read (its billing account and membership), the amount is typed in dollars and cents, and the due date is a
 * calendar day in the school's timezone. Choosing only fills selectors; the invoice command re-checks everything.
 */
export type InvoicePickerState = { state: 'LOADING' | 'DENIED' | 'UNAVAILABLE' } | { state: 'READY'; items: readonly SchoolMembershipListItem[]; schoolTimezone: string };
const INVOICEABLE = new Set(['DRAFT', 'ACTIVE', 'FROZEN', 'CANCELLATION_PENDING']);
/** At most this many list pages are read for the picker. */
const PAGE_CAP = 4;

export async function loadInvoiceableMemberships(api: Pick<MembershipListApi, 'page'>, scope: MembershipListScope, signal: AbortSignal, owned: Owned)
  : Promise<{ items: SchoolMembershipListItem[]; schoolTimezone: string }> {
  const items: SchoolMembershipListItem[] = [];
  let cursor: string | null = null, schoolTimezone = '';
  for (let read = 0; read < PAGE_CAP; read++) {
    const page = await api.page(scope, null, cursor, signal, owned);
    schoolTimezone = page.schoolTimezone;
    items.push(...page.items.filter(item => INVOICEABLE.has(item.state)));
    cursor = page.nextCursor;
    if (!cursor) break;
  }
  return { items, schoolTimezone };
}

/** "49", "49.5" or "49.50" dollars to a cents string; anything else (negative, too many decimals, over 8 digits) is null. */
export function dollarsToMinor(text: string): string | null {
  const m = /^(\d{1,8})(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!m) return null;
  return String(Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0')));
}

/** The last second of a school calendar day as a UTC instant, or null when the day or zone is not usable. */
export function endOfSchoolDay(date: string, zone: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !validTimeZone(zone)) return null;
  const at = schoolLocalToInstant(`${date}T23:59:59`, zone);
  return at.state === 'OK' ? at.instant : null;
}

export function invoicePickLabel(item: SchoolMembershipListItem): string {
  const who = item.participant ? `${item.participant.givenName} ${item.participant.familyName}`.trim() || 'No participant recorded' : 'No participant recorded';
  return `${who} · ${item.planCode} · ${item.state.replaceAll('_', ' ').toLowerCase()}`;
}

export function InvoicePickersView({ state, membershipId, amount, dueDate, disabled, onPick, onAmount, onDueDate, onReload }: {
  state: InvoicePickerState; membershipId: string; amount: string; dueDate: string; disabled: boolean;
  onPick?: (item: SchoolMembershipListItem) => void; onAmount?: (text: string) => void; onDueDate?: (date: string) => void; onReload?: () => void;
}): React.ReactElement {
  const ids = { who: useId(), amount: useId(), due: useId() };
  const ready = state.state === 'READY' ? state : null;
  return <>
    {ready ? (ready.items.length ? <><label htmlFor={ids.who}>Who is this invoice for</label>
      <select id={ids.who} required value={membershipId} disabled={disabled} onChange={(e) => { const item = ready.items.find(i => i.membershipId === e.target.value); if (item) onPick?.(item); }}>
        <option value="">Choose a membership</option>
        {ready.items.map(item => <option key={item.membershipId} value={item.membershipId}>{invoicePickLabel(item)}</option>)}
      </select></> : <p role="status">No memberships can be invoiced yet. Create one from a lead in the CRM journey first.</p>)
      : <p role="status">{state.state === 'LOADING' ? 'Reading memberships…' : state.state === 'DENIED' ? 'Your access does not include the membership list at this school. Nothing is shown.' : 'Memberships could not be loaded. Nothing is shown.'}</p>}
    {!ready && state.state !== 'LOADING' && <button type="button" disabled={disabled} onClick={onReload}>Reload list</button>}
    <label htmlFor={ids.amount}>Amount (dollars and cents)</label>
    <input id={ids.amount} name="amount" required inputMode="decimal" autoComplete="off" maxLength={11} placeholder="49.00" value={amount} disabled={disabled} onChange={(e) => onAmount?.(e.target.value)}/>
    <label htmlFor={ids.due}>Due date</label>
    <input id={ids.due} name="dueDate" type="date" required value={dueDate} disabled={disabled || !ready} onChange={(e) => onDueDate?.(e.target.value)}/>
    {ready && <p>Due at the end of that day in the school’s time ({ready.schoolTimezone}).</p>}
  </>;
}

export function InvoicePickers({ scope, membershipId, amount, dueDate, disabled, onPick, onAmount, onDueDate, api = membershipListApi }: {
  scope: MembershipListScope; membershipId: string; amount: string; dueDate: string; disabled: boolean;
  onPick: (item: SchoolMembershipListItem) => void; onAmount: (text: string) => void; onDueDate: (date: string, schoolTimezone: string) => void; api?: Pick<MembershipListApi, 'page'>;
}): React.ReactElement {
  const [state, setState] = useState<InvoicePickerState>({ state: 'LOADING' });
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let current = true; const abort = new AbortController();
    setState({ state: 'LOADING' });
    loadInvoiceableMemberships(api, scope, AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]), () => current).then(
      ({ items, schoolTimezone }) => { if (current) setState({ state: 'READY', items, schoolTimezone }); },
      (error) => { if (current && !abort.signal.aborted) setState({ state: error instanceof MembershipListError && error.kind === 'DENIED' ? 'DENIED' : 'UNAVAILABLE' }); });
    return () => { current = false; abort.abort(); };
  }, [scope.organizationId, scope.schoolId, reload, api]); // eslint-disable-line react-hooks/exhaustive-deps
  return <InvoicePickersView state={state} membershipId={membershipId} amount={amount} dueDate={dueDate} disabled={disabled} onPick={onPick} onAmount={onAmount}
    onDueDate={(date) => { if (state.state === 'READY') onDueDate(date, state.schoolTimezone); }} onReload={() => setReload(n => n + 1)}/>;
}
