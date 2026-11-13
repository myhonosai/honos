import React from 'react';
import { accountValue } from '../account-status/copy';
import { studioEntryText, studioText, type StudioKey } from './copy';
import type { AvatarsState, OpenDraft, VideosState, WebsitesState, CreateOutcome, GenerationsState, StudioRate, StudioState, StudioWallet } from './model';
import { CreatePanel, GenerationsPanel } from './create';
import { AvatarsPanel } from './avatars';
import { AvatarVideosPanel } from './avatar-videos';
import { WebsiteDraftsPanel } from './website-drafts';
import type { CreativeAvatar, CreativeAvatarInput, CreativeAvatarVideo, CreativeAvatarVideoInput, CreativeGeneration, CreativeGenerationInput, CreativeWebsiteDraft, CreativeWebsiteDraftInput } from '@hon/contracts';
import styles from './creative-studio.module.css';

export type CreativeStudioViewProps = Readonly<{
  language: string; waiting: boolean; concealed: boolean; hasSchool: boolean; studio: StudioState; onRefresh?: () => void;
  /** The generations read; NOT_CONNECTED or a failed read keeps creation off. */
  generations?: GenerationsState; outcome?: CreateOutcome; locked?: boolean | undefined;
  hidePrompt?: ((g: CreativeGeneration) => boolean) | undefined;
  onCreate?: ((input: CreativeGenerationInput) => void) | undefined; onCheckAgain?: (() => void) | undefined;
  /** A1 (0276) avatars: the read, this tab's avatar request outcome and lock. */
  avatars?: AvatarsState; avatarOutcome?: CreateOutcome; avatarLocked?: boolean | undefined; hideAvatarText?: ((a: CreativeAvatar) => boolean) | undefined;
  onCreateAvatar?: ((input: CreativeAvatarInput) => void) | undefined; onCheckAvatarAgain?: (() => void) | undefined;
  /** A2 (0277) talking avatar videos: the read, this tab's video request outcome and lock. */
  videos?: VideosState; videoOutcome?: CreateOutcome; videoLocked?: boolean | undefined; hideVideoText?: ((v: CreativeAvatarVideo) => boolean) | undefined;
  onCreateVideo?: ((input: CreativeAvatarVideoInput) => void) | undefined; onCheckVideoAgain?: (() => void) | undefined;
  /** WB1 (0344) website drafts: the read, this tab's website request outcome and lock, and the one open draft. */
  websites?: WebsitesState; websiteOutcome?: CreateOutcome; websiteLocked?: boolean | undefined; hideWebsiteText?: ((d: CreativeWebsiteDraft) => boolean) | undefined;
  onCreateWebsite?: ((input: CreativeWebsiteDraftInput) => void) | undefined; onCheckWebsiteAgain?: (() => void) | undefined;
  openDraft?: OpenDraft | undefined; onViewWebsite?: ((draftId: string) => void) | undefined; onHideWebsite?: (() => void) | undefined;
}>;

const UNIT: Record<StudioRate['billingUnit'], StudioKey> = { IMAGE: 'perImage', VIDEO_SECOND: 'perSecond', REQUEST: 'perRequest' };

/** Pure view. Every number comes from the school's wallet read; generation is shown as not connected. */
export function CreativeStudioView({ language, waiting, concealed, hasSchool, studio, onRefresh, generations = { state: 'UNAVAILABLE' }, outcome = null, locked = false, hidePrompt, onCreate, onCheckAgain,
  avatars = { state: 'UNAVAILABLE' }, avatarOutcome = null, avatarLocked = false, hideAvatarText, onCreateAvatar, onCheckAvatarAgain,
  videos = { state: 'UNAVAILABLE' }, videoOutcome = null, videoLocked = false, hideVideoText, onCreateVideo, onCheckVideoAgain,
  websites = { state: 'UNAVAILABLE' }, websiteOutcome = null, websiteLocked = false, hideWebsiteText, onCreateWebsite, onCheckWebsiteAgain, openDraft = null, onViewWebsite, onHideWebsite }: CreativeStudioViewProps): React.ReactElement {
  const t = (key: StudioKey, vars?: Record<string, string>) => studioText(language, key, vars);
  const number = (n: number) => new Intl.NumberFormat(language).format(n);
  const notice = waiting ? t('waiting') : concealed ? t('concealed') : !hasSchool ? t('noSchool')
    : studio.state === 'LOADING' ? t('loading') : studio.state === 'DENIED' ? t('denied') : studio.state === 'UNAVAILABLE' ? t('unavailable') : null;
  const visible = !waiting && !concealed && hasSchool;
  const wallet = visible && studio.state === 'READY' ? studio.wallet : null;
  return <section className={styles.studio} aria-labelledby="creative-studio-title" data-hon-native="">
    <header className={styles.head}>
      <div><h1 id="creative-studio-title">{t('title')}</h1><p className={styles.intro}>{t('intro')}</p></div>
      {onRefresh && hasSchool && !waiting && !concealed ? <button type="button" className={styles.secondary} onClick={onRefresh} disabled={studio.state === 'LOADING'}>{t('refresh')}</button> : null}
    </header>
    <CreatePanel language={language} wallet={wallet} generations={visible ? generations : { state: 'UNAVAILABLE' }} outcome={visible ? outcome : null} locked={locked}
      onCreate={onCreate} onCheckAgain={onCheckAgain}/>
    <AvatarsPanel language={language} wallet={wallet} avatars={visible ? avatars : { state: 'UNAVAILABLE' }} showList={!!wallet} outcome={visible ? avatarOutcome : null} locked={avatarLocked}
      hideText={hideAvatarText} onCreate={onCreateAvatar} onCheckAgain={onCheckAvatarAgain}/>
    <AvatarVideosPanel language={language} wallet={wallet} avatars={visible ? avatars : { state: 'UNAVAILABLE' }} videos={visible ? videos : { state: 'UNAVAILABLE' }} showList={!!wallet}
      outcome={visible ? videoOutcome : null} locked={videoLocked} hideText={hideVideoText} onCreate={onCreateVideo} onCheckAgain={onCheckVideoAgain}/>
    <WebsiteDraftsPanel language={language} wallet={wallet} websites={visible ? websites : { state: 'UNAVAILABLE' }} showList={!!wallet} outcome={visible ? websiteOutcome : null}
      locked={websiteLocked} hideText={hideWebsiteText} onCreate={onCreateWebsite} onCheckAgain={onCheckWebsiteAgain} openDraft={visible ? openDraft : null} onView={onViewWebsite} onHide={onHideWebsite}/>
    {notice ? <p className={styles.notice} role="status">{notice}</p> : null}
    {wallet ? <WalletCards wallet={wallet} language={language} t={t} number={number}/> : null}
    {wallet ? <GenerationsPanel language={language} generations={generations} hidePrompt={hidePrompt}/> : null}
  </section>;
}

