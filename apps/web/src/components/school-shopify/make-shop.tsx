'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { shopifyEditText, shopifyOwnerEmail, type ShopifyStoreRequest } from '@hon/contracts';
import { MakeShopError, makeShopApi, type MakeShopApi, type MakeShopErrorKind } from './make-shop-http';
import { makeShopText, type MakeShopKey } from './make-shop-copy';
import styles from './shopify.module.css';

// ---- "Make my shop" (0655): a school with no Shopify store asks HON to make one. HON HQ creates it by hand. ----

export type MakeShopState = { state: 'LOADING' | 'UNAVAILABLE' } | { state: 'READY'; request: ShopifyStoreRequest | null };
export type MakeShopOutcome = null | Readonly<{ kind: 'SENDING'; action: 'ask' | 'cancel' } | { kind: 'ERROR'; error: MakeShopErrorKind }>;
export type MakeShopViewProps = Readonly<{
  language: string; locale: string; state: MakeShopState; outcome: MakeShopOutcome; schoolName: string | null;
  onAsk: (shopName: string, ownerEmail: string, note: string | null) => void; onCancel: (requestId: string) => void;
  onUseStore: (shopDomain: string) => void; onRefresh: () => void;
}>;
const day = (locale: string, iso: string) => { try { return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(iso)); } catch { return iso.slice(0, 10); } };

/** Pure view of the school's latest request: the form, "HON is making it", or "your shop is ready" with the next steps. */
export function MakeShopView(p: MakeShopViewProps): React.ReactElement {
  const t = (key: MakeShopKey, vars?: Record<string, string>) => makeShopText(p.language, key, vars);
  const [shopName, setShopName] = useState(p.schoolName?.slice(0, 60) ?? ''), [email, setEmail] = useState(''), [note, setNote] = useState('');
  const busy = p.outcome?.kind === 'SENDING';
  const error = p.outcome?.kind === 'ERROR' && <p className={`${styles.notice} ${styles.warn}`} role="alert" data-make-shop-error={p.outcome.error}>{t(`e_${p.outcome.error}`)}</p>;
  if (p.state.state !== 'READY') return <div className={styles.card} data-make-shop={p.state.state}>
    <h2>{t('title')}</h2>
    {p.state.state === 'LOADING' ? <p className={styles.meta} role="status">{t('loading')}</p>
      : <><p className={styles.meta} role="alert">{t('unavailable')}</p><div className={styles.row}><button type="button" className={styles.secondary} onClick={p.onRefresh}>{t('again')}</button></div></>}
  </div>;
  const r = p.state.request;
  if (r?.status === 'REQUESTED') return <div className={styles.card} data-make-shop="REQUESTED">
    <h2>{t('waitingTitle')}</h2>
    <p>{t('waiting', { shop: r.shopName, email: r.ownerEmail })}</p>
    <p className={styles.meta}>{t('asked', { when: day(p.locale, r.requestedAt) })}</p>
    {error}
    <div className={styles.row}><button type="button" className={styles.secondary} data-make-shop-cancel disabled={busy} onClick={() => p.onCancel(r.requestId)}>{busy ? t('cancelling') : t('cancel')}</button></div>
  </div>;
  if (r?.status === 'CREATED' && r.shopDomain) { const domain = r.shopDomain; return <div className={styles.card} data-make-shop="CREATED">
    <h2>{t('readyTitle')}</h2>
    <p>{t('ready', { domain })}</p>
    <ol className={styles.plainList}><li>{t('ready1', { email: r.ownerEmail })}</li><li>{t('ready2')}</li><li>{t('ready3')}</li></ol>
    <div className={styles.row}><button type="button" className={styles.primary} data-make-shop-use onClick={() => p.onUseStore(domain)}>{t('useStore')}</button></div>
  </div>; }
  const name = shopName.trim(), mail = email.trim().toLowerCase(), extra = note.trim();
  const valid = shopifyEditText(name, 60) !== null && shopifyOwnerEmail(mail) !== null && (extra === '' || shopifyEditText(extra, 500, true) !== null);
  return <div className={styles.card} data-make-shop="FORM">
    <h2>{t('title')}</h2>
    <p className={styles.meta}>{t('intro')}</p>
    <ol className={styles.plainList}><li>{t('step1')}</li><li>{t('step2')}</li><li>{t('step3')}</li><li>{t('step4')}</li></ol>
    {r?.status === 'DECLINED' && <p className={styles.notice} data-make-shop-last="DECLINED">{t('declined', { when: day(p.locale, r.requestedAt) })}</p>}
    {r?.status === 'CANCELLED' && <p className={styles.meta} data-make-shop-last="CANCELLED">{t('cancelled')}</p>}
    {error}
    <form className={styles.form} onSubmit={(e) => { e.preventDefault(); if (valid && !busy) p.onAsk(name, mail, extra === '' ? null : extra); }}>
      <label className={styles.field}>{t('shopName')}
        <input value={shopName} onChange={(e) => setShopName(e.target.value)} disabled={busy} maxLength={60} autoComplete="organization" aria-describedby="make-shop-name-hint" /></label>
      <span id="make-shop-name-hint" className={styles.meta}>{t('shopNameHint')}</span>
      <label className={styles.field}>{t('ownerEmail')}
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} disabled={busy} maxLength={254} autoComplete="email" spellCheck={false} aria-describedby="make-shop-email-hint" /></label>
      <span id="make-shop-email-hint" className={styles.meta}>{t('ownerEmailHint')}</span>
      <label className={styles.field}>{t('note')}
        <textarea value={note} onChange={(e) => setNote(e.target.value)} disabled={busy} maxLength={500} rows={2} placeholder={t('notePlaceholder')} /></label>
      <div className={styles.row}><button type="submit" className={styles.primary} data-make-shop-ask disabled={busy || !valid}>{busy ? t('asking') : t('ask')}</button></div>
      <p className={styles.meta}>{t('fee')}</p>
    </form>
  </div>;
}

