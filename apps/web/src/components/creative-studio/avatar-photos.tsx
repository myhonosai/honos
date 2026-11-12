import React, { useId, useState } from 'react';
import { CREATIVE_AVATAR_LIMITS, CREATIVE_AVATAR_OPERATION, CREATIVE_AVATAR_STYLES, CREATIVE_PHOTO_CONSENT_VERSION, CREATIVE_PHOTO_CONTENT_TYPES, CREATIVE_PHOTO_LIMITS,
  isCreativeAvatarName, isCreativePhotoSignature, type CreativeAvatarStyle, type CreativePhotoAvatarInput, type CreativePhotoConsent, type CreativePhotoContentType,
  type CreativePhotoUploadInput } from '@hon/contracts';
import { studioText, type StudioKey } from './copy';
import { outcomeText } from './create';
import type { AvatarsState, CreateOutcome, PhotoOutcome, PhotosState, StudioWallet } from './model';
import styles from './creative-studio.module.css';

type T = (key: StudioKey, vars?: Record<string, string>) => string;
const PHOTO_STATUS: Record<CreativePhotoConsent['status'], StudioKey> = { ACTIVE: 'phACTIVE', WITHDRAWN: 'phWITHDRAWN', INACTIVE: 'phINACTIVE' };
const PHOTO_TONE: Record<CreativePhotoConsent['status'], string> = { ACTIVE: 'ready', WITHDRAWN: 'planned', INACTIVE: 'waiting' };
const PHOTO_TEXT: Record<NonNullable<PhotoOutcome>['kind'], [StudioKey, 'ok' | 'waiting' | 'blocked']> = {
  SAVING: ['photoSaving', 'waiting'], SAVED: ['photoSaved', 'ok'], SAVE_UNKNOWN: ['photoSaveUnknown', 'waiting'], SAVE_INVALID: ['photoSaveInvalid', 'blocked'],
  DELETING: ['photoDeleting', 'waiting'], DELETED: ['photoDeleted', 'ok'], DELETE_UNKNOWN: ['photoDeleteUnknown', 'waiting'], DENIED: ['photoDenied', 'blocked'] };

export type AvatarPhotosPanelProps = Readonly<{
  language: string; wallet: StudioWallet | null; avatars: AvatarsState; photos: PhotosState;
  /** The signed-in person's own active photo as a data: URL, read only for them; null while not read. */
  image?: string | null | undefined;
  photoOutcome?: PhotoOutcome | undefined; avatarOutcome?: CreateOutcome | undefined;
  /** False while the page is hidden or the wallet is not read: no list and no list error is shown. */
  showList?: boolean | undefined;
  /** True while this tab holds a photo save, or a photo avatar request, that is sending or unconfirmed. */
  saveLocked?: boolean | undefined; avatarLocked?: boolean | undefined; deleting?: boolean | undefined;
  onSave?: ((input: CreativePhotoUploadInput) => void) | undefined; onCheckSave?: (() => void) | undefined;
  onDelete?: ((consentId: string) => void) | undefined;
  onCreate?: ((input: CreativePhotoAvatarInput) => void) | undefined; onCheckCreate?: (() => void) | undefined;
}>;

/**
 * Photo avatars (A3, 0305; owner decision 2026-11-12): an adult staff member makes an avatar from a photo of themselves,
 * after signing the likeness consent, and can delete it at any time. Saving and making are offered only when avatars are
 * open to the school (provider connected, eligible, priced); deleting is always offered. A live school owner can delete
 * any staff member's photo but never sees it. The server ties every photo to the signed-in person.
 */
