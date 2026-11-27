import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { CreativeAssetDeletion, CreativeAssetReview, CreativeAssetView, CreativeGeneration, CreativeGenerationAsset, CreativeReviewDecision, CreativeReviewQueue,
  CreativeReviewQueueItem } from '@hon/contracts';
import { studioText, type StudioKey } from './copy';
import { CreativeMediaError, deleteCreativeAsset, listCreativeReviewQueue, reviewCreativeAsset, viewCreativeAsset } from './media-http';
import styles from './creative-studio.module.css';

/** C3/C4 media actions for the school the shell verified. Optional so older test doubles keep working. */
export type CreativeMediaApi = {
  view(schoolId: string, assetId: string, signal: AbortSignal): Promise<CreativeAssetView>;
  remove(schoolId: string, assetId: string, signal: AbortSignal): Promise<CreativeAssetDeletion>;
  review(schoolId: string, assetId: string, decision: CreativeReviewDecision, signal: AbortSignal): Promise<CreativeAssetReview>;
  queue(schoolId: string, signal: AbortSignal): Promise<CreativeReviewQueue>;
};
export const CREATIVE_MEDIA_API: CreativeMediaApi = {
  view: viewCreativeAsset, remove: deleteCreativeAsset, review: reviewCreativeAsset, queue: listCreativeReviewQueue,
};

type T = (key: StudioKey, vars?: Record<string, string>) => string;
type Media = Readonly<{ assetId: string; mediaType: string; width: number; height: number; durationSeconds: number | null }>;
/** The review queue is shown only to reviewers: a 403 means "not a reviewer" and hides the card. */
export type QueueState = Readonly<{ state: 'LOADING' }> | Readonly<{ state: 'HIDDEN' }> | Readonly<{ state: 'UNAVAILABLE' }> | Readonly<{ state: 'READY'; items: readonly CreativeReviewQueueItem[] }>;
export type Note = Readonly<{ assetId: string; tone: 'ok' | 'waiting' | 'blocked'; key: StudioKey }>;
export type Preview = Readonly<{ assetId: string; url: string; mediaType: string }>;

const errorKey = (error: unknown): StudioKey => {
  const kind = error instanceof CreativeMediaError ? error.kind : 'UNKNOWN';
  return kind === 'STORAGE_OFF' ? 'mediaStorageOff' : kind === 'GONE' ? 'mediaGone' : kind === 'DENIED' ? 'mediaDenied' : 'mediaFailed';
};
/** Stored provider files of finished generations (synthetic results have no file). */
export function storedAssets(items: readonly CreativeGeneration[]): readonly Readonly<{ generation: CreativeGeneration; asset: CreativeGenerationAsset }>[] {
  return items.filter(g => g.status === 'SUCCEEDED').flatMap(g => g.assets.filter(a => a.origin === 'PROVIDER').map(asset => ({ generation: g, asset })));
}

/**
 * "Your images and videos" and, for reviewers, "Waiting for your approval". A view link lives only in this component's
 * memory and is dropped when the page is concealed (the shell remounts it). Delete and Reject ask once more on the page.
 */
