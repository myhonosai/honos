import React, { useRef } from 'react';
import { formatSchoolMediaBytes, formatSchoolVideoDuration, schoolMediaTitleOk, SCHOOL_MEDIA_TYPES, SCHOOL_VIDEO_TYPES, type SchoolMediaAsset, type SchoolMediaLibrary } from '@hon/contracts';
import { mediaCopy, type MediaCopy, type MediaOutcomeKind } from './copy';
import page from '../membership-changes/membership-changes.module.css';
import styles from './school-media.module.css';

export type LibraryRead = { state: 'LOADING' | 'DENIED' | 'UNAVAILABLE' } | { state: 'READY'; library: SchoolMediaLibrary };
export type MediaOutcome = null | Readonly<{ kind: MediaOutcomeKind; percent?: number }>;
/** One picture being renamed (with the text typed so far) or asked about before delete. */
export type MediaEditing = null | Readonly<{ assetId: string; mode: 'RENAME'; title: string }> | Readonly<{ assetId: string; mode: 'DELETE' }>;
export type SchoolMediaViewProps = Readonly<{
  language: string; waiting: boolean; concealed: boolean; hasSchool: boolean;
  library: LibraryRead; editing: MediaEditing; outcome: MediaOutcome; locked: boolean; canRetry: boolean;
  onFiles?: ((files: readonly File[]) => void) | undefined; onCopy?: ((asset: SchoolMediaAsset) => void) | undefined;
  onRename?: ((asset: SchoolMediaAsset) => void) | undefined; onTitle?: ((title: string) => void) | undefined; onSaveTitle?: (() => void) | undefined;
  onDelete?: ((asset: SchoolMediaAsset) => void) | undefined; onConfirmDelete?: (() => void) | undefined; onBack?: (() => void) | undefined;
  onRefresh?: (() => void) | undefined; onTryAgain?: (() => void) | undefined;
}>;

const CALM: readonly MediaOutcomeKind[] = ['UPLOADING', 'WORKING', 'UPLOADED', 'VIDEO_UPLOADED', 'RENAMED', 'DELETED', 'DELETED_WAITING', 'COPIED'];

function Usage({ c, library }: { c: MediaCopy; library: SchoolMediaLibrary }): React.ReactElement {
  const u = library.usage;
  const bar = (used: number, limit: number, label: string, kind: string) => {
    const percent = Math.min(100, Math.round((used / limit) * 100));
    return <div className={styles.usage} data-usage={kind}>
      <span className={page.meta}>{label}</span>
      <div className={styles.bar} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><span style={{ width: `${percent}%` }}/></div>
    </div>;
  };
  return <section className={page.card} aria-labelledby="media-usage-title" data-testid="media-usage">
    <div className={page.cardHead}><h2 id="media-usage-title">{c.usageTitle}</h2></div>
    {bar(u.storedBytes, u.storedLimitBytes, c.stored(formatSchoolMediaBytes(u.storedBytes), formatSchoolMediaBytes(u.storedLimitBytes)), 'stored')}
    {bar(u.monthBytes, u.monthLimitBytes, c.month(formatSchoolMediaBytes(u.monthBytes), formatSchoolMediaBytes(u.monthLimitBytes)), 'month')}
  </section>;
}

function Picture({ p, c, asset }: { p: SchoolMediaViewProps; c: MediaCopy; asset: SchoolMediaAsset }): React.ReactElement {
  const editing = p.editing?.assetId === asset.assetId ? p.editing : null;
  const renaming = editing?.mode === 'RENAME' ? editing : null;
  const video = asset.kind === 'VIDEO';
  return <li className={styles.picture} data-asset={asset.assetId} data-state={asset.state} data-kind={asset.kind} data-copy={asset.copyState ?? undefined}>
    <div className={styles.thumb}>
      {asset.state === 'READY' && asset.linkToken
        ? <img src={video ? `/m/${asset.linkToken}/poster` : `/m/${asset.linkToken}`} alt={asset.title} loading="lazy" referrerPolicy="no-referrer" width={asset.width ?? undefined} height={asset.height ?? undefined}/>
        : <span className={page.meta}>{asset.state !== 'READY' ? c.unfinished : asset.copyState === 'FAILED' ? c.videoFailed : c.videoPreparing}</span>}
      {video ? <span className={styles.badge}>{c.videoBadge}</span> : null}
    </div>
    {renaming ? <div className={page.form}>
      <label className={page.field}>{c.titleLabel}
        <input value={renaming.title} maxLength={100} disabled={p.locked} onChange={(e) => p.onTitle?.(e.target.value)} data-field="title"/></label>
      {!schoolMediaTitleOk(renaming.title) ? <p className={page.meta} role="alert">{c.titleProblem}</p> : null}
      <div className={page.row}>
        <button type="button" className={page.primary} disabled={p.locked || !schoolMediaTitleOk(renaming.title) || renaming.title === asset.title} onClick={() => p.onSaveTitle?.()} data-action="save-title">{c.save}</button>
        <button type="button" className={page.secondary} disabled={p.locked} onClick={() => p.onBack?.()}>{c.cancel}</button>
      </div>
    </div> : <>
      <strong className={styles.title}>{asset.title}</strong>
      <span className={page.meta}>{asset.kind === 'IMAGE' ? c.size(formatSchoolMediaBytes(asset.byteSize), asset.width, asset.height)
        : asset.durationMs !== null && asset.width !== null && asset.height !== null
          ? c.videoLength(formatSchoolMediaBytes(asset.byteSize), formatSchoolVideoDuration(asset.durationMs), asset.width, asset.height)
          : formatSchoolMediaBytes(asset.byteSize)}</span>
    </>}
    {editing?.mode === 'DELETE' ? <div className={`${page.form} ${page.danger}`}>
      <p className={page.meta}>{c.confirmRemove(asset.title)}</p>
      <div className={page.row}>
        <button type="button" className={page.secondary} disabled={p.locked} onClick={() => p.onConfirmDelete?.()} data-action="confirm-delete">{c.confirm}</button>
        <button type="button" className={page.secondary} disabled={p.locked} onClick={() => p.onBack?.()}>{c.back}</button>
      </div>
    </div> : !renaming ? <div className={styles.actions}>
      {asset.state === 'READY' && asset.linkToken ? <button type="button" className={styles.small} disabled={p.locked} onClick={() => p.onCopy?.(asset)} data-action="copy">{c.copyLink}</button> : null}
      <button type="button" className={styles.small} disabled={p.locked} onClick={() => p.onRename?.(asset)} data-action="rename">{c.rename}</button>
      <button type="button" className={styles.small} disabled={p.locked} onClick={() => p.onDelete?.(asset)} data-action="delete">{c.remove}</button>
    </div> : null}
  </li>;
}