export function AvatarPhotosPanel({ language, wallet, avatars, photos, image = null, photoOutcome = null, avatarOutcome = null, showList = true, saveLocked = false,
  avatarLocked = false, deleting = false, onSave, onCheckSave, onDelete, onCreate, onCheckCreate }: AvatarPhotosPanelProps): React.ReactElement {
  const t: T = (key, vars) => studioText(language, key, vars);
  const number = (n: number) => new Intl.NumberFormat(language).format(n);
  const date = (stamp: string) => new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(stamp));
  const [confirming, setConfirming] = useState<string | null>(null);
  const connected = avatars.state === 'READY' && avatars.provider === 'CONNECTED';
  const rate = wallet?.rates?.find(r => r.operationCode === CREATIVE_AVATAR_OPERATION) ?? null;
  const open = connected && !!wallet && wallet.programActive && wallet.eligible;
  const usable = open && !!rate;
  const state = usable ? 'OPEN' : !connected ? 'NOT_CONNECTED' : open ? 'NOT_PRICED' : 'BLOCKED';
  const note: Record<string, StudioKey> = { NOT_CONNECTED: 'photoNotConnected', NOT_PRICED: 'photoNotPriced', BLOCKED: 'photoBlocked' };
  const ready = showList && photos.state === 'READY' ? photos : null;
  const mine = ready?.items.find(p => p.mine && p.status === 'ACTIVE') ?? null;
  const others = ready && ready.canManageAll ? ready.items.filter(p => !p.mine) : [];
  const live = avatars.state === 'READY' ? avatars.items.filter(a => a.status !== 'NOT_CREATED').length : 0;
  const photoStatus = photoOutcome ? PHOTO_TEXT[photoOutcome.kind] : null;
  const avatarStatus = outcomeText(language, avatarOutcome);
  const avatarPending = avatarLocked || avatarOutcome?.kind === 'SENDING' || avatarOutcome?.kind === 'UNKNOWN' || avatarOutcome?.kind === 'HIDDEN_PENDING' || avatarOutcome?.kind === 'RETRY_BLOCKED';
  const saving = saveLocked || photoOutcome?.kind === 'SAVING' || photoOutcome?.kind === 'SAVE_UNKNOWN';
  const busy = deleting || photoOutcome?.kind === 'DELETING';
  const remove = (consentId: string) => { setConfirming(null); onDelete?.(consentId); };
  const confirm = (p: CreativePhotoConsent, label: string) => confirming === p.consentId
    ? <div className={styles.outcome} data-tone="blocked" role="group" aria-label={label}>
      <p>{t('photoDeleteConfirm')}</p>
      <div className={styles.actions}>
        <button type="button" className={styles.secondary} data-photo-delete-confirm="" disabled={busy} onClick={() => remove(p.consentId)}>{t('photoDeleteYes')}</button>
        <button type="button" className={styles.secondary} onClick={() => setConfirming(null)}>{t('photoDeleteNo')}</button>
      </div>
    </div>
    : <div className={styles.actions}><button type="button" className={styles.secondary} data-photo-delete="" disabled={busy || !onDelete} onClick={() => setConfirming(p.consentId)}>{label}</button></div>;

  return <article className={styles.card} aria-labelledby="creative-avatar-photos-title" data-avatar-photo-state={state}>
    <div className={styles.cardHead}><h2 id="creative-avatar-photos-title">{t('photosTitle')}</h2>
      <span className={styles.status} data-tone={usable ? 'ready' : 'planned'}>{usable ? t('readyStatus') : t('createStatus')}</span></div>
    <p className={styles.meta}>{t('photosIntro')}</p>
    {!usable ? <p className={styles.note}>{t(note[state]!)}</p> : null}
    {photoStatus ? <div className={styles.outcome} data-tone={photoStatus[1]} role="status" data-photo-outcome={photoOutcome!.kind}>
      <p>{t(photoStatus[0])}</p>
      {photoOutcome!.kind === 'SAVE_UNKNOWN' && onCheckSave ? <button type="button" className={styles.secondary} onClick={onCheckSave}>{t('checkAgain')}</button> : null}
    </div> : null}
    {!showList ? null : photos.state === 'READY' ? <>
      {mine ? <section aria-label={t('photoMine')} data-photo-mine="">
        <h3>{t('photoMine')}</h3>
        {image ? <img className={styles.photo} src={image} alt={t('photoMine')} width={160} height={160}/> : null}
        <p className={styles.meta}>{t('photoSignedBy', { name: mine.signatureName, date: date(mine.createdAt) })}</p>
        <p className={styles.meta}>{t('photoAvatarsMade', { n: number(mine.avatarIds.length) })}</p>
        {usable && wallet && rate ? <PhotoAvatarForm language={language} consentId={mine.consentId} cost={rate.creditsPerUnit} available={wallet.available}
          disabled={avatarPending || live >= CREATIVE_AVATAR_LIMITS.maxPerSchool} onCreate={onCreate}/> : null}
        {avatarStatus ? <div className={styles.outcome} data-tone={avatarStatus.tone} role="status">
          <p>{avatarStatus.text}</p>
          {(avatarOutcome?.kind === 'UNKNOWN' || avatarOutcome?.kind === 'HIDDEN_PENDING' || avatarOutcome?.kind === 'RETRY_BLOCKED') && onCheckCreate
            ? <button type="button" className={styles.secondary} onClick={onCheckCreate}>{t('checkAgain')}</button> : null}
        </div> : null}
        {confirm(mine, t('photoDelete'))}
      </section> : usable ? <PhotoUploadForm language={language} disabled={saving} onSave={onSave}/> : null}
      {ready?.canManageAll ? <section aria-label={t('photoStaffTitle')} data-photo-staff="">
        <h3>{t('photoStaffTitle')}</h3>
        <p className={styles.meta}>{t('photoStaffNote')}</p>
        {others.length ? <ul className={styles.list}>{others.map(p => <li key={p.consentId} data-photo-status={p.status}>
          <span className={styles.rowMain}><strong>{p.signatureName}</strong>
            <span className={styles.status} data-tone={PHOTO_TONE[p.status]}>{t(PHOTO_STATUS[p.status])}</span></span>
          <small>{t('photoAvatarsMade', { n: number(p.avatarIds.length) })}</small>
          {p.status !== 'WITHDRAWN' ? confirm(p, t('photoStaffDelete', { name: p.signatureName })) : null}
        </li>)}</ul> : <p className={styles.meta}>{t('photoStaffNone')}</p>}
      </section> : null}
    </> : photos.state === 'LOADING' ? <p className={styles.meta}>{t('loading')}</p> : <p className={styles.meta}>{t('photosUnavailable')}</p>}
  </article>;
}

