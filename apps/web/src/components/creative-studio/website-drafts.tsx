import React, { useId, useState } from 'react';
import { CREATIVE_GENERATION_LIMITS, CREATIVE_WEBSITE_LIMITS, CREATIVE_WEBSITE_PAGES, isCreativePrompt,
  type CreativeWebsiteDraft, type CreativeWebsiteDraftInput, type CreativeWebsitePage } from '@hon/contracts';
import { studioText, type StudioKey } from './copy';
import { outcomeText } from './create';
import type { CreateOutcome, OpenDraft, StudioWallet, WebsitesState } from './model';
import styles from './creative-studio.module.css';

type T = (key: StudioKey, vars?: Record<string, string>) => string;
const PAGE_KEY = (page: CreativeWebsitePage) => `pg_${page}` as StudioKey;

export type WebsiteDraftsPanelProps = Readonly<{
  language: string; wallet: StudioWallet | null; websites: WebsitesState; outcome: CreateOutcome;
  /** False while the page is hidden or the wallet is not read: no list and no list error is shown. */
  showList?: boolean | undefined;
  /** True while this tab holds a website request that is sending or unconfirmed: the form stays locked. */
  locked?: boolean | undefined;
  /** Drafts that may be this tab's unconfirmed request keep their status and credits but not their brief. */
  hideText?: ((d: CreativeWebsiteDraft) => boolean) | undefined;
  onCreate?: ((input: CreativeWebsiteDraftInput) => void) | undefined; onCheckAgain?: (() => void) | undefined;
  /** The one draft whose pages are open, read on demand from the single-draft endpoint. */
  openDraft?: OpenDraft | undefined; onView?: ((draftId: string) => void) | undefined; onHide?: (() => void) | undefined;
}>;

/**
 * The Website draft card (WB1, 0344). It offers the form only when the server says a website provider is connected, the
 * school is eligible and HQ has published a WEBSITE rate (credits per page); otherwise it says plainly why. The cost shown
 * is pages × the published rate; the server reserves the real amount and charges only the pages returned. Nothing is published.
 */
export function WebsiteDraftsPanel({ language, wallet, websites, outcome, showList = true, locked = false, hideText, onCreate, onCheckAgain,
  openDraft = null, onView, onHide }: WebsiteDraftsPanelProps): React.ReactElement {
  const t: T = (key, vars) => studioText(language, key, vars);
  const number = (n: number) => new Intl.NumberFormat(language).format(n);
  const date = (stamp: string) => new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(stamp)) + ' UTC';
  const connected = websites.state === 'READY' && websites.provider === 'CONNECTED';
  const rate = wallet?.websiteRate ?? null;
  const open = connected && !!wallet && wallet.programActive && wallet.eligible;
  const usable = open && !!rate;
  const status = outcomeText(language, outcome);
  const pending = locked || outcome?.kind === 'SENDING' || outcome?.kind === 'UNKNOWN' || outcome?.kind === 'HIDDEN_PENDING' || outcome?.kind === 'RETRY_BLOCKED';
  const busy = websites.state === 'READY' && websites.items.some(d => d.status === 'GENERATING');
  const credits = (d: CreativeWebsiteDraft) => d.chargedCredits !== null ? t('credits', { n: number(d.chargedCredits) })
    : d.status === 'GENERATING' || d.status === 'UNDER_REVIEW' ? t('creditsHeld', { n: number(d.reservedCredits) }) : t('credits', { n: number(0) });
  return <article className={styles.card} aria-labelledby="creative-websites-title" data-website-state={usable ? 'OPEN' : !connected ? 'NOT_CONNECTED' : open ? 'NOT_PRICED' : 'BLOCKED'}>
    <div className={styles.cardHead}><h2 id="creative-websites-title">{t('wsTitle')}</h2>
      <span className={styles.status} data-tone={usable ? 'ready' : 'planned'}>{usable ? t('readyStatus') : t('createStatus')}</span></div>
    <p className={styles.meta}>{t('wsIntro')}</p>
    {usable && wallet && rate ? <WebsiteForm language={language} perPage={rate.creditsPerUnit} maxPages={Math.min(CREATIVE_WEBSITE_LIMITS.maxPages, rate.maxUnitsPerRequest)}
      operationCode={rate.operationCode} available={wallet.available} disabled={pending || busy} onCreate={onCreate}/>
      : <p className={styles.note}>{!connected ? t('wsNotConnected') : open ? t('wsNotPriced') : t('wsBlocked')}</p>}
    {status ? <div className={styles.outcome} data-tone={status.tone} role="status">
      <p>{status.text}</p>
      {(outcome?.kind === 'UNKNOWN' || outcome?.kind === 'HIDDEN_PENDING' || outcome?.kind === 'RETRY_BLOCKED') && onCheckAgain ? <button type="button" className={styles.secondary} onClick={onCheckAgain}>{t('checkAgain')}</button> : null}
    </div> : null}
    {!showList ? null : websites.state === 'READY' ? websites.items.length ? <ul className={styles.list}>{websites.items.map(d => {
      const hidden = !!hideText?.(d);
      const shown = openDraft && openDraft.draftId === d.draftId ? openDraft : null;
      return <li key={d.draftId} data-website-status={d.status}>
        <span className={styles.rowMain}><strong>{d.pages.map(p => t(PAGE_KEY(p))).join(', ')}</strong>
          <span className={styles.status} data-tone={d.status === 'SUCCEEDED' || d.status === 'RESOLVED_CHARGED' ? 'ready' : d.status === 'FAILED' || d.status === 'RESOLVED_NOT_CHARGED' ? 'planned' : 'waiting'}>{t(d.status)}</span></span>
        <span>{credits(d)}</span>
        {hidden ? <p className={styles.meta} data-prompt-hidden="">{t('hiddenPrompt')}</p> : <p className={styles.prompt}>{d.brief}</p>}
        <small><time dateTime={d.createdAt}>{date(d.createdAt)}</time></small>
        {d.status === 'SUCCEEDED' && !hidden ? <div className={styles.actions}>
          {shown ? <button type="button" className={styles.secondary} onClick={onHide}>{t('wsHide')}</button>
            : onView ? <button type="button" className={styles.secondary} onClick={() => onView(d.draftId)}>{t('wsView')}</button> : null}
        </div> : null}
        {shown?.state === 'LOADING' ? <p className={styles.meta}>{t('loading')}</p> : null}
        {shown?.state === 'FAILED' ? <p className={styles.meta} role="status">{t('wsLoadFailed')}</p> : null}
        {shown?.state === 'READY' && shown.draft.content ? <div data-website-content="">
          <p className={styles.meta}>{t('wsSynthetic')}</p>
          {shown.draft.content.map(page => <section key={page.pageKey} aria-label={t(PAGE_KEY(page.pageKey))}>
            <h3>{t(PAGE_KEY(page.pageKey))}: {page.title}</h3>
            {page.sections.map((s, i) => <div key={i}><h4>{s.heading}</h4><p className={styles.prompt}>{s.body}</p></div>)}
          </section>)}
        </div> : null}
      </li>;
    })}</ul> : <p className={styles.meta}>{t('wsNone')}</p>
      : websites.state === 'LOADING' ? <p className={styles.meta}>{t('loading')}</p> : <p className={styles.meta}>{t('wsUnavailable')}</p>}
  </article>;
}