export function CreativeMedia({ language, schoolId, generations, api = CREATIVE_MEDIA_API, onChanged }: Readonly<{
  language: string; schoolId: string; generations: readonly CreativeGeneration[]; api?: CreativeMediaApi; onChanged?: () => void;
}>): React.ReactElement | null {
  const [queue, setQueue] = useState<QueueState>({ state: 'LOADING' });
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [note, setNote] = useState<Note | null>(null);
  const [reload, setReload] = useState(0);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  useEffect(() => {
    setPreview(null); setConfirm(null); setNote(null);
  }, [schoolId]);
  useEffect(() => {
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    api.queue(schoolId, signal).then(
      q => { if (!signal.aborted) setQueue({ state: 'READY', items: q.assets }); },
      error => { if (!signal.aborted) setQueue({ state: error instanceof CreativeMediaError && error.kind === 'DENIED' ? 'HIDDEN' : 'UNAVAILABLE' }); });
    return () => { abort.abort(); };
  }, [api, schoolId, reload]);

  const run = useCallback(async (assetId: string, work: (signal: AbortSignal) => Promise<Note | null>) => {
    if (busy) return;
    setBusy(assetId); setNote(null); setConfirm(null);
    let next: Note | null;
    try { next = await work(AbortSignal.timeout(30000)); } catch (error) { next = { assetId, tone: 'blocked', key: errorKey(error) }; }
    if (!alive.current) return;
    setBusy(null); setNote(next);
  }, [busy]);

  const onView = (assetId: string) => {
    if (preview?.assetId === assetId) { setPreview(null); return; }
    void run(assetId, async signal => { const v = await api.view(schoolId, assetId, signal); if (alive.current) setPreview({ assetId, url: v.url, mediaType: v.mediaType }); return null; });
  };
  const onDelete = (assetId: string) => void run(assetId, async signal => {
    const done = await api.remove(schoolId, assetId, signal);
    if (alive.current) { if (preview?.assetId === assetId) setPreview(null); setReload(v => v + 1); onChanged?.(); }
    return { assetId, tone: done.fileRemoved ? 'ok' : 'waiting', key: done.fileRemoved ? 'mediaDeleted' : 'mediaDeletePending' };
  });
  const onReview = (assetId: string, decision: CreativeReviewDecision) => void run(assetId, async signal => {
    await api.review(schoolId, assetId, decision, signal);
    if (alive.current) { setReload(v => v + 1); onChanged?.(); }
    return { assetId, tone: decision === 'APPROVED' ? 'ok' : 'blocked', key: decision === 'APPROVED' ? 'queueApproved' : 'queueRejected' };
  });

  return <CreativeMediaView language={language} generations={generations} queue={queue} preview={preview} busy={busy} confirm={confirm} note={note}
    onView={onView} onDelete={onDelete} onReview={onReview} onConfirm={setConfirm}/>;
}

