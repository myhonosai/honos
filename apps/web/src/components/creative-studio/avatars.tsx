import React, { useId, useState } from 'react';
import { CREATIVE_AVATAR_LIMITS, CREATIVE_AVATAR_OPERATION, CREATIVE_AVATAR_STYLES, CREATIVE_GENERATION_LIMITS, isCreativeAvatarName, isCreativePrompt,
  type CreativeAvatar, type CreativeAvatarInput, type CreativeAvatarStyle } from '@hon/contracts';
import { studioText, type StudioKey } from './copy';
import { outcomeText } from './create';
import type { AvatarsState, CreateOutcome, StudioWallet } from './model';
import styles from './creative-studio.module.css';

type T = (key: StudioKey, vars?: Record<string, string>) => string;
const STATUS: Record<CreativeAvatar['status'], StudioKey> = { CREATING: 'avCREATING', READY: 'avREADY', UNDER_REVIEW: 'avUNDER_REVIEW', NOT_CREATED: 'avNOT_CREATED' };
const TONE: Record<CreativeAvatar['status'], string> = { CREATING: 'waiting', READY: 'ready', UNDER_REVIEW: 'waiting', NOT_CREATED: 'planned' };

export type AvatarsPanelProps = Readonly<{
  language: string; wallet: StudioWallet | null; avatars: AvatarsState; outcome: CreateOutcome;
  /** False while the page is hidden or the wallet is not read: no list and no list error is shown. */
  showList?: boolean | undefined;
  /** True while this tab holds an avatar request that is sending or unconfirmed: the form stays locked. */
  locked?: boolean | undefined;
  /** Avatars that may be this tab's unconfirmed request keep their status and credits but not their text. */
  hideText?: ((a: CreativeAvatar) => boolean) | undefined;
  onCreate?: ((input: CreativeAvatarInput) => void) | undefined; onCheckAgain?: (() => void) | undefined;
}>;

/**
 * The Avatars card (A1, 0276). It offers the form only when the server says a provider is connected, the school is eligible
 * and HQ has published the avatar.create rate; otherwise it says plainly why. The cost shown is the published rate; the
 * server reserves the real amount. An avatar is a made-up presenter described in words: no photo upload in this slice.
 */
export function AvatarsPanel({ language, wallet, avatars, outcome, showList = true, locked = false, hideText, onCreate, onCheckAgain }: AvatarsPanelProps): React.ReactElement {
  const t: T = (key, vars) => studioText(language, key, vars);
  const number = (n: number) => new Intl.NumberFormat(language).format(n);
  const connected = avatars.state === 'READY' && avatars.provider === 'CONNECTED';
  const rate = wallet?.rates?.find(r => r.operationCode === CREATIVE_AVATAR_OPERATION) ?? null;
  const open = connected && !!wallet && wallet.programActive && wallet.eligible;
  const usable = open && !!rate;
  const status = outcomeText(language, outcome);
  const pending = locked || outcome?.kind === 'SENDING' || outcome?.kind === 'UNKNOWN' || outcome?.kind === 'HIDDEN_PENDING' || outcome?.kind === 'RETRY_BLOCKED';
  const live = avatars.state === 'READY' ? avatars.items.filter(a => a.status !== 'NOT_CREATED').length : 0;
  return <article className={styles.card} aria-labelledby="creative-avatars-title" data-avatar-state={usable ? 'OPEN' : !connected ? 'NOT_CONNECTED' : open ? 'NOT_PRICED' : 'BLOCKED'}>
    <div className={styles.cardHead}><h2 id="creative-avatars-title">{t('avatarsTitle')}</h2>
      <span className={styles.status} data-tone={usable ? 'ready' : 'planned'}>{usable ? t('readyStatus') : t('createStatus')}</span></div>
    <p className={styles.meta}>{t('avatarsIntro')}</p>
    {usable && wallet && rate ? <AvatarForm language={language} cost={rate.creditsPerUnit} available={wallet.available} disabled={pending || live >= CREATIVE_AVATAR_LIMITS.maxPerSchool} onCreate={onCreate}/>
      : <p className={styles.note}>{!connected ? t('avatarNotConnected') : open ? t('avatarNotPriced') : t('avatarBlocked')}</p>}
    {status ? <div className={styles.outcome} data-tone={status.tone} role="status">
      <p>{status.text}</p>
      {(outcome?.kind === 'UNKNOWN' || outcome?.kind === 'HIDDEN_PENDING' || outcome?.kind === 'RETRY_BLOCKED') && onCheckAgain ? <button type="button" className={styles.secondary} onClick={onCheckAgain}>{t('checkAgain')}</button> : null}
    </div> : null}
    {!showList ? null : avatars.state === 'READY' ? <>
      <p className={styles.meta}>{t('avatarCount', { n: number(live), max: number(CREATIVE_AVATAR_LIMITS.maxPerSchool) })}</p>
      {avatars.items.length ? <ul className={styles.list}>{avatars.items.map(a => <li key={a.avatarId} data-avatar-status={a.status}>
        <span className={styles.rowMain}><strong>{hideText?.(a) ? t('AVATAR') : a.name}</strong> <small>{t(a.style)}</small>
          <span className={styles.status} data-tone={TONE[a.status]}>{t(STATUS[a.status])}</span></span>
        <span>{a.generation.chargedCredits !== null ? t('credits', { n: number(a.generation.chargedCredits) })
          : a.status === 'CREATING' || a.status === 'UNDER_REVIEW' ? t('creditsHeld', { n: number(a.generation.reservedCredits) }) : t('credits', { n: number(0) })}</span>
        {hideText?.(a) ? <p className={styles.meta} data-prompt-hidden="">{t('hiddenPrompt')}</p> : <p className={styles.prompt}>{a.description}</p>}
        {a.generation.assets.map(x => <small key={x.assetId} className={styles.asset}>{t('assetPreview', { kind: t('IMAGE'), w: String(x.width), h: String(x.height), d: '' })}</small>)}
      </li>)}</ul> : <p className={styles.meta}>{t('avatarsNone')}</p>}
    </> : avatars.state === 'LOADING' ? <p className={styles.meta}>{t('loading')}</p> : <p className={styles.meta}>{t('avatarsUnavailable')}</p>}
  </article>;
}

