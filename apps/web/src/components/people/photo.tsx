'use client';
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { PersonPhoto as Photo, PersonRecord } from '@hon/contracts';
import { PhotoError, keepPhotoForRetry, photoApi, shrinkPhoto, type PhotoApi, type PhotoErrorKind } from './photo-http';
import styles from './people.module.css';

/** Contact photo wording (en / ko / es). */
const en = {
  title: 'Photo', intro: 'Shown on attendance cards and on the front-desk check-in screen. Only staff at this school can see it.',
  consent: 'For a child, ask a parent before taking or saving a photo.', loading: 'Reading the photo…', none: 'No photo yet.',
  denied: 'Your access does not include photos at this school.', unavailable: 'The photo could not be loaded.', reload: 'Reload',
  missing: 'This person is not at this school.', alt: 'Photo of {name}', take: 'Take or choose a photo', replace: 'Take or choose a new photo',
  preview: 'New photo, not saved yet', save: 'Save photo', cancel: 'Cancel', remove: 'Remove photo',
  removeAsk: 'Remove the photo of {name}? It is deleted and no longer shown on cards.', removeConfirm: 'Yes, remove it', back: 'Keep it',
  readOnly: 'You can see this photo, but your access does not include changing it.', unreadable: 'That file could not be read as a photo. Try a JPEG or PNG.',
  sending: 'Saving… keep this tab open.', saved: 'Photo saved.', removed: 'Photo removed.', replayed: '(It had already been saved.)',
  outDenied: 'Your access does not include changing photos. Nothing changed.', outMissing: 'This person is no longer at this school. Nothing changed.',
  outConflict: 'Someone else changed this photo. Nothing changed. The latest is shown.', outInvalid: 'This photo was not accepted. Use a JPEG or PNG and try again.',
  outBusy: 'The photo was busy and nothing was saved. Try again in a moment.',
  outUnknown: 'We could not confirm whether this was saved. Try again sends the same photo; it is never saved twice.', tryAgain: 'Try again', stop: 'Stop',
} as const;
type Key = keyof typeof en;
const ko: Record<Key, string> = {
  title: '사진', intro: '출석 카드와 프런트 데스크 체크인 화면에 표시됩니다. 이 학교의 직원만 볼 수 있습니다.',
  consent: '어린이의 사진은 찍거나 저장하기 전에 보호자에게 먼저 허락을 받으세요.', loading: '사진을 읽는 중…', none: '아직 사진이 없습니다.',
  denied: '이 학교의 사진을 볼 권한이 없습니다.', unavailable: '사진을 불러오지 못했습니다.', reload: '다시 불러오기',
  missing: '이 사람은 이 학교에 없습니다.', alt: '{name}의 사진', take: '사진 찍기 또는 선택', replace: '새 사진 찍기 또는 선택',
  preview: '새 사진 (아직 저장되지 않음)', save: '사진 저장', cancel: '취소', remove: '사진 삭제',
  removeAsk: '{name}의 사진을 삭제할까요? 삭제되면 카드에 더 이상 표시되지 않습니다.', removeConfirm: '네, 삭제합니다', back: '그대로 두기',
  readOnly: '이 사진을 볼 수는 있지만 변경할 권한은 없습니다.', unreadable: '이 파일을 사진으로 읽을 수 없습니다. JPEG 또는 PNG를 사용해 보세요.',
  sending: '저장 중… 이 탭을 열어 두세요.', saved: '사진이 저장되었습니다.', removed: '사진이 삭제되었습니다.', replayed: '(이미 저장되어 있었습니다.)',
  outDenied: '사진을 변경할 권한이 없습니다. 변경된 것은 없습니다.', outMissing: '이 사람은 더 이상 이 학교에 없습니다. 변경된 것은 없습니다.',
  outConflict: '다른 사람이 이 사진을 변경했습니다. 변경된 것은 없습니다. 최신 사진을 표시합니다.', outInvalid: '이 사진은 받아들여지지 않았습니다. JPEG 또는 PNG로 다시 시도하세요.',
  outBusy: '사진이 사용 중이어서 저장되지 않았습니다. 잠시 후 다시 시도하세요.',
  outUnknown: '저장되었는지 확인하지 못했습니다. 다시 시도하면 같은 사진을 보내며, 두 번 저장되지 않습니다.', tryAgain: '다시 시도', stop: '중단',
};
const es: Record<Key, string> = {
  title: 'Foto', intro: 'Se muestra en las tarjetas de asistencia y en la pantalla de registro de la recepción. Solo el personal de esta escuela puede verla.',
  consent: 'Para un niño, pida permiso a un padre o tutor antes de tomar o guardar una foto.', loading: 'Leyendo la foto…', none: 'Todavía no hay foto.',
  denied: 'Su acceso no incluye las fotos de esta escuela.', unavailable: 'No se pudo cargar la foto.', reload: 'Volver a cargar',
  missing: 'Esta persona no está en esta escuela.', alt: 'Foto de {name}', take: 'Tomar o elegir una foto', replace: 'Tomar o elegir una foto nueva',
  preview: 'Foto nueva, aún sin guardar', save: 'Guardar foto', cancel: 'Cancelar', remove: 'Quitar foto',
  removeAsk: '¿Quitar la foto de {name}? Se elimina y ya no aparece en las tarjetas.', removeConfirm: 'Sí, quitarla', back: 'Conservarla',
  readOnly: 'Puede ver esta foto, pero su acceso no incluye cambiarla.', unreadable: 'Ese archivo no se pudo leer como foto. Pruebe con JPEG o PNG.',
  sending: 'Guardando… mantenga esta pestaña abierta.', saved: 'Foto guardada.', removed: 'Foto quitada.', replayed: '(Ya estaba guardada.)',
  outDenied: 'Su acceso no incluye cambiar fotos. No se cambió nada.', outMissing: 'Esta persona ya no está en esta escuela. No se cambió nada.',
  outConflict: 'Otra persona cambió esta foto. No se cambió nada. Se muestra la más reciente.', outInvalid: 'Esta foto no fue aceptada. Use JPEG o PNG e inténtelo de nuevo.',
  outBusy: 'La foto estaba ocupada y no se guardó nada. Inténtelo de nuevo en un momento.',
  outUnknown: 'No pudimos confirmar si se guardó. Intentar de nuevo envía la misma foto; nunca se guarda dos veces.', tryAgain: 'Intentar de nuevo', stop: 'Detener',
};
export type PhotoKey = Key;
export function photoText(language: string, key: Key, vars: Record<string, string> = {}): string {
  const table = language.toLowerCase().startsWith('ko') ? ko : language.toLowerCase().startsWith('es') ? es : en;
  return (table[key] ?? en[key]).replace(/\{(\w+)\}/g, (_, v: string) => vars[v] ?? '');
}

