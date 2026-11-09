import React from 'react';
import type { SaasCreativeHqWallet, SaasCreativeHqWalletList, SaasCreativeHqWalletRow } from '@hon/contracts';
import { creditsText, type CreditsKey } from './copy';
import { dollars, usd } from './http';
import styles from './hq-creative-credits.module.css';

type T = (key: CreditsKey, vars?: Record<string, string>) => string;
export type ReadState<V> = { state: 'LOADING' | 'DENIED' | 'UNAVAILABLE' } | { state: 'READY'; view: V };
export type DetailState = { state: 'LOADING' | 'DENIED' | 'UNAVAILABLE'; schoolId: string } | { state: 'READY'; schoolId: string; wallet: SaasCreativeHqWallet };

const moment = (language: string, value: string) => new Date(value).toLocaleString(language, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC';
const num = (language: string, n: number) => n.toLocaleString(language);

function Notice({ state, t, onRefresh }: { state: { state: string }; t: T; onRefresh?: (() => void) | undefined }) {
  if (state.state === 'LOADING') return <p className={styles.meta} role="status">{t('loading')}</p>;
  if (state.state === 'DENIED') return <p className={styles.notice} role="status">{t('denied')}</p>;
  return <div className={styles.notice} role="status"><p>{t('unavailable')}</p>{onRefresh ? <button type="button" className={styles.secondary} onClick={onRefresh}>{t('refresh')}</button> : null}</div>;
}

export type CreditsViewProps = Readonly<{
  language: string; concealed: boolean; wallets: ReadState<SaasCreativeHqWalletList>; detail: DetailState | null;
  onRefresh?: (() => void) | undefined; onShowAgain?: (() => void) | undefined; onOpen?: ((schoolId: string) => void) | undefined; onClose?: (() => void) | undefined;
}>;
/** Read-only HQ creative credits. Every value comes from the wallet list read or one school's wallet read; nothing here can change it. */
export function CreditsView(p: CreditsViewProps): React.ReactElement {
  const t: T = (key, vars) => creditsText(p.language, key, vars);
  const w = p.wallets;
  return <section className={styles.page} aria-labelledby="hq-credits-title" data-testid="hq-creative-credits">
    <header className={styles.head}>
      <div><h1 id="hq-credits-title">{t('title')}</h1><p className={styles.intro}>{t('intro')}</p></div>
      {!p.concealed && p.onRefresh ? <button type="button" className={styles.secondary} onClick={p.onRefresh} disabled={w.state === 'LOADING'}>{t('refresh')}</button> : null}
    </header>
    <p className={styles.meta}>{t('scope')}</p>
    {p.concealed ? <div className={styles.notice} role="status"><p>{t('concealed')}</p>
      {p.onShowAgain ? <button type="button" className={styles.secondary} onClick={p.onShowAgain}>{t('showAgain')}</button> : null}</div>
      : w.state !== 'READY' ? <Notice state={w} t={t} onRefresh={p.onRefresh}/> : <Body list={w.view} {...p} t={t}/>}
  </section>;
}

function Body({ list, language, detail, onOpen, onClose, t }: CreditsViewProps & { list: SaasCreativeHqWalletList; t: T }) {
  const active = list.program.status === 'ACTIVE';
  const rates = list.rates;
  return <>
    <div className={styles.grid}>
      <article className={styles.card} aria-labelledby="hq-credits-program">
        <div className={styles.cardHead}><h2 id="hq-credits-program">{t('programTitle')}</h2>
          <span className={styles.chip} data-testid="credits-program" data-state={list.program.status} data-kind={active ? 'ok' : 'off'}>{t(active ? 'on' : 'off')}</span></div>
        <p>{t(active ? 'monthly' : 'monthlyOff', { n: num(language, list.program.monthlyIncludedCredits) })}</p>
        {active ? null : <p className={styles.warnText}>{t('programOffNote')}</p>}
        <p className={styles.meta}>{t('programVersion', { version: String(list.program.version) })}</p>
      </article>
      <article className={styles.card} aria-labelledby="hq-credits-packages">
        <h2 id="hq-credits-packages">{t('packagesTitle')}</h2>
        <ul className={styles.list}>{list.packages.map((k) => <li key={k.packageCode}>
          <strong>{t(`pk_${k.packageCode}` as CreditsKey)}</strong>
          <span>{t('packageRow', { credits: num(language, k.totalCredits), base: num(language, k.baseCredits), bonus: num(language, k.bonusCredits), price: dollars(language, k.priceMinor) })}</span>
        </li>)}</ul>
        <p className={styles.meta}>{t('packagesNote')}</p>
      </article>
    </div>

    <article className={styles.card} aria-labelledby="hq-credits-rates">
      <h2 id="hq-credits-rates">{t('ratesTitle')}</h2>
      {!rates ? <p data-testid="credits-no-rates">{t('noRates')}</p> : <>
        <p className={styles.meta}>{t('ratesVersion', { version: String(rates.rateVersion), time: moment(language, rates.publishedAt) })} · {t('terms')}: <code>{rates.termsReference}</code></p>
        <div className={styles.tableWrap}><table className={styles.table}>
          <thead><tr><th scope="col">{t('rateName')}</th><th scope="col">{t('media')}</th><th scope="col">{t('perUnit')}</th><th scope="col">{t('maxUnits')}</th><th scope="col">{t('basis')}</th></tr></thead>
          <tbody>{rates.rates.map((r) => <tr key={r.operationCode}>
            <th scope="row">{r.displayName}<small><code>{r.operationCode}</code></small></th>
            <td data-label={t('media')}>{t(`m_${r.mediaKind}` as CreditsKey)}</td>
            <td data-label={t('perUnit')}>{num(language, r.creditsPerUnit)} / {t(`u_${r.billingUnit}` as CreditsKey)}</td>
            <td data-label={t('maxUnits')}>{num(language, r.maxUnitsPerRequest)}</td>
            <td data-label={t('basis')}>{t(`b_${r.rateBasis}` as CreditsKey)}</td>
          </tr>)}</tbody>
        </table></div>
      </>}
    </article>

    <article className={styles.card} aria-labelledby="hq-credits-wallets">
      <h2 id="hq-credits-wallets">{t('walletsTitle')}</h2>
      {list.wallets.length === 0 ? <p data-testid="credits-no-wallets">{t('noWallets')}</p> : <>
        <div className={styles.tableWrap}><table className={styles.table}>
          <thead><tr><th scope="col">{t('school')}</th><th scope="col">{t('available')}</th><th scope="col">{t('held')}</th><th scope="col">{t('consumed')}</th>
            <th scope="col">{t('providerCost')}</th><th scope="col">{t('unknownOutcome')}</th><th scope="col">{t('unknownCost')}</th><th scope="col">{t('updated')}</th><th scope="col"><span className={styles.meta}>{t('open')}</span></th></tr></thead>
          <tbody>{list.wallets.map((w) => <WalletRow key={w.schoolId} w={w} language={language} t={t} onOpen={onOpen} open={detail?.schoolId.toLowerCase() === w.schoolId.toLowerCase()}/>)}</tbody>
        </table></div>
        {list.wallets.length >= 200 ? <p className={styles.meta}>{t('more')}</p> : null}
      </>}
    </article>

    {detail ? <Detail detail={detail} name={list.wallets.find((w) => w.schoolId.toLowerCase() === detail.schoolId.toLowerCase())?.schoolName ?? ''} language={language} t={t} onClose={onClose}/> : null}
  </>;
}

function WalletRow({ w, language, t, onOpen, open }: { w: SaasCreativeHqWalletRow; language: string; t: T; onOpen?: ((id: string) => void) | undefined; open: boolean }) {
  const attention = w.outcomeUnknown > 0 || w.unknownCostGenerations > 0;
  return <tr data-testid="credits-wallet" data-school={w.schoolId} data-attention={attention ? 'true' : 'false'}>
    <th scope="row">{w.schoolName}<small>{t('organization', { name: w.organizationName })}</small></th>
    <td data-label={t('available')}>{num(language, w.availableCredits)}</td>
    <td data-label={t('held')}>{num(language, w.heldCredits)}</td>
    <td data-label={t('consumed')}>{num(language, w.consumedCredits)}</td>
    <td data-label={t('providerCost')}>{usd(language, w.actualProviderCostMicrounits)}</td>
    <td data-label={t('unknownOutcome')} className={w.outcomeUnknown ? styles.warnText : undefined}>{num(language, w.outcomeUnknown)}</td>
    <td data-label={t('unknownCost')} className={w.unknownCostGenerations ? styles.warnText : undefined}>{num(language, w.unknownCostGenerations)}</td>
    <td data-label={t('updated')}>{moment(language, w.updatedAt)}</td>
    <td>{onOpen ? <button type="button" className={styles.secondary} aria-pressed={open} aria-label={t('openFor', { school: w.schoolName })} onClick={() => onOpen(w.schoolId)}>{t('open')}</button> : null}</td>
  </tr>;
}

function Detail({ detail, name, language, t, onClose }: { detail: DetailState; name: string; language: string; t: T; onClose?: (() => void) | undefined }) {
  const close = onClose ? <button type="button" className={styles.secondary} onClick={onClose}>{t('close')}</button> : null;
  if (detail.state !== 'READY') {
    return <article className={styles.card} aria-labelledby="hq-credits-detail" data-testid="credits-detail" data-state={detail.state}>
      <div className={styles.cardHead}><h2 id="hq-credits-detail">{t('walletTitle', { school: name })}</h2>{close}</div>
      <p className={detail.state === 'LOADING' ? styles.meta : styles.notice} role="status">{t(detail.state === 'LOADING' ? 'detailLoading' : detail.state === 'DENIED' ? 'detailDenied' : 'detailFailed')}</p>
    </article>;
  }
  const w = detail.wallet, e = w.providerExpense, el = w.eligibility;
  return <article className={styles.card} aria-labelledby="hq-credits-detail" data-testid="credits-detail" data-state="READY">
    <div className={styles.cardHead}><h2 id="hq-credits-detail">{t('walletTitle', { school: name })}</h2>{close}</div>
    <p className={styles.meta}>{w.walletVersion === null ? t('noWallet') : t('walletVersion', { version: String(w.walletVersion) })}</p>
    <p data-testid="credits-eligibility" data-eligible={el.eligible ? 'true' : 'false'} className={el.eligible ? undefined : styles.warnText}>{el.eligible && el.window
      ? t('eligible', { from: moment(language, el.window.startsAt), to: moment(language, el.window.endsAt) })
      : t('notEligible', { reason: t(`r_${el.reason ?? 'PROGRAM_INACTIVE'}` as CreditsKey) })}</p>

    <h3>{t('balanceTitle')}</h3>
    <div className={styles.tableWrap}><table className={styles.table} data-testid="credits-balance">
      <thead><tr><th scope="col">{t('kind')}</th><th scope="col">{t('granted')}</th><th scope="col">{t('available')}</th><th scope="col">{t('held')}</th>
        <th scope="col">{t('consumed')}</th><th scope="col">{t('expired')}</th><th scope="col">{t('debited')}</th></tr></thead>
      <tbody>{w.balance.byKind.map((k) => <tr key={k.kind}>
        <th scope="row">{t(`k_${k.kind}` as CreditsKey)}</th>
        <td data-label={t('granted')}>{num(language, k.grantedCredits)}</td><td data-label={t('available')}>{num(language, k.availableCredits)}</td>
        <td data-label={t('held')}>{num(language, k.heldCredits)}</td><td data-label={t('consumed')}>{num(language, k.consumedCredits)}</td>
        <td data-label={t('expired')}>{num(language, k.expiredCredits)}</td><td data-label={t('debited')}>{num(language, k.debitedCredits)}</td>
      </tr>)}
      <tr><th scope="row">{t('total')}</th><td/><td data-label={t('available')}><strong>{num(language, w.balance.availableCredits)}</strong></td>
        <td data-label={t('held')}><strong>{num(language, w.balance.heldCredits)}</strong></td><td/><td/><td/></tr></tbody>
    </table></div>

    <h3>{t('expenseTitle')}</h3>
    <dl className={styles.facts} data-testid="credits-expense">
      <div><dt>{t('actual')}</dt><dd>{usd(language, e.actualProviderCostMicrounits)}</dd></div>
      <div><dt>{t('finalized')}</dt><dd>{usd(language, e.finalizedProviderCostMicrounits)}</dd></div>
      <div><dt>{t('failed')}</dt><dd>{usd(language, e.failedOrNotChargedProviderCostMicrounits)}</dd></div>
      <div><dt>{t('consumed')}</dt><dd>{num(language, e.consumedCredits)}</dd></div>
      <div><dt>{t('pendingGens')}</dt><dd>{num(language, e.pendingCostGenerations)}</dd></div>
      <div><dt>{t('unknownGens')}</dt><dd className={e.unknownCostGenerations ? styles.warnText : undefined}>{num(language, e.unknownCostGenerations)}</dd></div>
      <div><dt>{t('reservationsTitle')}</dt><dd>{t('gens', { finalized: num(language, e.generations.finalized), released: num(language, e.generations.released),
        reserved: num(language, e.generations.reserved), unknown: num(language, e.generations.outcomeUnknown) })}</dd></div>
    </dl>

    <details className={styles.detail} open>
      <summary>{t('lotsTitle')} ({w.lots.length})</summary>
      {w.lots.length === 0 ? <p className={styles.meta}>{t('noLots')}</p> : <ul className={styles.list}>{w.lots.map((l) => <li key={l.lotId} data-testid="credits-lot">
        <strong>{t('lotRow', { kind: t(`k_${l.kind}` as CreditsKey), credits: num(language, l.credits), time: moment(language, l.grantedAt) })}</strong>
        <span>{t('lotParts', { available: num(language, l.availableCredits), held: num(language, l.heldCredits), consumed: num(language, l.consumedCredits),
          expired: num(language, l.expiredCredits), debited: num(language, l.debitedCredits) })}</span>
        <span className={styles.meta}>{l.expired ? t('lotExpired') : l.expiresAt ? t('expires', { time: moment(language, l.expiresAt) }) : t('noExpiry')}</span>
      </li>)}</ul>}
    </details>

    <details className={styles.detail}>
      <summary>{t('reservationsTitle')} ({w.reservations.length})</summary>
      {w.reservations.length === 0 ? <p className={styles.meta}>{t('noReservations')}</p> : <ul className={styles.list}>{w.reservations.map((r) => <li key={r.reservationId}
        data-testid="credits-reservation" data-status={r.status} data-cost={r.costStatus}>
        <strong>{t('reservationRow', { operation: r.operationCode, media: t(`m_${r.mediaKind}` as CreditsKey), credits: num(language, r.reservedCredits), time: moment(language, r.reservedAt) })}</strong>
        <span className={r.status === 'OUTCOME_UNKNOWN' ? styles.warnText : undefined}>{t(`rs_${r.status}` as CreditsKey)}{r.finalCredits !== null ? ` · ${t('final', { credits: num(language, r.finalCredits) })}` : ''}</span>
        <span className={r.costStatus === 'UNKNOWN' ? styles.warnText : undefined}>{r.costStatus === 'RECORDED' && r.providerCostMicrounits !== null
          ? t('cs_RECORDED', { cost: usd(language, r.providerCostMicrounits) }) : t(`cs_${r.costStatus}` as CreditsKey)}</span>
        <span className={styles.meta}>{t('providerModel', { provider: r.providerId, model: r.modelCode })}</span>
      </li>)}</ul>}
    </details>

    <details className={styles.detail}>
      <summary>{t('adjustmentsTitle')} ({w.adjustments.length})</summary>
      {w.adjustments.length === 0 ? <p className={styles.meta}>{t('noAdjustments')}</p> : <ul className={styles.list}>{w.adjustments.map((a) => <li key={a.adjustmentId} data-testid="credits-adjustment">
        <strong>{t('adjustmentRow', { kind: t(`a_${a.kind}` as CreditsKey), credits: num(language, a.credits), reason: t(`ar_${a.reasonCode}` as CreditsKey), time: moment(language, a.occurredAt) })}</strong>
        <span>{t('note', { note: a.note })}</span>
      </li>)}</ul>}
    </details>

    <details className={styles.detail}>
      <summary>{t('purchasesTitle')} ({w.purchases.length})</summary>
      <p className={styles.meta}>{t('notConnected')}</p>
      {w.purchases.length === 0 ? <p className={styles.meta}>{t('noPurchases')}</p> : <ul className={styles.list}>{w.purchases.map((x) => <li key={x.purchaseId} data-testid="credits-purchase" data-status={x.status}>
        <strong>{t('purchaseRow', { package: t(`pk_${x.packageCode}` as CreditsKey), price: dollars(language, x.priceMinor), time: moment(language, x.createdAt) })}</strong>
        <span className={x.status === 'NEEDS_REVIEW' ? styles.warnText : undefined}>{t(`ps_${x.status}` as CreditsKey)}</span>
        {x.paidAmountMinor !== null && x.paidCurrency ? <span className={styles.meta}>{t('paidRow', { amount: dollars(language, x.paidAmountMinor), currency: x.paidCurrency.toUpperCase() })}</span> : null}
      </li>)}</ul>}
    </details>

    <details className={styles.detail}>
      <summary>{t('historyTitle')}</summary>
      {w.history.length === 0 ? <p className={styles.meta}>{t('noHistory')}</p> : <ul className={styles.list}>{w.history.map((h) => <li key={h.entryId}>
        {t('historyRow', { entry: t(`e_${h.entryKind}` as CreditsKey), credits: num(language, h.credits), kind: t(`k_${h.lotKind}` as CreditsKey), time: moment(language, h.occurredAt) })}
      </li>)}</ul>}
    </details>
  </article>;
}