/** Canonical base64 of the file bytes (no data: prefix), in chunks so a 1 MB photo does not overflow the call stack. */
export async function fileBase64(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}
const TYPES: readonly string[] = CREATIVE_PHOTO_CONTENT_TYPES;

function PhotoUploadForm({ language, disabled, onSave }: { language: string; disabled: boolean; onSave?: ((input: CreativePhotoUploadInput) => void) | undefined }) {
  const t: T = (key, vars) => studioText(language, key, vars);
  const id = useId();
  const [file, setFile] = useState<Readonly<{ contentType: CreativePhotoContentType; photo: string }> | null>(null);
  const [fileError, setFileError] = useState<StudioKey | null>(null);
  const [own, setOwn] = useState(false), [adult, setAdult] = useState(false), [use, setUse] = useState(false);
  const [signature, setSignature] = useState('');
  const name = signature.trim();
  const ready = !!file && own && adult && use && isCreativePhotoSignature(name) && !disabled;
  const choose = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const chosen = event.target.files?.[0] ?? null;
    setFile(null); setFileError(null);
    if (!chosen) return;
    if (!TYPES.includes(chosen.type)) { setFileError('photoFileType'); return; }
    if (chosen.size > CREATIVE_PHOTO_LIMITS.maxBytes) { setFileError('photoFileTooBig'); return; }
    if (chosen.size < CREATIVE_PHOTO_LIMITS.minBytes) { setFileError('photoFileType'); return; }
    try { setFile({ contentType: chosen.type as CreativePhotoContentType, photo: await fileBase64(chosen) }); } catch { setFileError('photoFileType'); }
  };
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!ready || !file || !onSave) return;
    onSave({ consentVersion: CREATIVE_PHOTO_CONSENT_VERSION, ownLikeness: true, adult: true, marketingUse: true, signatureName: name, contentType: file.contentType, photo: file.photo });
  };
  return <form className={styles.form} onSubmit={submit} data-photo-upload="">
    <label htmlFor={`${id}-file`}>{t('photoFile')}</label>
    <input id={`${id}-file`} type="file" accept={CREATIVE_PHOTO_CONTENT_TYPES.join(',')} disabled={disabled} aria-describedby={`${id}-privacy`} onChange={e => { void choose(e); }}/>
    {fileError ? <p className={styles.meta} role="alert">{t(fileError)}</p> : null}
    <p id={`${id}-privacy`} className={styles.meta}>{t('photoPrivacy')}</p>
    <fieldset className={styles.consent} disabled={disabled}>
      <legend>{t('photoConsentLegend')}</legend>
      <label><input type="checkbox" checked={own} onChange={e => setOwn(e.target.checked)}/>{t('photoConsentOwn')}</label>
      <label><input type="checkbox" checked={adult} onChange={e => setAdult(e.target.checked)}/>{t('photoConsentAdult')}</label>
      <label><input type="checkbox" checked={use} onChange={e => setUse(e.target.checked)}/>{t('photoConsentUse')}</label>
    </fieldset>
    <label htmlFor={`${id}-sign`}>{t('photoSignature')}</label>
    <input id={`${id}-sign`} type="text" maxLength={CREATIVE_PHOTO_LIMITS.signatureMax} value={signature} disabled={disabled} autoComplete="name" onChange={e => setSignature(e.target.value)}/>
    <div className={styles.actions}><button type="submit" disabled={!ready}>{t('photoSave')}</button></div>
  </form>;
}