export type PhotoRead = Readonly<{ state: 'LOADING' | 'DENIED' | 'UNAVAILABLE' | 'MISSING' }> | Readonly<{ state: 'READY'; photo: Photo | null }>;
export type PhotoOutcome = null | Readonly<{ kind: 'SENDING' | 'SAVED' | 'REMOVED' | 'UNREADABLE' | Exclude<PhotoErrorKind, 'SESSION'>; replayed?: boolean }>;
export type PhotoCardProps = Readonly<{
  language: string; name: string; initials: string; canEdit: boolean; read: PhotoRead;
  /** base64 JPEG chosen and shrunk in this tab, not saved yet. */ draft: string | null;
  confirmRemove: boolean; outcome: PhotoOutcome; locked: boolean; canRetry: boolean;
  onPick?: ((file: Blob) => void) | undefined; onSave?: (() => void) | undefined; onCancel?: (() => void) | undefined;
  onAskRemove?: (() => void) | undefined; onRemove?: (() => void) | undefined; onKeep?: (() => void) | undefined;
  onReload?: (() => void) | undefined; onTryAgain?: (() => void) | undefined; onStop?: (() => void) | undefined;
}>;
const OUTCOME: Record<Exclude<NonNullable<PhotoOutcome>['kind'], 'SAVED' | 'REMOVED'>, Key> = { SENDING: 'sending', UNREADABLE: 'unreadable', DENIED: 'outDenied',
  MISSING: 'outMissing', CONFLICT: 'outConflict', INVALID: 'outInvalid', BUSY: 'outBusy', UNKNOWN: 'outUnknown' };