function WalletCards({ wallet, language, t, number }: { wallet: StudioWallet; language: string; t: (key: StudioKey, vars?: Record<string, string>) => string; number: (n: number) => string }) {
  const date = (stamp: string) => new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(stamp));
  const money = (minor: number, currency: string) => new Intl.NumberFormat(language, { style: 'currency', currency: currency.toUpperCase() }).format(minor / 100);
  return <div className={styles.grid}>
    <article className={styles.card} aria-labelledby="creative-credits-title">
      <h2 id="creative-credits-title">{t('creditsTitle')}</h2>
      <dl className={styles.stats}>
        <div><dt>{t('available')}</dt><dd data-testid="creative-available">{number(wallet.available)}</dd></div>
        <div><dt>{t('held')}</dt><dd>{number(wallet.held)}</dd></div>
        <div><dt>{t('monthly')}</dt><dd>{number(wallet.monthlyIncluded)}</dd></div>
      </dl>
      {!wallet.programActive ? <p className={styles.meta}>{t('programOff')}</p> : null}
      {wallet.programActive && !wallet.eligible ? <p className={styles.meta}>{t('ineligible')}{wallet.reason ? `: ${accountValue(language, wallet.reason)}` : ''}.</p> : null}
      {wallet.window ? <p className={styles.meta}>{t('windowLabel')}: {date(wallet.window.startsAt)} – {date(wallet.window.endsAt)}</p> : null}
    </article>
    <article className={styles.card} aria-labelledby="creative-rates-title">
      <h2 id="creative-rates-title">{t('ratesTitle')}</h2>
      {wallet.rates && wallet.rates.length ? <ul className={styles.list}>{wallet.rates.map(rate => <li key={rate.operationCode}>
        <span className={styles.rowMain}><strong>{rate.displayName}</strong> <small>{t(rate.mediaKind)}</small>
          {rate.provisional ? <span className={styles.status} data-tone="waiting">{t('provisional')}</span> : null}</span>
        <span>{number(rate.creditsPerUnit)} {t(UNIT[rate.billingUnit])}</span>
        <small>{t('maxUnits', { n: number(rate.maxUnitsPerRequest) })}</small>
      </li>)}</ul> : <p className={styles.meta}>{t('ratesNone')}</p>}
    </article>
    <article className={styles.card} aria-labelledby="creative-history-title">
      <h2 id="creative-history-title">{t('historyTitle')}</h2>
      {wallet.history.length ? <ul className={styles.list}>{wallet.history.map(entry => <li key={entry.entryId}>
        <span className={styles.rowMain}><strong>{studioEntryText(language, entry.entryKind)}</strong> <small>{accountValue(language, entry.lotKind)}</small></span>
        <span>{number(entry.credits)}</span><small><time dateTime={entry.occurredAt}>{date(entry.occurredAt)}</time></small>
      </li>)}</ul> : <p className={styles.meta}>{t('historyNone')}</p>}
    </article>
    {wallet.packages.length ? <article className={styles.card} aria-labelledby="creative-topups-title">
      <h2 id="creative-topups-title">{t('topupsTitle')}</h2>
      <p className={styles.meta}>{t('topupsNote')}</p>
      <ul className={styles.list}>{wallet.packages.map(pack => <li key={pack.packageCode}>
        <span className={styles.rowMain}><strong>{number(pack.totalCredits)}</strong>{pack.bonusCredits ? <small>{t('bonus', { n: number(pack.bonusCredits) })}</small> : null}</span>
        <span>{money(pack.priceMinor, pack.currency)}</span>
      </li>)}</ul>
    </article> : null}
  </div>;
}