function PhotoAvatarForm({ language, consentId, cost, available, disabled, onCreate }: { language: string; consentId: string; cost: number; available: number; disabled: boolean;
  onCreate?: ((input: CreativePhotoAvatarInput) => void) | undefined }) {
  const t: T = (key, vars) => studioText(language, key, vars);
  const number = (n: number) => new Intl.NumberFormat(language).format(n);
  const id = useId();
  const [name, setName] = useState('');
  const [style, setStyle] = useState<CreativeAvatarStyle>('REALISTIC');
  const short = cost > available;
  const input = { consentId, name: name.trim(), style };
  const ready = isCreativeAvatarName(input.name) && !short && !disabled;
  const submit = (event: React.FormEvent) => { event.preventDefault(); if (ready && onCreate) onCreate(input); };
  return <form className={styles.form} onSubmit={submit} aria-describedby={`${id}-cost`} data-photo-avatar="">
    <label htmlFor={`${id}-name`}>{t('avatarName')}</label>
    <input id={`${id}-name`} type="text" maxLength={CREATIVE_AVATAR_LIMITS.nameCharacters} value={name} disabled={disabled} autoComplete="off" onChange={e => setName(e.target.value)}/>
    <fieldset className={styles.modes} disabled={disabled}>
      <legend>{t('avatarStyle')}</legend>
      {CREATIVE_AVATAR_STYLES.map(value => <label key={value}><input type="radio" name={`${id}-style`} value={value} checked={style === value} onChange={() => setStyle(value)}/>{t(value)}</label>)}
    </fieldset>
    <p className={styles.meta}>{t('photoMakeHelp')}</p>
    <p id={`${id}-cost`} className={styles.meta} aria-live="polite">{short ? t('createShort') : t('createCost', { cost: number(cost), available: number(available) })}</p>
    <div className={styles.actions}><button type="submit" disabled={!ready}>{t('photoMake')}</button></div>
  </form>;
}
