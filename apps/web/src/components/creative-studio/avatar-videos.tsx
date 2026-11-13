import React, { useId, useState } from 'react';
import { CREATIVE_AVATAR_VIDEO_LIMITS, CREATIVE_AVATAR_VIDEO_OPERATION, CREATIVE_GENERATION_FORMATS, CREATIVE_GENERATION_LIMITS, isCreativePrompt,
  type CreativeAvatar, type CreativeAvatarVideo, type CreativeAvatarVideoInput, type CreativeGenerationFormat } from '@hon/contracts';
import { studioText, type StudioKey } from './copy';
import { outcomeText } from './create';
import type { AvatarsState, CreateOutcome, StudioWallet, VideosState } from './model';
import styles from './creative-studio.module.css';

type T = (key: StudioKey, vars?: Record<string, string>) => string;
const STATUS: Record<CreativeAvatarVideo['status'], StudioKey> = { CREATING: 'avCREATING', READY: 'avREADY', UNDER_REVIEW: 'avUNDER_REVIEW', NOT_CREATED: 'avNOT_CREATED' };
const TONE: Record<CreativeAvatarVideo['status'], string> = { CREATING: 'waiting', READY: 'ready', UNDER_REVIEW: 'waiting', NOT_CREATED: 'planned' };

export type AvatarVideosPanelProps = Readonly<{
  language: string; wallet: StudioWallet | null; avatars: AvatarsState; videos: VideosState; outcome: CreateOutcome;
  /** False while the page is hidden or the wallet is not read: no list and no list error is shown. */
  showList?: boolean | undefined;
  /** True while this tab holds a video request that is sending or unconfirmed: the form stays locked. */
  locked?: boolean | undefined;
  /** Videos that may be this tab's unconfirmed request keep their status and credits but not their script. */
  hideText?: ((v: CreativeAvatarVideo) => boolean) | undefined;
  onCreate?: ((input: CreativeAvatarVideoInput) => void) | undefined; onCheckAgain?: (() => void) | undefined;
}>;

/**
 * Talking avatar videos (A2, 0277). The form appears only when a provider is connected, the school is eligible, HQ has
 * published the avatar.video rate and the school has a READY avatar; otherwise it says why. The cost shown is the
 * published per-second rate times the length; the server reserves the real amount.
 */
export function AvatarVideosPanel({ language, wallet, avatars, videos, outcome, showList = true, locked = false, hideText, onCreate, onCheckAgain }: AvatarVideosPanelProps): React.ReactElement {
  const t: T = (key, vars) => studioText(language, key, vars);
  const number = (n: number) => new Intl.NumberFormat(language).format(n);
  const connected = avatars.state === 'READY' && avatars.provider === 'CONNECTED';
  const rate = wallet?.rates?.find(r => r.operationCode === CREATIVE_AVATAR_VIDEO_OPERATION) ?? null;
  const open = connected && !!wallet && wallet.programActive && wallet.eligible;
  const ready = avatars.state === 'READY' ? avatars.items.filter(a => a.status === 'READY') : [];
  const usable = open && !!rate && ready.length > 0;
  const status = outcomeText(language, outcome);
  const pending = locked || outcome?.kind === 'SENDING' || outcome?.kind === 'UNKNOWN' || outcome?.kind === 'HIDDEN_PENDING' || outcome?.kind === 'RETRY_BLOCKED';
  const names = new Map((avatars.state === 'READY' ? avatars.items : []).map(a => [a.avatarId, a.name]));
  const state = usable ? 'OPEN' : !connected ? 'NOT_CONNECTED' : !open ? 'BLOCKED' : !rate ? 'NOT_PRICED' : 'NO_AVATAR';
  const note: Record<string, StudioKey> = { NOT_CONNECTED: 'videoNotConnected', BLOCKED: 'videoBlocked', NOT_PRICED: 'videoNotPriced', NO_AVATAR: 'videoNeedsAvatar' };
  return <article className={styles.card} aria-labelledby="creative-avatar-videos-title" data-avatar-video-state={state}>
    <div className={styles.cardHead}><h2 id="creative-avatar-videos-title">{t('videosTitle')}</h2>
      <span className={styles.status} data-tone={usable ? 'ready' : 'planned'}>{usable ? t('readyStatus') : t('createStatus')}</span></div>
    <p className={styles.meta}>{t('videosIntro')}</p>
    {usable && wallet && rate ? <VideoForm language={language} avatars={ready} perSecond={rate.creditsPerUnit}
      maxSeconds={Math.min(CREATIVE_AVATAR_VIDEO_LIMITS.maxSeconds, rate.maxUnitsPerRequest)} available={wallet.available} disabled={pending} onCreate={onCreate}/>
      : <p className={styles.note}>{t(note[state]!)}</p>}
    {status ? <div className={styles.outcome} data-tone={status.tone} role="status">
      <p>{status.text}</p>
      {(outcome?.kind === 'UNKNOWN' || outcome?.kind === 'HIDDEN_PENDING' || outcome?.kind === 'RETRY_BLOCKED') && onCheckAgain ? <button type="button" className={styles.secondary} onClick={onCheckAgain}>{t('checkAgain')}</button> : null}
    </div> : null}
    {!showList ? null : videos.state === 'READY' ? (videos.items.length ? <ul className={styles.list}>{videos.items.map(v => <li key={v.videoId} data-avatar-video-status={v.status}>
      <span className={styles.rowMain}><strong>{t('VIDEO_BY', { name: names.get(v.avatarId) ?? t('AVATAR') })}</strong> <small>{t(v.format)}{t('seconds', { n: number(v.seconds) })}</small>
        <span className={styles.status} data-tone={TONE[v.status]}>{t(STATUS[v.status])}</span></span>
      <span>{v.generation.chargedCredits !== null ? t('credits', { n: number(v.generation.chargedCredits) })
        : v.status === 'CREATING' || v.status === 'UNDER_REVIEW' ? t('creditsHeld', { n: number(v.generation.reservedCredits) }) : t('credits', { n: number(0) })}</span>
      {hideText?.(v) ? <p className={styles.meta} data-prompt-hidden="">{t('hiddenPrompt')}</p> : <p className={styles.prompt}>{v.script}</p>}
      {v.generation.assets.map(x => <small key={x.assetId} className={styles.asset}>{t('assetPreview', { kind: t('VIDEO'), w: String(x.width), h: String(x.height),
        d: x.durationSeconds ? t('seconds', { n: number(x.durationSeconds) }) : '' })}</small>)}
    </li>)}</ul> : <p className={styles.meta}>{t('videosNone')}</p>)
      : videos.state === 'LOADING' ? <p className={styles.meta}>{t('loading')}</p> : <p className={styles.meta}>{t('videosUnavailable')}</p>}
  </article>;
}

