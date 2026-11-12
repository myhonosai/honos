'use client';
import React, { useEffect, useId, useState } from 'react';
import type { SchoolMembershipListItem } from '@hon/contracts';
import { MembershipListError, membershipListApi, type MembershipListApi, type MembershipListScope, type Owned } from './membership-list/http';

/**
 * Activation picker: the memberships waiting for activation (DRAFT) at the school the shell verified, read through the
 * existing school membership list. Choosing one only fills the selectors; the activation preview and command still
 * re-verify the session, exact school and permission. Nothing is read from or written to the URL.
 */
export type PickerState = { state: 'LOADING' | 'DENIED' | 'UNAVAILABLE' } | { state: 'READY'; items: readonly SchoolMembershipListItem[] };
type T = (key: string, vars?: { date?: string }) => string;

/** At most this many list pages are read for the picker; later DRAFTs stay reachable from the membership list. */
const DRAFT_PAGE_CAP = 4;

export async function loadDraftMemberships(api: Pick<MembershipListApi, 'page'>, scope: MembershipListScope, signal: AbortSignal, owned: Owned): Promise<readonly SchoolMembershipListItem[]> {
  const items: SchoolMembershipListItem[] = [];
  let cursor: string | null = null;
  for (let read = 0; read < DRAFT_PAGE_CAP; read++) {
    const page = await api.page(scope, 'DRAFT', cursor, signal, owned);
    items.push(...page.items);
    cursor = page.nextCursor;
    if (!cursor) break;
  }
  return items;
}

export function pickerLabel(item: SchoolMembershipListItem, language: string, t: T): string {
  const who = item.participant ? `${item.participant.givenName} ${item.participant.familyName}`.trim() || t('No participant recorded') : t('No participant recorded');
  const added = new Date(item.createdAt).toLocaleDateString(language, { dateStyle: 'medium' });
  return `${who} · ${item.planCode} · ${t('added {date}', { date: added })}`;
}

export function MembershipPickerView({ state, value, disabled, t, language, onPick, onReload }: {
  state: PickerState; value: string; disabled: boolean; t: T; language: string; onPick?: (membershipId: string) => void; onReload?: () => void;
}): React.ReactElement {
  const fieldId = useId();
  if (state.state === 'LOADING') return <p role="status">{t('Reading memberships waiting for activation…')}</p>;
  if (state.state === 'DENIED') return <p role="status">{t('Your access does not include the membership list at this school. Nothing is shown.')}</p>;
  const items = state.state === 'READY' ? state.items : null;
  if (!items || !items.length) return <div role="status"><p>{t(items ? 'No memberships are waiting for activation. Create one from a lead in the CRM journey, then come back.' : 'Memberships waiting for activation could not be loaded. Nothing is shown.')}</p>
    <button type="button" onClick={onReload}>{t('Reload list')}</button></div>;
  return <div>
    <label htmlFor={fieldId}>{t('Membership waiting for activation')}</label>
    <select id={fieldId} required value={value} disabled={disabled} onChange={(event) => onPick?.(event.target.value)}>
      <option value="">{t('Choose a membership')}</option>
      {items.map((item) => <option key={item.membershipId} value={item.membershipId}>{pickerLabel(item, language, t)}</option>)}
    </select>
  </div>;
}

export function MembershipActivationPicker({ scope, value, disabled, refresh, t, language, onPick, api = membershipListApi }: {
  scope: MembershipListScope; value: string; disabled: boolean; refresh: number; t: T; language: string; onPick: (membershipId: string) => void; api?: Pick<MembershipListApi, 'page'>;
}): React.ReactElement {
  const [state, setState] = useState<PickerState>({ state: 'LOADING' });
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let current = true; const abort = new AbortController();
    setState({ state: 'LOADING' });
    loadDraftMemberships(api, scope, AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]), () => current).then(
      (items) => { if (current) setState({ state: 'READY', items }); },
      (error) => { if (current && !abort.signal.aborted) setState({ state: error instanceof MembershipListError && error.kind === 'DENIED' ? 'DENIED' : 'UNAVAILABLE' }); });
    return () => { current = false; abort.abort(); };
  }, [scope.organizationId, scope.schoolId, refresh, reload, api]); // eslint-disable-line react-hooks/exhaustive-deps
  return <MembershipPickerView state={state} value={value} disabled={disabled} t={t} language={language} onPick={onPick} onReload={() => setReload((n) => n + 1)}/>;
}