function WebsiteForm({ language, perPage, maxPages, operationCode, available, disabled, onCreate }: { language: string; perPage: number; maxPages: number; operationCode: string;
  available: number; disabled: boolean; onCreate?: ((input: CreativeWebsiteDraftInput) => void) | undefined }) {
  const t: T = (key, vars) => studioText(language, key, vars);
  const number = (n: number) => new Intl.NumberFormat(language).format(n);
  const id = useId();
  const [chosen, setChosen] = useState<ReadonlySet<CreativeWebsitePage>>(new Set(['HOME']));
  const [brief, setBrief] = useState('');
  // Always in the fixed page order, as the server requires.
  const pages = CREATIVE_WEBSITE_PAGES.filter(p => chosen.has(p));
  const cost = pages.length * perPage;
  const short = cost > available;
  const input: CreativeWebsiteDraftInput = { operationCode, pages, brief: brief.trim() };
  const ready = pages.length >= 1 && pages.length <= maxPages && isCreativePrompt(input.brief) && !short && !disabled;
  const toggle = (page: CreativeWebsitePage) => setChosen(prior => { const next = new Set(prior); if (next.has(page)) next.delete(page); else next.add(page); return next; });
  const submit = (event: React.FormEvent) => { event.preventDefault(); if (ready && onCreate) onCreate(input); };
  return <form className={styles.form} onSubmit={submit} aria-describedby={`${id}-cost`}>
    <fieldset className={styles.modes} disabled={disabled}>
      <legend>{t('wsPages')}</legend>
      {CREATIVE_WEBSITE_PAGES.map(page => <label key={page}><input type="checkbox" value={page} checked={chosen.has(page)}
        disabled={!chosen.has(page) && pages.length >= maxPages} onChange={() => toggle(page)}/>{t(PAGE_KEY(page))}</label>)}
    </fieldset>
    <label htmlFor={`${id}-brief`}>{t('wsBrief')}</label>
    <textarea id={`${id}-brief`} rows={4} maxLength={CREATIVE_GENERATION_LIMITS.promptCharacters} value={brief} disabled={disabled}
      aria-describedby={`${id}-help`} onChange={e => setBrief(e.target.value)}/>
    <p id={`${id}-help`} className={styles.meta}>{t('wsHelp', { n: number(CREATIVE_GENERATION_LIMITS.promptCharacters) })}</p>
    <p id={`${id}-cost`} className={styles.meta} aria-live="polite">{short ? t('createShort')
      : t('wsCost', { cost: number(cost), per: number(perPage), available: number(available) })}</p>
    <div className={styles.actions}><button type="submit" disabled={!ready}>{t('wsButton')}</button></div>
  </form>;
}