/** Marketing > Media. Pure view: every action is a callback; the container decides, the server decides again. */
export function SchoolMediaView(p: SchoolMediaViewProps): React.ReactElement {
  const c = mediaCopy(p.language);
  const input = useRef<HTMLInputElement>(null);
  const head = <div className={page.head}><div><h1>{c.pageTitle}</h1><p className={page.intro}>{c.intro}</p></div>
    <button type="button" className={page.secondary} onClick={() => p.onRefresh?.()} disabled={p.locked}>{c.refresh}</button></div>;
  if (p.waiting) return <main className={page.page}>{head}<p className={page.meta} role="status">{c.checking}</p></main>;
  if (p.concealed) return <main className={page.page}>{head}<p className={page.meta} role="status">{c.hidden}</p></main>;
  if (!p.hasSchool) return <main className={page.page}>{head}<p className={page.meta} role="status">{c.chooseSchool}</p></main>;
  const outcome = p.outcome ? <div className={`${page.notice} ${CALM.includes(p.outcome.kind) ? '' : page.warn}`} role={CALM.includes(p.outcome.kind) ? 'status' : 'alert'} data-testid="media-outcome" data-kind={p.outcome.kind}>
    <p>{p.outcome.kind === 'UPLOADING' && p.outcome.percent !== undefined ? c.uploadingVideo(p.outcome.percent) : c.outcomes[p.outcome.kind]}</p>
    {p.canRetry ? <button type="button" className={page.secondary} onClick={() => p.onTryAgain?.()} data-action="retry">{c.tryAgain}</button> : null}
  </div> : null;
  const read = p.library;
  if (read.state !== 'READY') return <main className={page.page}>{head}{read.state === 'LOADING' ? <p className={page.meta} role="status">{c.reading}</p>
    : <div className={`${page.notice} ${page.warn}`} role="alert" data-testid={read.state === 'DENIED' ? 'media-denied' : undefined}><p>{read.state === 'DENIED' ? c.denied : c.unavailable}</p></div>}</main>;
  return <main className={page.page}>{head}{outcome}
    <Usage c={c} library={read.library}/>
    <section className={page.card} aria-labelledby="media-library-title" data-testid="media-library">
      <div className={page.cardHead}><h2 id="media-library-title">{c.libraryTitle}</h2></div>
      <div className={page.row}>
        <input ref={input} type="file" accept={[...SCHOOL_MEDIA_TYPES, ...SCHOOL_VIDEO_TYPES, '.mov', '.mp4', '.m4v', '.webm'].join(',')} multiple hidden onChange={(e) => {
          const files = Array.from(e.target.files ?? []); e.target.value = ''; if (files.length) p.onFiles?.(files);
        }} data-field="files"/>
        <button type="button" className={page.primary} disabled={p.locked} onClick={() => input.current?.click()} data-action="upload">{c.upload}</button>
        <span className={page.meta}>{c.uploadHint}</span>
      </div>
      <p className={page.meta}>{c.privacyNote}</p>
      <p className={page.meta}>{c.videoPrivacy}</p>
      {read.library.assets.length === 0 ? <p className={page.meta}>{c.empty}</p>
        : <ul className={styles.grid}>{read.library.assets.map(asset => <Picture key={asset.assetId} p={p} c={c} asset={asset}/>)}</ul>}
      <p className={page.meta}>{c.permissionsHint}</p>
    </section>
  </main>;
}