/**
 * Reads the school's latest request and sends one command at a time, never replayed. The Shopify page shows this only to
 * someone who manages Shopify at a school with no store, and unmounts it (dropping everything here) when the page hides.
 */
export function MakeShop({ api = makeShopApi, schoolId, schoolName, language, locale, onUseStore }: {
  api?: MakeShopApi; schoolId: string; schoolName: string | null; language: string; locale: string; onUseStore: (shopDomain: string) => void;
}): React.ReactElement {
  const [state, setState] = useState<MakeShopState>({ state: 'LOADING' });
  const [outcome, setOutcome] = useState<MakeShopOutcome>(null);
  const [refresh, setRefresh] = useState(0);
  const mounted = useRef(false), sending = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    const owned = () => mounted.current && !abort.signal.aborted;
    setState((s) => s.state === 'READY' ? s : { state: 'LOADING' });
    api.read(schoolId, signal, owned).then((v) => { if (owned()) setState({ state: 'READY', request: v.request }); }, () => { if (owned()) setState({ state: 'UNAVAILABLE' }); });
    return () => { abort.abort(); };
  }, [api, schoolId, refresh]);
  const run = useCallback(async (action: 'ask' | 'cancel', send: (owned: () => boolean) => Promise<{ request: ShopifyStoreRequest | null }>) => {
    if (sending.current) return;
    sending.current = true; setOutcome({ kind: 'SENDING', action });
    const owned = () => mounted.current;
    try { const v = await send(owned); if (owned()) { setState({ state: 'READY', request: v.request }); setOutcome(null); } }
    catch (e) { if (owned()) { setOutcome({ kind: 'ERROR', error: e instanceof MakeShopError ? e.kind : 'UNKNOWN' }); setRefresh((n) => n + 1); } }
    finally { sending.current = false; }
  }, []);
  return <MakeShopView language={language} locale={locale} state={state} outcome={outcome} schoolName={schoolName} onUseStore={onUseStore}
    onRefresh={() => setRefresh((n) => n + 1)}
    onAsk={(shopName, ownerEmail, note) => { void run('ask', (owned) => api.ask(schoolId, shopName, ownerEmail, note, AbortSignal.timeout(20000), owned)); }}
    onCancel={(requestId) => { void run('cancel', (owned) => api.cancel(schoolId, requestId, AbortSignal.timeout(20000), owned)); }} />;
}