/** Pure view. The image comes from the photo read (or the unsaved draft); nothing is fetched by the view itself. */
export function PhotoCard(p: PhotoCardProps): React.ReactElement {
  const t = (key: Key, vars?: Record<string, string>) => photoText(p.language, key, vars);
  const base = useId();
  const photo = p.read.state === 'READY' ? p.read.photo : null;
  const src = p.draft ? `data:image/jpeg;base64,${p.draft}` : photo ? `data:${photo.mediaType};base64,${photo.data}` : null;
  const ready = p.read.state === 'READY';
  const o = p.outcome;
  return <article className={styles.card} aria-labelledby={`${base}-title`} data-testid="person-photo">
    <h2 id={`${base}-title`}>{t('title')}</h2>
    <p className={styles.meta}>{t('intro')}</p>
    {p.read.state === 'LOADING' ? <p className={styles.meta} role="status">{t('loading')}</p> : null}
    {p.read.state === 'DENIED' ? <p className={styles.meta} role="status">{t('denied')}</p> : null}
    {p.read.state === 'MISSING' ? <p className={styles.meta} role="status">{t('missing')}</p> : null}
    {p.read.state === 'UNAVAILABLE' ? <div className={styles.meta} role="status"><p>{t('unavailable')}</p>
      {p.onReload ? <button type="button" className={styles.secondary} onClick={p.onReload}>{t('reload')}</button> : null}</div> : null}
    {ready ? <div className={styles.photoRow}>
      <div className={styles.photoFrame} data-testid="photo-frame">{src ? <img src={src} alt={t('alt', { name: p.name })}/> : <span aria-hidden="true">{p.initials}</span>}</div>
      <div className={styles.form}>
        {p.draft ? <p className={styles.meta}>{t('preview')}</p> : photo ? null : <p className={styles.meta}>{t('none')}</p>}
        {p.canEdit ? <>
          <p className={styles.meta}>{t('consent')}</p>
          {p.draft ? <div className={styles.actions}>
            <button type="button" className={styles.primary} disabled={p.locked} onClick={p.onSave} data-testid="photo-save">{t('save')}</button>
            <button type="button" className={styles.secondary} disabled={p.locked} onClick={p.onCancel}>{t('cancel')}</button>
          </div> : p.confirmRemove ? <div className={styles.form} data-testid="photo-remove-confirm">
            <p>{t('removeAsk', { name: p.name })}</p>
            <div className={styles.actions}>
              <button type="button" className={styles.primary} disabled={p.locked} onClick={p.onRemove}>{t('removeConfirm')}</button>
              <button type="button" className={styles.secondary} disabled={p.locked} onClick={p.onKeep}>{t('back')}</button>
            </div>
          </div> : <div className={styles.actions}>
            <label className={`${styles.secondary} ${styles.fileLabel}`} aria-disabled={p.locked}>
              {t(photo ? 'replace' : 'take')}
              <input type="file" accept="image/jpeg,image/png,image/webp" capture="user" disabled={p.locked} data-testid="photo-file"
                onChange={e => { const f = e.currentTarget.files?.[0]; e.currentTarget.value = ''; if (f) p.onPick?.(f); }}/>
            </label>
            {photo ? <button type="button" className={styles.secondary} disabled={p.locked} onClick={p.onAskRemove}>{t('remove')}</button> : null}
          </div>}
        </> : photo ? <p className={styles.meta}>{t('readOnly')}</p> : null}
      </div>
    </div> : null}
    {o ? <div className={styles.outcome} role="status" data-testid="photo-outcome" data-kind={o.kind}
      data-tone={o.kind === 'SAVED' || o.kind === 'REMOVED' ? 'ok' : o.kind === 'SENDING' || o.kind === 'UNKNOWN' || o.kind === 'BUSY' ? 'waiting' : 'blocked'}>
      <p>{o.kind === 'SAVED' || o.kind === 'REMOVED' ? `${t(o.kind === 'SAVED' ? 'saved' : 'removed')}${o.replayed ? ` ${t('replayed')}` : ''}` : t(OUTCOME[o.kind])}</p>
      {p.canRetry ? <div className={styles.actions}>
        {p.onTryAgain ? <button type="button" className={styles.primary} onClick={p.onTryAgain}>{t('tryAgain')}</button> : null}
        {p.onStop ? <button type="button" className={styles.secondary} onClick={p.onStop}>{t('stop')}</button> : null}
      </div> : null}
    </div> : null}
  </article>;
}

type Pending = Readonly<{ key: string; op: 'set'; expectedVersion: number | null; data: string } | { key: string; op: 'remove'; expectedVersion: number }>;
type Lock = 'NONE' | 'SENDING' | 'KEPT';
export const initialsOf = (given: string, family: string) => `${[...given.trim()][0] ?? ''}${[...family.trim()][0] ?? ''}`.toUpperCase();

/**
 * The contact photo of one person at the verified school. Mounted per person inside the People page, so changing school
 * or person unmounts it and drops any kept request. Every answer is followed by a fresh read; an unknown outcome keeps
 * the exact request (same key, same bytes) so Try again can never save a different photo.
 */