function AvatarForm({ language, cost, available, disabled, onCreate }: { language: string; cost: number; available: number; disabled: boolean; onCreate?: ((input: CreativeAvatarInput) => void) | undefined }) {
  const t: T = (key, vars) => studioText(language, key, vars);
  const number = (n: number) => new Intl.NumberFormat(language).format(n);
  const id = useId();
  const [name, setName] = useState('');
  const [style, setStyle] = useState<CreativeAvatarStyle>('REALISTIC');
  const [description, setDescription] = useState('');
  const short = cost > available;
  const input = { name: name.trim(), style, description: description.trim() };
  const ready = isCreativeAvatarName(input.name) && isCreativePrompt(input.description) && !short && !disabled;
  const submit = (event: React.FormEvent) => { event.preventDefault(); if (ready && onCreate) onCreate(input); };
  return <form className={styles.form} onSubmit={submit} aria-describedby={`${id}-cost`}>
    <label htmlFor={`${id}-name`}>{t('avatarName')}</label>
    <input id={`${id}-name`} type="text" maxLength={CREATIVE_AVATAR_LIMITS.nameCharacters} value={name} disabled={disabled} autoComplete="off" onChange={e => setName(e.target.value)}/>
    <fieldset className={styles.modes} disabled={disabled}>
      <legend>{t('avatarStyle')}</legend>
      {CREATIVE_AVATAR_STYLES.map(value => <label key={value}><input type="radio" name={`${id}-style`} value={value} checked={style === value} onChange={() => setStyle(value)}/>{t(value)}</label>)}
    </fieldset>
    <label htmlFor={`${id}-describe`}>{t('avatarDescribe')}</label>
    <textarea id={`${id}-describe`} rows={4} maxLength={CREATIVE_GENERATION_LIMITS.promptCharacters} value={description} disabled={disabled}
      aria-describedby={`${id}-help`} onChange={e => setDescription(e.target.value)}/>
    <p id={`${id}-help`} className={styles.meta}>{t('avatarHelp', { n: number(CREATIVE_GENERATION_LIMITS.promptCharacters) })}</p>
    <p id={`${id}-cost`} className={styles.meta} aria-live="polite">{short ? t('createShort') : t('createCost', { cost: number(cost), available: number(available) })}</p>
    <div className={styles.actions}><button type="submit" disabled={!ready}>{t('avatarButton')}</button></div>
  </form>;
}
