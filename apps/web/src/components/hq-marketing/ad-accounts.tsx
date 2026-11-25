'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { HQ_AD_COMMANDS, HQ_AD_PROVIDERS, HQ_AD_STATE, saasUuid, validateHqAdConnectInput, verifyHqAdAccountList, verifyHqAdConnectResult,
  verifyHqAdConnectStart, verifyHqAdDisconnectReceipt, type HqAdAccount, type HqAdAccountList, type HqAdConnectResult, type HqAdConnectStart,
  type HqAdDisconnectReceipt, type HqAdProvider } from '@hon/contracts';
import { useLocale } from '../localization/provider';
import { adText, type AdKey } from './ad-copy';
import { MarketingError, marketingCommand, marketingRead, type Owned } from './http';
import styles from '../hq-access/hq-access.module.css';

/**
 * 0677 HON's own Google Ads and Meta accounts. The HQ owner connects through Zernio's consent page; the API decides who may
 * connect and whether connecting is turned on. Connecting only links an account: nothing here publishes an ad or spends money.
 */
const BASE = '/api/v1/hq/marketing/ad-accounts';
export const adAccountsApi = {
  list: (signal: AbortSignal, owned: Owned): Promise<HqAdAccountList> => marketingRead(BASE, signal, owned, verifyHqAdAccountList),
  async connect(provider: HqAdProvider, key: string, signal: AbortSignal, owned: Owned): Promise<HqAdConnectStart> {
    const body = validateHqAdConnectInput({ provider });
    const start = await marketingCommand(`${BASE}/connect`, HQ_AD_COMMANDS.connect, body, key, signal, owned, verifyHqAdConnectStart);
    if (start.provider !== provider || !start.authUrl.startsWith('https://') && !start.authUrl.startsWith(window.location.origin + '/')) throw new MarketingError('UNKNOWN');
    return start;
  },
  complete: (state: string, key: string, signal: AbortSignal, owned: Owned): Promise<HqAdConnectResult> =>
    marketingCommand(`${BASE}/connect/complete`, HQ_AD_COMMANDS.complete, { state }, key, signal, owned, verifyHqAdConnectResult),
  async disconnect(account: HqAdAccount, key: string, signal: AbortSignal, owned: Owned): Promise<HqAdDisconnectReceipt> {
    const id = saasUuid(account.accountId);
    const r = await marketingCommand(`${BASE}/${id}/disconnect`, HQ_AD_COMMANDS.disconnect, { expectedVersion: account.version }, key, signal, owned, verifyHqAdDisconnectReceipt);
    if (r.account.accountId.toLowerCase() !== id.toLowerCase()) throw new MarketingError('UNKNOWN');
    return r;
  },
};
export type AdAccountsApi = typeof adAccountsApi;

type AdState = { state: 'LOADING' } | { state: 'UNAVAILABLE' } | { state: 'READY'; view: HqAdAccountList };
type Notice = null | { tone: 'ready' | 'blocked'; key: AdKey; vars?: Record<string, string> };
const formatDate = (locale: string, iso: string) => new Intl.DateTimeFormat(locale, { timeZone: 'UTC', dateStyle: 'medium' }).format(new Date(iso));
function failureKey(error: unknown): AdKey {
  if (!(error instanceof MarketingError)) return 'failed';
  if (error.kind === 'DENIED') return 'denied';
  if (error.kind === 'CHANGED' || error.code === 'SAAS_VERSION_CONFLICT' || error.code === 'HQ_AD_ACCOUNT_DISCONNECTED') return 'changed';
  if (error.code === 'HQ_AD_RATE_LIMITED' || error.code === 'HQ_AD_PROVIDER_RATE_LIMITED') return 'rateLimited';
  if (error.code === 'HQ_AD_CONNECT_NOT_ENABLED') return 'notEnabled';
  return 'failed';
}

export type AdAccountsViewProps = Readonly<{ language: string; formattingLocale: string; state: AdState; busy: boolean; notice: Notice;
  confirming: string | null; onConnect: (p: HqAdProvider) => void; onAskDisconnect: (accountId: string | null) => void; onDisconnect: (a: HqAdAccount) => void }>;