function VideoForm({ language, avatars, perSecond, maxSeconds, available, disabled, onCreate }: { language: string; avatars: readonly CreativeAvatar[]; perSecond: number;
  maxSeconds: number; available: number; disabled: boolean; onCreate?: ((input: CreativeAvatarVideoInput) => void) | undefined }) {
  const t: T = (key, vars) => studioText(language, key, vars);
  const number = (n: number) => new Intl.NumberFormat(language).format(n);
  const id = useId();
  const [avatarId, setAvatarId] = useState(avatars[0]!.avatarId);
  const [script, setScript] = useState('');
  const [seconds, setSeconds] = useState(String(Math.min(15, maxSeconds)));
  const [format, setFormat] = useState<CreativeGenerationFormat>('PORTRAIT');
  const chosen = avatars.some(a => a.avatarId === avatarId) ? avatarId : avatars[0]!.avatarId;
  const n = Number(seconds), length = Number.isInteger(n) && n >= CREATIVE_AVATAR_VIDEO_LIMITS.minSeconds && n <= maxSeconds ? n : null;
  const cost = length === null ? null : length * perSecond, short = cost !== null && cost > available;
  const input = { avatarId: chosen, script: script.trim(), seconds: length ?? 0, format };
  const ready = length !== null && isCreativePrompt(input.script) && !short && !disabled;
  const submit = (event: React.FormEvent) => { event.preventDefault(); if (ready && onCreate) onCreate(input); };
  return <form className={styles.form} onSubmit={submit} aria-describedby={`${id}-cost`}>
    <label htmlFor={`${id}-avatar`}>{t('videoAvatar')}</label>
    <select id={`${id}-avatar`} value={chosen} disabled={disabled} onChange={e => setAvatarId(e.target.value)}>
      {avatars.map(a => <option key={a.avatarId} value={a.avatarId}>{a.name} · {t(a.style)}</option>)}
    </select>
    <label htmlFor={`${id}-script`}>{t('videoScript')}</label>
    <textarea id={`${id}-script`} rows={4} maxLength={CREATIVE_GENERATION_LIMITS.promptCharacters} value={script} disabled={disabled}
      aria-describedby={`${id}-help`} onChange={e => setScript(e.target.value)}/>
    <p id={`${id}-help`} className={styles.meta}>{t('videoScriptHelp', { n: number(CREATIVE_GENERATION_LIMITS.promptCharacters) })}</p>
    <label htmlFor={`${id}-seconds`}>{t('videoSeconds', { min: number(CREATIVE_AVATAR_VIDEO_LIMITS.minSeconds), max: number(maxSeconds) })}</label>
    <input id={`${id}-seconds`} type="number" inputMode="numeric" min={CREATIVE_AVATAR_VIDEO_LIMITS.minSeconds} max={maxSeconds} step={1} value={seconds} disabled={disabled}
      onChange={e => setSeconds(e.target.value)}/>
    <fieldset className={styles.modes} disabled={disabled}>
      <legend>{t('createFormat')}</legend>
      {CREATIVE_GENERATION_FORMATS.map(value => <label key={value}><input type="radio" name={`${id}-format`} value={value} checked={format === value} onChange={() => setFormat(value)}/>{t(value)}</label>)}
    </fieldset>
    <p id={`${id}-cost`} className={styles.meta} aria-live="polite">{cost === null ? '' : short ? t('createShort') : t('createCost', { cost: number(cost), available: number(available) })}</p>
    <div className={styles.actions}><button type="submit" disabled={!ready}>{t('videoButton')}</button></div>
  </form>;
}
