import React from 'react';
import { HQ_PLAN_PROMOTION_AUDIENCES, HQ_PLAN_PROMOTION_LIMITS, HQ_PLAN_PROMOTION_STATUSES, HQ_PLAN_PROMOTION_TRANSITIONS,
  type HqPlanPromotion, type HqPlanPromotionList, type HqPlanPromotionListFilter, type HqPlanPromotionListItem, type HqPlanPromotionOffer,
  type HqPlanPromotionPreview, type HqPlanPromotionReceipt, type HqPlanPromotionStatus, type HqPlanPromotionTargetStatus } from '@hon/contracts';
import type { MarketingOutcome } from '../hq-marketing/model';
import { promotionText, type PromotionKey } from './copy';
import { draftFrom, type PromotionDraft } from './model';
import styles from '../hq-access/hq-access.module.css';

export type PromotionListState = { state: 'LOADING' } | { state: 'DENIED' } | { state: 'UNAVAILABLE' }
  | { state: 'READY'; view: HqPlanPromotionList; promotions: readonly HqPlanPromotionListItem[]; loadingMore: boolean; moreFailed: boolean };
/** Which form is open: none, a new promotion, or editing one draft. */
export type PromotionForm = null | { mode: 'CREATE' } | { mode: 'EDIT'; promotionId: string };
/** The start check for one draft: the server's preview of who sees it now, read fresh before Start is offered. */
export type PromotionPreviewState = null | { promotionId: string; state: 'LOADING' } | { promotionId: string; state: 'FAILED' }
  | { promotionId: string; state: 'READY'; preview: HqPlanPromotionPreview; version: number };
export type PromotionOutcome = MarketingOutcome<HqPlanPromotionReceipt>;

export type PromotionViewProps = Readonly<{ language: string; formattingLocale: string; concealed: boolean; state: PromotionListState;
  filter: HqPlanPromotionListFilter | null; form: PromotionForm; preview: PromotionPreviewState; outcome: PromotionOutcome; locked: boolean; canRetry: boolean;
  onFilter: (f: HqPlanPromotionListFilter | null) => void; onMore: () => void; onRefresh: () => void; onReveal: () => void; onForm: (form: PromotionForm) => void;
  onCreate: (draft: PromotionDraft) => void; onUpdate: (promotion: HqPlanPromotion, draft: PromotionDraft) => void;
  onPreview: (promotion: HqPlanPromotion | null) => void; onStart: (promotion: HqPlanPromotion) => void;
  onStatus: (promotion: HqPlanPromotion, status: HqPlanPromotionTargetStatus) => void; onTryAgain: () => void }>;

const FILTERS: readonly (HqPlanPromotionListFilter | null)[] = ['OPEN', ...HQ_PLAN_PROMOTION_STATUSES, null];
const statusTone = (s: HqPlanPromotionStatus) => s === 'ACTIVE' ? 'ready' : s === 'ENDED' ? 'blocked' : 'waiting';
const formatPrice = (locale: string, minor: number) =>
  new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD', minimumFractionDigits: minor % 100 === 0 ? 0 : 2 }).format(minor / 100);