export function PersonPhoto({ language, schoolId, record, canEdit, api = photoApi, shrink = shrinkPhoto }: {
  language: string; schoolId: string; record: PersonRecord; canEdit: boolean; api?: PhotoApi; shrink?: (file: Blob) => Promise<string | null>;
}): React.ReactElement {
  const [read, setRead] = useState<PhotoRead>({ state: 'LOADING' });
  const [refresh, setRefresh] = useState(0);
  const [draft, setDraft] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [outcome, setOutcome] = useState<PhotoOutcome>(null);
  const [lock, setLock] = useState<Lock>('NONE');
  const generation = useRef(0), mounted = useRef(false), pending = useRef<Pending | null>(null), sending = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; pending.current = null; }; }, []);
  const personId = record.personId;

  useEffect(() => {
    const current = ++generation.current;
    const owned = () => mounted.current && current === generation.current;
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    setRead({ state: 'LOADING' });
    api.read({ schoolId }, personId, signal, owned).then(r => { if (owned()) setRead({ state: 'READY', photo: r.photo }); }, error => {
      if (!owned() || abort.signal.aborted) return;
      const kind = error instanceof PhotoError ? error.kind : 'UNKNOWN';
      setRead({ state: kind === 'DENIED' ? 'DENIED' : kind === 'MISSING' ? 'MISSING' : 'UNAVAILABLE' });
    });
    return () => { abort.abort(); };
  }, [api, schoolId, personId, refresh]);

  const send = useCallback(async () => {
    const request = pending.current;
    if (!request || sending.current) return;
    sending.current = true; setLock('SENDING'); setOutcome({ kind: 'SENDING' });
    let next: NonNullable<PhotoOutcome>, keep = false;
    try {
      const owned = () => mounted.current && pending.current?.key === request.key, signal = AbortSignal.timeout(30000);
      if (request.op === 'set') next = { kind: 'SAVED', replayed: (await api.set({ schoolId }, personId, request.expectedVersion, 'image/jpeg', request.data, request.key, signal, owned)).replayed };
      else next = { kind: 'REMOVED', replayed: (await api.remove({ schoolId }, personId, request.expectedVersion, request.key, signal, owned)).replayed };
    } catch (error) {
      keep = keepPhotoForRetry(error);
      next = { kind: error instanceof PhotoError && error.kind !== 'SESSION' ? error.kind : 'UNKNOWN' };
    } finally { sending.current = false; }
    if (!mounted.current) return;
    if (pending.current?.key === request.key) pending.current = keep ? request : null;
    setLock(pending.current ? 'KEPT' : 'NONE'); setOutcome(next);
    if (!keep) { setDraft(null); setConfirmRemove(false); }
    setRefresh(n => n + 1);
  }, [api, schoolId, personId]);

  const current = read.state === 'READY' ? read.photo : null;
  const onPick = useCallback((file: Blob) => {
    if (lock !== 'NONE') return;
    setOutcome(null);
    void shrink(file).then(data => { if (!mounted.current) return; if (data) setDraft(data); else setOutcome({ kind: 'UNREADABLE' }); });
  }, [lock, shrink]);
  const onSave = useCallback(() => {
    if (lock !== 'NONE' || pending.current || !draft || read.state !== 'READY') return;
    pending.current = { key: globalThis.crypto.randomUUID(), op: 'set', expectedVersion: current?.version ?? null, data: draft };
    void send();
  }, [lock, draft, read.state, current, send]);
  const onRemove = useCallback(() => {
    if (lock !== 'NONE' || pending.current || !current) return;
    pending.current = { key: globalThis.crypto.randomUUID(), op: 'remove', expectedVersion: current.version };
    void send();
  }, [lock, current, send]);

  return <PhotoCard language={language} name={`${record.givenName} ${record.familyName}`} initials={initialsOf(record.givenName, record.familyName)} canEdit={canEdit}
    read={read} draft={draft} confirmRemove={confirmRemove} outcome={outcome} locked={lock !== 'NONE'} canRetry={lock === 'KEPT'}
    onPick={onPick} onSave={onSave} onCancel={() => { if (lock === 'NONE') setDraft(null); }}
    onAskRemove={() => { if (lock === 'NONE') { setConfirmRemove(true); setOutcome(null); } }} onRemove={onRemove} onKeep={() => { if (lock === 'NONE') setConfirmRemove(false); }}
    onReload={() => setRefresh(n => n + 1)} onTryAgain={() => { void send(); }}
    onStop={() => { if (lock !== 'KEPT' || sending.current) return; pending.current = null; setLock('NONE'); setDraft(null); setConfirmRemove(false); setOutcome(null); setRefresh(n => n + 1); }}/>;
}