/** Presentation only. Every fact comes from the verified server answer. */
export function AdAccountsView(props: AdAccountsViewProps): React.ReactElement {
  const { language, formattingLocale, state, busy, notice, confirming } = props;
  const t = (key: AdKey, vars?: Record<string, string>) => adText(language, key, vars);
  const view = state.state === 'READY' ? state.view : null;
  const canAct = !!view?.viewer.canConnect;
  return <section aria-labelledby="hq-mk-ads" data-marketing-ad-accounts="" aria-busy={state.state === 'LOADING' || busy}>
    <h2 id="hq-mk-ads">{t('adAccounts')}</h2>
    {state.state === 'LOADING' ? <p className={styles.meta} role="status">{t('loading')}</p> : null}
    {state.state === 'UNAVAILABLE' ? <p className={styles.notice} role="alert">{t('unavailable')}</p> : null}
    <ul className={styles.list}>{HQ_AD_PROVIDERS.map(provider => {
      const live = view?.accounts.filter(a => a.provider === provider && a.status === 'CONNECTED') ?? [];
      return <li key={provider} className={styles.card} data-ad-account={provider} data-connected={live.length > 0 ? 'true' : 'false'}>
        <div className={styles.cardHead}><h3>{t(provider)}</h3>
          <span className={styles.status} data-tone={live.length ? 'ready' : 'blocked'}>{t(live.length ? 'connected' : 'notConnected')}</span></div>
        {live.map(a => <div key={a.accountId} data-ad-account-row={a.accountId}>
          <p><strong>{a.displayName}</strong></p>
          <p className={styles.meta}>{t('connectedBy', { name: a.connectedBy.displayName, date: formatDate(formattingLocale, a.connectedAt) })}</p>
          {canAct && confirming === a.accountId ? <div className={styles.actions} role="group" aria-label={t('disconnect')}>
            <p>{t('disconnectAsk', { name: a.displayName })}</p>
            <button type="button" className={styles.danger} disabled={busy} onClick={() => props.onDisconnect(a)}>{t('confirmDisconnect', { name: a.displayName })}</button>
            <button type="button" className={styles.secondary} disabled={busy} onClick={() => props.onAskDisconnect(null)}>{t('cancel')}</button>
          </div> : canAct ? <div className={styles.actions}>
            <button type="button" className={styles.secondary} disabled={busy} onClick={() => props.onAskDisconnect(a.accountId)}>{t('disconnect')}</button></div> : null}
        </div>)}
        <p className={styles.meta}>{t('noSpend')}</p>
        {canAct && view?.connectEnabled ? <div className={styles.actions}>
          <button type="button" className={styles.primary} disabled={busy} onClick={() => props.onConnect(provider)}>{t('connect')}</button></div> : null}
      </li>;
    })}</ul>
    {view && !view.connectEnabled ? <p className={styles.meta} data-ad-connect-off="">{t('notEnabled')}</p> : null}
    {view && !view.viewer.canConnect ? <p className={styles.meta}>{t('ownerOnly')}</p> : null}
    <p className={styles.meta}>{t('help')}</p>
    {notice ? <p className={styles.outcome} data-tone={notice.tone} role={notice.tone === 'blocked' ? 'alert' : 'status'}>{t(notice.key, notice.vars)}</p> : null}
    {busy ? <p className={styles.meta} role="status">{t('connecting')}</p> : null}
  </section>;
}