const formatTime = (locale: string, iso: string) =>
  new Intl.DateTimeFormat(locale, { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
const formatDay = (locale: string, day: string) =>
  new Intl.DateTimeFormat(locale, { timeZone: 'UTC', dateStyle: 'medium' }).format(new Date(`${day}T00:00:00.000Z`));
const intervalKey = (o: Pick<HqPlanPromotionOffer, 'billingInterval'>): PromotionKey =>
  o.billingInterval === 'MONTHLY' ? 'perMonth' : o.billingInterval === 'ANNUAL' ? 'perYear' : 'oneTime';
const statusAction = (from: HqPlanPromotionStatus, to: HqPlanPromotionTargetStatus): PromotionKey =>
  to === 'ENDED' ? 'end' : to === 'PAUSED' ? 'pause' : from === 'PAUSED' ? 'resume' : 'start';

function Facts({ rows }: { rows: readonly [string, React.ReactNode][] }): React.ReactElement {
  return <dl className={styles.facts}>{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
}

function Outcome({ language, outcome, canRetry, onTryAgain }: { language: string; outcome: PromotionOutcome; canRetry: boolean; onTryAgain: () => void }): React.ReactElement | null {
  if (!outcome) return null;
  const t = (key: PromotionKey) => promotionText(language, key);
  if (outcome.kind === 'SENDING') return <p className={styles.outcome} role="status" data-promotion-outcome="sending">{t('sending')}</p>;
  if (outcome.kind === 'DONE') {
    const op = outcome.receipt.operation;
    return <p className={styles.outcome} data-tone="ok" role="status" data-promotion-outcome="done">{t(op === 'CREATE' ? 'created_ok' : op === 'UPDATE' ? 'updated_ok' : 'status_ok')}</p>;
  }
  if (outcome.kind === 'UNKNOWN') return <div className={styles.outcome} data-tone="waiting" role="alert" data-promotion-outcome="unknown"><p>{t('unknown')}</p>
    {canRetry && <button type="button" className={styles.secondary} onClick={onTryAgain}>{t('tryAgain')}</button>}</div>;
  const refused = (code: string | null): PromotionKey => code === 'HQ_PLAN_PROMOTION_CODE_TAKEN' ? 'refusedCode' : code === 'HQ_PLAN_PROMOTION_NO_CHANGE' ? 'refusedNoChange'
    : code === 'HQ_PLAN_PROMOTION_OFFER_NOT_ON_SALE' ? 'refusedOffer' : code === 'HQ_PLAN_PROMOTION_WINDOW_ENDED' ? 'refusedWindow' : 'refusedStatus';
  const key: PromotionKey = outcome.kind === 'CHANGED' ? 'changed' : outcome.kind === 'KEY_REUSED' ? 'keyReused' : outcome.kind === 'DENIED' ? 'deniedCommand'
    : outcome.kind === 'INVALID' ? 'invalidCommand' : outcome.kind === 'GONE' ? 'goneCommand' : outcome.kind === 'LOCAL_INVALID' ? 'localInvalid' : refused(outcome.code);
  return <p className={styles.outcome} data-tone="blocked" role="alert" data-promotion-outcome={outcome.kind.toLowerCase()}>{t(key)}</p>;
}

function offerLabel(language: string, locale: string, o: HqPlanPromotionOffer): string {
  return `${o.displayName} · ${formatPrice(locale, o.priceMinor)} ${promotionText(language, intervalKey(o))}`;
}

function PromotionFormView({ language, formattingLocale, offers, promotion, locked, onSubmit, onCancel }: { language: string; formattingLocale: string;
  offers: readonly HqPlanPromotionOffer[]; promotion: HqPlanPromotion | null; locked: boolean; onSubmit: (draft: PromotionDraft) => void; onCancel: () => void }): React.ReactElement {
  const t = (key: PromotionKey) => promotionText(language, key);
  const d = promotion ? draftFrom(promotion) : null, id = promotion ? `hq-pp-${promotion.promotionId}` : 'hq-pp-new';
  // An edited draft keeps showing its own offer even when that offer is no longer in the published set.
  const choices = promotion && !offers.some(o => o.offerId === promotion.offer.offerId) ? [promotion.offer, ...offers] : offers;
  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const f = new FormData(event.currentTarget), v = (k: string) => String(f.get(k) ?? '');
    onSubmit({ code: d ? d.code : v('code'), headline: v('headline'), body: v('body'), buttonLabel: v('buttonLabel'), offerId: v('offerId'),
      audience: v('audience'), schoolIds: v('schoolIds'), firstDay: v('firstDay'), lastDay: v('lastDay') });
  };
  return <form className={styles.form} onSubmit={submit} aria-labelledby={`${id}-title`} data-promotion-form={promotion ? 'edit' : 'create'}>
    <h3 id={`${id}-title`}>{promotion ? `${t('edit')} · ${promotion.code}` : t('newPromotion')}</h3>
    <fieldset className={styles.fields} disabled={locked}>
      {!promotion && <><label htmlFor={`${id}-code`}>{t('code')}</label>
        <input id={`${id}-code`} name="code" required minLength={2} maxLength={HQ_PLAN_PROMOTION_LIMITS.code} autoComplete="off" aria-describedby={`${id}-code-help`}/>
        <p id={`${id}-code-help`} className={styles.meta}>{t('codeHelp')}</p></>}
      <label htmlFor={`${id}-offer`}>{t('offer')}</label>
      <select id={`${id}-offer`} name="offerId" required defaultValue={d?.offerId ?? offers[0]?.offerId}>
        {choices.map(o => <option key={o.offerId} value={o.offerId}>{offerLabel(language, formattingLocale, o)}</option>)}</select>
      <label htmlFor={`${id}-headline`}>{t('headline')}</label>
      <input id={`${id}-headline`} name="headline" required minLength={3} maxLength={HQ_PLAN_PROMOTION_LIMITS.headline} defaultValue={d?.headline} autoComplete="off"/>
      <label htmlFor={`${id}-body`}>{t('body')}</label>
      <textarea id={`${id}-body`} name="body" required rows={3} minLength={3} maxLength={HQ_PLAN_PROMOTION_LIMITS.body} defaultValue={d?.body}/>
      <label htmlFor={`${id}-button`}>{t('buttonLabel')}</label>
      <input id={`${id}-button`} name="buttonLabel" required minLength={2} maxLength={HQ_PLAN_PROMOTION_LIMITS.buttonLabel} defaultValue={d?.buttonLabel} autoComplete="off"/>
      <label htmlFor={`${id}-audience`}>{t('audience')}</label>
      <select id={`${id}-audience`} name="audience" defaultValue={d?.audience ?? 'ALL_SCHOOLS'}>
        {HQ_PLAN_PROMOTION_AUDIENCES.map(a => <option key={a} value={a}>{t(a)}</option>)}</select>
      <label htmlFor={`${id}-schools`}>{t('schoolIds')}</label>
      <textarea id={`${id}-schools`} name="schoolIds" rows={3} defaultValue={d?.schoolIds} aria-describedby={`${id}-schools-help`}/>
      <p id={`${id}-schools-help`} className={styles.meta}>{t('schoolIdsHelp')}</p>
      <div className={styles.pair}>
        <div><label htmlFor={`${id}-first`}>{t('firstDay')}</label><input id={`${id}-first`} name="firstDay" type="date" required defaultValue={d?.firstDay}/></div>
        <div><label htmlFor={`${id}-last`}>{t('lastDay')}</label><input id={`${id}-last`} name="lastDay" type="date" required defaultValue={d?.lastDay}/></div>
      </div>
      <p className={styles.meta}>{t('windowHelp')}</p>
    </fieldset>
    <div className={styles.actions}><button type="submit" className={styles.primary} disabled={locked}>{t(promotion ? 'submitUpdate' : 'submitCreate')}</button>
      <button type="button" className={styles.secondary} disabled={locked} onClick={onCancel}>{t('cancel')}</button></div>
  </form>;
}

function StartCheck({ language, promotion, preview, locked, onStart, onCancel }: { language: string; promotion: HqPlanPromotion; preview: PromotionPreviewState;
  locked: boolean; onStart: (p: HqPlanPromotion) => void; onCancel: () => void }): React.ReactElement | null {
  const t = (key: PromotionKey) => promotionText(language, key);
  if (!preview || preview.promotionId !== promotion.promotionId) return null;
  if (preview.state === 'LOADING') return <p className={styles.notice} role="status" data-promotion-preview="loading">{t('previewLoading')}</p>;
  if (preview.state === 'FAILED') return <div className={styles.notice} role="alert" data-promotion-preview="failed"><p>{t('previewFailed')}</p>
    <button type="button" className={styles.secondary} onClick={onCancel}>{t('cancel')}</button></div>;
  const p = preview.preview;
  return <section className={styles.form} aria-labelledby={`hq-pp-${promotion.promotionId}-preview`} data-promotion-preview="ready">
    <h3 id={`hq-pp-${promotion.promotionId}-preview`}>{t('previewTitle')}</h3>
    <Facts rows={[[t('audienceNow'), String(p.audienceSchools)], [t('eligibleNow'), String(p.eligibleSchools)]]}/>
    <p className={styles.meta}>{t('previewHelp')}</p>
    {!p.offerOnSale && <p className={styles.meta} role="note">{t('previewOffSale')}</p>}
    <p className={styles.meta}>{t('inApp')}</p>
    <div className={styles.actions}><button type="button" className={styles.primary} disabled={locked} data-promotion-start="" onClick={() => onStart(promotion)}>{t('start')}</button>
      <button type="button" className={styles.secondary} disabled={locked} onClick={onCancel}>{t('cancel')}</button></div>
  </section>;
}

/** Presentation only. Every fact comes from the verified server answer. */
export function HqPlanPromotionsView(props: PromotionViewProps): React.ReactElement {
  const { language, formattingLocale, concealed, state, filter, form, locked } = props;
  const t = (key: PromotionKey, vars?: Record<string, string>) => promotionText(language, key, vars);
  const head = <header className={styles.head}>
    <div><h1>{t('title')}</h1><p className={styles.intro}>{t('intro')}</p></div>
    {!concealed && <button type="button" className={styles.secondary} disabled={state.state === 'LOADING'} onClick={props.onRefresh}>{t('refresh')}</button>}
  </header>;
  const back = <div className={styles.actions}><a className={styles.secondary} href="/hq/marketing" data-promotion-back="">{t('back')}</a></div>;
  if (concealed) return <section className={styles.access} data-hq-promotions="concealed">{head}
    <div className={styles.notice} role="status"><p>{t('concealed')}</p><button type="button" className={styles.secondary} onClick={props.onReveal}>{t('reveal')}</button></div></section>;
  if (state.state !== 'READY') return <section className={styles.access} data-hq-promotions={state.state.toLowerCase()} aria-busy={state.state === 'LOADING'}>{head}
    <p className={styles.notice} role="status">{t(state.state === 'LOADING' ? 'loading' : state.state === 'DENIED' ? 'denied' : 'unavailable')}</p>{back}</section>;
  const v = state.view, manage = v.viewer.canManage;
  return <section className={styles.access} data-hq-promotions="ready">{head}
    <p className={styles.meta}>{t('viewer', { name: v.viewer.displayName })}{manage ? '' : ` ${t('readOnly')}`}</p>
    <p className={styles.meta} data-promotion-messaging={v.messaging}>{t('inApp')}</p>
    <div className={styles.filters} role="group" aria-label={t('filterLabel')}>
      {FILTERS.map(f => <button key={f ?? 'ALL'} type="button" aria-pressed={filter === f} onClick={() => props.onFilter(f)}>
        {t(f === null ? 'filterALL' : f === 'OPEN' ? 'filterOPEN' : f)}</button>)}
    </div>
    <Outcome language={language} outcome={props.outcome} canRetry={props.canRetry} onTryAgain={props.onTryAgain}/>
    {manage && (v.offers.length === 0 ? <p className={styles.notice} data-promotion-no-offers="">{t('noOffers')}</p>
      : form?.mode === 'CREATE'
      ? <PromotionFormView language={language} formattingLocale={formattingLocale} offers={v.offers} promotion={null} locked={locked}
          onSubmit={props.onCreate} onCancel={() => props.onForm(null)}/>
      : <div className={styles.actions}><button type="button" className={styles.primary} disabled={locked} onClick={() => props.onForm({ mode: 'CREATE' })}>{t('newPromotion')}</button></div>)}
    {state.promotions.length === 0 ? <p className={styles.notice}>{t('none')}</p> : <ul className={styles.list} aria-label={t('title')}>
      {state.promotions.map(p => <li key={p.promotionId} className={styles.card} data-plan-promotion={p.promotionId}>
        <div className={styles.cardHead}><h3>{p.headline}</h3>
          <span className={styles.status} data-tone={statusTone(p.status)}>{t(p.status)}</span>
          <span className={styles.status} data-tone={p.live ? 'ready' : 'waiting'} data-promotion-live={String(p.live)}>{t(p.live ? 'live' : 'notLive')}</span></div>
        <p className={styles.meta}>{p.body}</p>
        <Facts rows={[[t('code'), p.code], [t('offer'), offerLabel(language, formattingLocale, p.offer)], [t('buttonLabel'), p.buttonLabel],
          [t('audience'), p.audience === 'SELECTED_SCHOOLS' ? `${t(p.audience)} (${p.schoolIds.length})` : t(p.audience)],
          [t('dates'), `${formatDay(formattingLocale, draftFrom(p).firstDay)} – ${formatDay(formattingLocale, draftFrom(p).lastDay)}`],
          [t('createdBy'), p.createdBy.displayName], [t('version'), String(p.version)]]}/>
        {p.status !== 'DRAFT' && <><Facts rows={[[t('seen'), String(p.reach.seenSchools)], [t('opened'), String(p.reach.openedSchools)],
          [t('dismissed'), String(p.reach.dismissedSchools)], [t('started'), String(p.reach.purchaseStartedSchools)]]}/>
          <p className={styles.meta}>{t('reachNote')}</p></>}
        {manage && (form?.mode === 'EDIT' && form.promotionId === p.promotionId
          ? <PromotionFormView language={language} formattingLocale={formattingLocale} offers={v.offers} promotion={p} locked={locked}
              onSubmit={(d) => props.onUpdate(p, d)} onCancel={() => props.onForm(null)}/>
          : p.status === 'ENDED' ? <p className={styles.meta}>{t('endedFinal')}</p>
          : <><div className={styles.actions}>
              {p.status === 'DRAFT' && <button type="button" className={styles.secondary} disabled={locked} onClick={() => props.onForm({ mode: 'EDIT', promotionId: p.promotionId })}>{t('edit')}</button>}
              {p.status === 'DRAFT' && <button type="button" className={styles.secondary} disabled={locked || props.preview?.promotionId === p.promotionId}
                data-promotion-preview-open="" onClick={() => props.onPreview(p)}>{t('preview')}</button>}
              {HQ_PLAN_PROMOTION_TRANSITIONS[p.status].filter(to => !(p.status === 'DRAFT' && to === 'ACTIVE')).map(to => <button key={to} type="button"
                className={styles.secondary} disabled={locked} data-promotion-status={to} onClick={() => props.onStatus(p, to)}>{t(statusAction(p.status, to))}</button>)}
            </div>
            <StartCheck language={language} promotion={p} preview={props.preview} locked={locked} onStart={props.onStart} onCancel={() => props.onPreview(null)}/></>)}
      </li>)}
    </ul>}
    {state.moreFailed && <p className={styles.meta} role="alert">{t('moreFailed')}</p>}
    {v.nextCursor && <div className={styles.actions}><button type="button" className={styles.secondary} disabled={state.loadingMore} onClick={props.onMore}>{t('more')}</button></div>}
    {back}
    <p className={styles.meta}>{t('asOf', { time: formatTime(formattingLocale, v.asOf) })}</p>
  </section>;
}
