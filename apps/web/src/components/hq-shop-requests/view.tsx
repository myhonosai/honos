import React, { useState } from 'react';
import { normalizeShopDomain, type HqShopifyStoreRequest, type HqShopifyStoreRequests } from '@hon/contracts';
import type { MakeShopErrorKind } from '../school-shopify/make-shop-http';
import { makeShopText, type MakeShopKey } from '../school-shopify/make-shop-copy';
import styles from '../hq-access/hq-access.module.css';

export type HqShopRequestsState = { state: 'LOADING' | 'UNAVAILABLE' | 'DENIED' } | { state: 'READY'; view: HqShopifyStoreRequests };
export type HqShopRequestsOutcome = null | Readonly<{ kind: 'SENDING'; requestId: string } | { kind: 'DONE'; outcome: 'CREATED' | 'DECLINED' } | { kind: 'ERROR'; error: MakeShopErrorKind }>;
export type HqShopRequestsViewProps = Readonly<{
  language: string; formattingLocale: string; concealed: boolean; state: HqShopRequestsState; outcome: HqShopRequestsOutcome;
  onSettle: (request: HqShopifyStoreRequest, outcome: 'CREATED' | 'DECLINED', shopDomain: string | null) => void; onRefresh: () => void; onReveal: () => void;
}>;
const when = (locale: string, iso: string | null) => { if (!iso) return ''; try { return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso)); } catch { return iso; } };

function OpenRequest({ r, p, t }: { r: HqShopifyStoreRequest; p: HqShopRequestsViewProps; t: (k: MakeShopKey, v?: Record<string, string>) => string }): React.ReactElement {
  const [domain, setDomain] = useState(''), [declining, setDeclining] = useState(false), [bad, setBad] = useState(false);
  const busy = p.outcome?.kind === 'SENDING', mine = p.outcome?.kind === 'SENDING' && p.outcome.requestId === r.requestId;
  return <article className={styles.card} data-shop-request={r.requestId}>
    <div className={styles.cardHead}><h3>{r.shopName}</h3><span className={styles.status}>{t('st_REQUESTED')}</span></div>
    <dl className={styles.facts}>
      <div className={styles.pair}><dt>{t('hqSchool')}</dt><dd>{r.schoolName}</dd></div>
      <div className={styles.pair}><dt>{t('hqOwner')}</dt><dd>{r.ownerEmail}</dd></div>
      <div className={styles.pair}><dt>{t('hqAsked')}</dt><dd>{when(p.formattingLocale, r.requestedAt)}</dd></div>
      {r.note && <div className={styles.pair}><dt>{t('hqNote')}</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{r.note}</dd></div>}
    </dl>
    {declining ? <><p className={styles.meta}>{t('hqConfirmDecline')}</p>
      <div className={styles.actions}><button type="button" className={styles.danger} data-shop-request-decline disabled={busy} onClick={() => p.onSettle(r, 'DECLINED', null)}>{mine ? t('hqSaving') : t('hqYesDecline')}</button>
        <button type="button" className={styles.secondary} disabled={busy} onClick={() => setDeclining(false)}>{t('hqKeep')}</button></div></>
      : <form className={styles.form} onSubmit={(e) => { e.preventDefault(); const d = normalizeShopDomain(domain); if (!d) { setBad(true); return; } setBad(false); p.onSettle(r, 'CREATED', d); }}>
        <label className={styles.fields}>{t('hqDomain')}
          <input value={domain} onChange={(e) => { setDomain(e.target.value); setBad(false); }} disabled={busy} maxLength={200} autoComplete="off" spellCheck={false} inputMode="url" placeholder={t('hqDomainHint')} /></label>
        {bad && <p className={styles.meta} role="alert">{t('hqBadDomain')}</p>}
        <div className={styles.actions}><button type="submit" className={styles.primary} data-shop-request-made disabled={busy}>{mine ? t('hqSaving') : t('hqMade')}</button>
          <button type="button" className={styles.secondary} disabled={busy} onClick={() => setDeclining(true)}>{t('hqDecline')}</button></div>
      </form>}
  </article>;
}

/** Pure view of HQ's store requests: the steps, every school that is waiting, and the last fifty closed. */
export function HqShopRequestsView(p: HqShopRequestsViewProps): React.ReactElement {
  const t = (key: MakeShopKey, vars?: Record<string, string>) => makeShopText(p.language, key, vars);
  const head = <header className={styles.head}><h1>{t('hqTitle')}</h1><p className={styles.intro}>{t('hqIntro')}</p></header>;
  if (p.concealed) return <section className={styles.access} data-hq-shop-requests="CONCEALED">{head}<p className={styles.notice}>{t('hqConcealed')}</p>
    <div className={styles.actions}><button type="button" className={styles.secondary} onClick={p.onReveal}>{t('hqShow')}</button></div></section>;
  if (p.state.state !== 'READY') return <section className={styles.access} data-hq-shop-requests={p.state.state}>{head}
    {p.state.state === 'LOADING' ? <p className={styles.meta} role="status">{t('loading')}</p>
      : <><p className={styles.notice} role="alert">{t(p.state.state === 'DENIED' ? 'hqDenied' : 'unavailable')}</p>
        {p.state.state === 'UNAVAILABLE' && <div className={styles.actions}><button type="button" className={styles.secondary} onClick={p.onRefresh}>{t('again')}</button></div>}</>}
  </section>;
  const { open, settled } = p.state.view, o = p.outcome;
  return <section className={styles.access} data-hq-shop-requests="READY">
    {head}
    <div className={styles.card}><h2>{t('hqHow')}</h2>
      <ol><li>{t('hqHow1')}</li><li>{t('hqHow2')}</li><li>{t('hqHow3')}</li><li>{t('hqHow4')}</li></ol></div>
    {o?.kind === 'DONE' && <p className={styles.outcome} role="status" data-shop-request-outcome={o.outcome}>{t(o.outcome === 'CREATED' ? 'hqDoneMade' : 'hqDoneDeclined')}</p>}
    {o?.kind === 'ERROR' && <p className={styles.notice} role="alert" data-shop-request-outcome={o.error}>{t(`e_${o.error}`)}</p>}
    <h2>{t('hqOpen')} ({open.length})</h2>
    {open.length === 0 ? <p className={styles.meta}>{t('hqNone')}</p> : <div className={styles.list}>{open.map(r => <OpenRequest key={r.requestId} r={r} p={p} t={t} />)}</div>}
    {settled.length > 0 && <><h2>{t('hqSettled')}</h2>
      <div className={styles.list}>{settled.map(r => <article key={r.requestId} className={styles.card} data-shop-request={r.requestId}>
        <div className={styles.cardHead}><h3>{r.shopName}</h3><span className={styles.status} data-status={r.status}>{t(`st_${r.status}`)}</span></div>
        <dl className={styles.facts}>
          <div className={styles.pair}><dt>{t('hqSchool')}</dt><dd>{r.schoolName}</dd></div>
          <div className={styles.pair}><dt>{t('hqOwner')}</dt><dd>{r.ownerEmail}</dd></div>
          {r.shopDomain && <div className={styles.pair}><dt>{t('hqDomain')}</dt><dd>{r.shopDomain}</dd></div>}
          <div className={styles.pair}><dt>{t('hqClosed')}</dt><dd>{when(p.formattingLocale, r.settledAt)}</dd></div>
        </dl></article>)}</div></>}
  </section>;
}