/** Reads the cards, starts a connect (then leaves for the consent page), and disconnects after a confirm step. */
export function HqAdAccounts({ api = adAccountsApi, navigate = (url: string) => window.location.assign(url) }:
  { api?: AdAccountsApi; navigate?: (url: string) => void }): React.ReactElement {
  const { preferences, formattingLocale } = useLocale();
  const [state, setState] = useState<AdState>({ state: 'LOADING' });
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState<Notice>(null), [confirming, setConfirming] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  useEffect(() => {
    const abort = new AbortController(), owned = () => mounted.current && !abort.signal.aborted;
    api.list(AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]), owned).then(
      view => { if (owned()) setState({ state: 'READY', view }); },
      () => { if (owned()) setState({ state: 'UNAVAILABLE' }); });
    return () => abort.abort();
  }, [api, refresh]);
  const onConnect = useCallback((provider: HqAdProvider) => {
    if (busy) return;
    setBusy(true); setNotice(null);
    api.connect(provider, globalThis.crypto.randomUUID(), AbortSignal.timeout(30000), () => mounted.current).then(
      start => navigate(start.authUrl),
      error => { if (!mounted.current) return; setBusy(false); setNotice({ tone: 'blocked', key: failureKey(error) }); });
  }, [api, busy, navigate]);
  const onDisconnect = useCallback((account: HqAdAccount) => {
    if (busy) return;
    setBusy(true); setNotice(null);
    api.disconnect(account, globalThis.crypto.randomUUID(), AbortSignal.timeout(30000), () => mounted.current).then(
      r => { if (!mounted.current) return; setBusy(false); setConfirming(null);
        setNotice((r.providerRemoval === 'NOT_REMOVED' || (r.providerRemoval === 'NOT_ATTEMPTED' && !r.replayed)) ? { tone: 'blocked', key: 'notRemoved' } : { tone: 'ready', key: 'disconnected', vars: { name: r.account.displayName } });
        setRefresh(n => n + 1); },
      error => { if (!mounted.current) return; setBusy(false); setConfirming(null); setNotice({ tone: 'blocked', key: failureKey(error) }); setRefresh(n => n + 1); });
  }, [api, busy]);
  return <AdAccountsView language={preferences.language} formattingLocale={formattingLocale} state={state} busy={busy} notice={notice}
    confirming={confirming} onConnect={onConnect} onAskDisconnect={setConfirming} onDisconnect={onDisconnect}/>;
}

type ReturnState = { state: 'WORKING' } | { state: 'MISSING' } | { state: 'DONE'; result: HqAdConnectResult } | { state: 'FAILED'; key: AdKey };
export function AdReturnView({ language, state }: { language: string; state: ReturnState }): React.ReactElement {
  const t = (key: AdKey, vars?: Record<string, string>) => adText(language, key, vars);
  return <main className={styles.access} data-hq-ad-return={state.state}>
    <h1>{t('returnTitle')}</h1>
    {state.state === 'WORKING' ? <p role="status">{t('returnWorking')}</p> : null}
    {state.state === 'MISSING' ? <p role="alert">{t('returnMissing')}</p> : null}
    {state.state === 'FAILED' ? <p role="alert">{t(state.key)}</p> : null}
    {state.state === 'DONE' ? <>
      <p role="status">{state.result.connected > 0 ? t('returnDone', { count: String(state.result.connected) }) : t('returnNone')}</p>
      {state.result.conflicts > 0 ? <p className={styles.meta}>{t('returnConflicts', { count: String(state.result.conflicts) })}</p> : null}
      <p className={styles.meta}>{t('help')}</p></> : null}
    <p><a href="/hq/marketing">{t('back')}</a></p>
  </main>;
}

/** Takes the single-use state from the address at once, removes it, and posts it once. Other query values are ignored. */
export function HqAdReturn({ api = adAccountsApi }: { api?: AdAccountsApi }): React.ReactElement {
  const { preferences } = useLocale();
  const [state, setState] = useState<ReturnState>({ state: 'WORKING' });
  const sent = useRef(false);
  useEffect(() => {
    if (sent.current) return;
    sent.current = true;
    const value = new URLSearchParams(window.location.search).get('state');
    try { window.history.replaceState(null, '', window.location.pathname); } catch { /* single use anyway */ }
    if (!value || !HQ_AD_STATE.test(value)) { setState({ state: 'MISSING' }); return; }
    api.complete(value, globalThis.crypto.randomUUID(), AbortSignal.timeout(30000), () => true).then(
      result => setState({ state: 'DONE', result }),
      error => setState({ state: 'FAILED', key: error instanceof MarketingError && error.code === 'HQ_AD_CONNECT_STATE_EXPIRED' ? 'returnExpired'
        : error instanceof MarketingError && error.code === 'HQ_AD_CONNECT_STATE_INVALID' ? 'returnInvalid' : failureKey(error) }));
  }, [api]);
  return <AdReturnView language={preferences.language} state={state}/>;
}