export type Confirm = Readonly<{ assetId: string; action: 'DELETE' | 'REJECT' }>;
export type CreativeMediaViewProps = Readonly<{
  language: string; generations: readonly CreativeGeneration[]; queue: QueueState; preview: Preview | null; busy: string | null; confirm: Confirm | null; note: Note | null;
  onView: (assetId: string) => void; onDelete: (assetId: string) => void; onReview: (assetId: string, decision: CreativeReviewDecision) => void;
  onConfirm: (confirm: Confirm | null) => void;
}>;
/** Pure view of the media cards. */
export function CreativeMediaView({ language, generations, queue, preview, busy, confirm, note, onView, onDelete, onReview, onConfirm }: CreativeMediaViewProps): React.ReactElement {
  const t: T = (key, vars) => studioText(language, key, vars);
  const setConfirm = onConfirm;
  const stored = storedAssets(generations);
  const mediaLine = (m: Media) => {
    const kind = t(m.mediaType.startsWith('video/') ? 'VIDEO' : 'IMAGE');
    return `${kind} ${m.width}×${m.height}${m.durationSeconds ? t('seconds', { n: String(m.durationSeconds) }) : ''}`;
  };
  const shownNote = (assetId: string) => note && note.assetId === assetId
    ? <p className={styles.meta} role="status" data-tone={note.tone} data-testid="creative-media-note">{t(note.key)}</p> : null;
  const shownPreview = (m: Media) => preview && preview.assetId === m.assetId ? <div className={styles.preview}>
    {preview.mediaType.startsWith('video/')
      ? <video src={preview.url} controls playsInline preload="metadata" aria-label={t('mediaPreviewAlt', { kind: t('VIDEO'), w: String(m.width), h: String(m.height) })}/>
      : <img src={preview.url} alt={t('mediaPreviewAlt', { kind: t('IMAGE'), w: String(m.width), h: String(m.height) })} referrerPolicy="no-referrer"/>}
    <small className={styles.meta}>{t('mediaLinkNote')}</small>
  </div> : null;
  const viewButton = (m: Media) => <button type="button" className={styles.secondary} onClick={() => onView(m.assetId)} disabled={busy !== null}
    aria-expanded={preview?.assetId === m.assetId}>{preview?.assetId === m.assetId ? t('mediaHide') : t('mediaView')}</button>;
  const confirming = (assetId: string, action: 'DELETE' | 'REJECT') => confirm?.assetId === assetId && confirm.action === action;

  return <>
    {queue.state === 'READY' || queue.state === 'UNAVAILABLE' ? <article className={styles.card} aria-labelledby="creative-queue-title" data-testid="creative-review-queue">
      <h2 id="creative-queue-title">{t('queueTitle')}</h2>
      <p className={styles.meta}>{t('queueIntro')}</p>
      {queue.state === 'UNAVAILABLE' ? <p className={styles.meta}>{t('queueUnavailable')}</p>
        : queue.items.length ? <ul className={styles.list}>{queue.items.map(item => <li key={item.assetId} data-testid="creative-queue-item">
          <span className={styles.rowMain}><strong>{mediaLine(item)}</strong>
            <span className={styles.status} data-tone="waiting">{t('reviewPENDING_REVIEW')}</span>
            {item.requestedBySelf ? <small>{t('queueMine')}</small> : null}</span>
          <span className={styles.actions}>
            {viewButton(item)}
            <button type="button" className={styles.primary} onClick={() => onReview(item.assetId, 'APPROVED')} disabled={busy !== null}>{busy === item.assetId ? t('mediaWorking') : t('queueApprove')}</button>
            {confirming(item.assetId, 'REJECT')
              ? <><button type="button" className={styles.danger} onClick={() => onReview(item.assetId, 'REJECTED')} disabled={busy !== null}>{t('queueRejectConfirm')}</button>
                <button type="button" className={styles.secondary} onClick={() => setConfirm(null)}>{t('mediaCancel')}</button></>
              : <button type="button" className={styles.secondary} onClick={() => setConfirm({ assetId: item.assetId, action: 'REJECT' })} disabled={busy !== null}>{t('queueReject')}</button>}
          </span>
          {shownPreview(item)}{shownNote(item.assetId)}
        </li>)}</ul> : <p className={styles.meta}>{t('queueNone')}</p>}
      {queue.state === 'READY' && note && !queue.items.some(i => i.assetId === note.assetId) && !stored.some(s => s.asset.assetId === note.assetId)
        ? <p className={styles.meta} role="status" data-testid="creative-media-note">{t(note.key)}</p> : null}
    </article> : null}
    <article className={styles.card} aria-labelledby="creative-media-title" data-testid="creative-media">
      <h2 id="creative-media-title">{t('mediaTitle')}</h2>
      <p className={styles.meta}>{t('mediaIntro')}</p>
      {stored.length ? <ul className={styles.list}>{stored.map(({ asset }) => <li key={asset.assetId} data-testid="creative-media-item">
        <span className={styles.rowMain}><strong>{mediaLine(asset)}</strong>
          <span className={styles.status} data-tone={asset.review === 'APPROVED' ? 'ready' : asset.review === 'REJECTED' ? 'blocked' : 'waiting'}>{t(`review${asset.review}`)}</span></span>
        <span className={styles.actions}>
          {viewButton(asset)}
          {confirming(asset.assetId, 'DELETE')
            ? <><button type="button" className={styles.danger} onClick={() => onDelete(asset.assetId)} disabled={busy !== null}>{busy === asset.assetId ? t('mediaWorking') : t('mediaDeleteConfirm')}</button>
              <button type="button" className={styles.secondary} onClick={() => setConfirm(null)}>{t('mediaCancel')}</button></>
            : <button type="button" className={styles.secondary} onClick={() => setConfirm({ assetId: asset.assetId, action: 'DELETE' })} disabled={busy !== null}>{t('mediaDelete')}</button>}
        </span>
        {asset.review === 'PENDING_REVIEW' ? <small>{t('mediaPrivate')}</small> : null}
        {shownPreview(asset)}{shownNote(asset.assetId)}
      </li>)}</ul> : <p className={styles.meta}>{t('mediaNone')}</p>}
      {note && !stored.some(s => s.asset.assetId === note.assetId) && !(queue.state === 'READY') ? <p className={styles.meta} role="status" data-testid="creative-media-note">{t(note.key)}</p> : null}
    </article>
  </>;
}
