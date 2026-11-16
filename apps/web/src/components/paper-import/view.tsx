import React from 'react';
import { PAPER_IMPORT_KINDS, PAPER_IMPORT_MAX_PAGES, type PaperImportDetail, type PaperImportKind, type PaperImportList, type PaperImportSummary } from '@hon/contracts';
import { paperCopy, type PaperCopyKey } from './copy';
import type { PaperErrorKind } from './http';
import shared from '../student-import/student-import.module.css';
import styles from './paper-import.module.css';

type T = (key: PaperCopyKey, values?: Record<string, string | number>) => string;
export type PaperAction = 'create' | 'page' | 'read' | 'save' | 'send' | 'remove';
export type PaperListState = { state: 'LOADING' | 'DENIED' | 'UNAVAILABLE' } | { state: 'READY'; list: PaperImportList };
export type PaperDetailState = { state: 'IDLE' | 'LOADING' | 'DENIED' | 'GONE' | 'UNAVAILABLE' } | { state: 'READY'; detail: PaperImportDetail };
/** The table as staff edit it, for one set at one version. `dirty` means the server does not have these edits yet. */
export type PaperDraft = Readonly<{ setId: string; version: number; rows: readonly (readonly string[])[]; unsure: readonly (readonly boolean[])[]; dirty: boolean }>;
export type PageImage = { state: 'LOADING' | 'UNAVAILABLE' } | { state: 'READY'; src: string };
export type PaperOutcome = null | Readonly<{ kind: 'SENDING' | 'DONE' | PaperErrorKind | 'TOO_BIG' | 'FULL'; action: PaperAction }>;

export type PaperImportViewProps = Readonly<{
  language: string; waiting: boolean; concealed: boolean; hasSchool: boolean;
  list: PaperListState; selected: string | null; detail: PaperDetailState; draft: PaperDraft | null;
  images: Readonly<Record<number, PageImage>>; viewing: number; startKind: PaperImportKind; confirmDelete: boolean;
  outcome: PaperOutcome; locked: boolean; canRetry: boolean;
  onRefresh?: (() => void) | undefined; onOpen?: ((setId: string | null) => void) | undefined;
  onStartKind?: ((kind: PaperImportKind) => void) | undefined; onStart?: (() => void) | undefined;
  onFiles?: ((files: readonly File[]) => void) | undefined; onSample?: (() => void) | undefined; onView?: ((pageNo: number) => void) | undefined;
  onRead?: (() => void) | undefined; onCell?: ((row: number, column: number, value: string) => void) | undefined;
  onAddRow?: (() => void) | undefined; onRemoveRow?: ((row: number) => void) | undefined; onSave?: (() => void) | undefined;
  onSend?: (() => void) | undefined; onDelete?: ((confirmed: boolean | null) => void) | undefined; onTryAgain?: (() => void) | undefined;
}>;

const when = (language: string, value: string) => new Date(value).toLocaleDateString(language, { dateStyle: 'medium' });
/** The set shown on the page, only when the read answers for the selected id. */
export function shownDetail(p: Pick<PaperImportViewProps, 'detail' | 'selected'>): PaperImportDetail | null {
  return p.detail.state === 'READY' && p.detail.detail.set.id.toLowerCase() === p.selected?.toLowerCase() ? p.detail.detail : null;
}
/** Rows with at least one filled cell: what Send to review sends (the server drops blank rows the same way). */
export const filledRows = (rows: readonly (readonly string[])[]) => rows.filter((r) => r.some((c) => c.trim() !== '')).length;

function Recent({ p, t }: { p: PaperImportViewProps; t: T }) {
  const sets = p.list.state === 'READY' ? p.list.list.sets : [];
  return <article className={shared.card} aria-labelledby="paper-import-recent-title" data-testid="paper-import-recent">
    <h2 id="paper-import-recent-title">{t('recentTitle')}</h2>
    {p.list.state === 'LOADING' ? <p className={shared.meta} role="status">{t('recentLoading')}</p>
      : p.list.state === 'DENIED' ? <p className={shared.meta} role="status">{t('recentDenied')}</p>
      : p.list.state === 'UNAVAILABLE' ? <p className={shared.meta} role="status">{t('recentUnavailable')}</p>
      : sets.length === 0 ? <p className={shared.meta}>{t('recentNone')}</p>
      : <ul className={shared.list}>{sets.map((s) => <li key={s.id} data-testid="paper-import-set">
        <span>{t('recentRow', { kind: t(`k_${s.kind}`), date: when(p.language, s.createdAt), pages: s.pageCount })}</span>
        <div className={shared.row}><span className={shared.chip} data-state={s.status === 'SENT' ? 'FINALIZED' : s.status === 'DELETED' ? 'CANCELLED' : 'STAGED'}>{t(`st_${s.status}`)}</span>
          <button type="button" className={shared.secondary} disabled={p.locked || p.selected?.toLowerCase() === s.id.toLowerCase()} onClick={() => p.onOpen?.(s.id)}>{t('open')}</button></div>
      </li>)}</ul>}
  </article>;
}

function Start({ p, t }: { p: PaperImportViewProps; t: T }) {
  return <article className={shared.card} aria-labelledby="paper-import-start-title" data-testid="paper-import-start">
    <h2 id="paper-import-start-title">{t('startTitle')}</h2>
    <div className={shared.tabs} role="group" aria-labelledby="paper-import-start-title">{PAPER_IMPORT_KINDS.map((k) =>
      <button key={k} type="button" className={shared.tab} aria-pressed={p.startKind === k} disabled={p.locked} onClick={() => p.onStartKind?.(k)}>{t(`k_${k}`)}</button>)}</div>
    <p className={shared.meta}>{t(`kh_${p.startKind}`)}</p>
    <div className={shared.row}><button type="button" className={shared.primary} disabled={p.locked} onClick={p.onStart} data-testid="paper-import-create">{t('start')}</button></div>
  </article>;
}

function Photos({ p, set, detail, t }: { p: PaperImportViewProps; set: PaperImportSummary; detail: PaperImportDetail; t: T }) {
  const image = p.images[p.viewing];
  const open = set.status === 'OPEN', full = detail.pages.length >= PAPER_IMPORT_MAX_PAGES;
  return <div className={styles.photos} data-testid="paper-import-photos">
    <h3>{t('photosTitle')}</h3>
    <p className={shared.meta}>{t('photoCount', { n: detail.pages.length })}</p>
    {detail.pages.length ? <>
      <div className={shared.row} role="group" aria-label={t('photosTitle')}>{detail.pages.map((pg) =>
        <button key={pg.pageNo} type="button" className={shared.tab} aria-pressed={p.viewing === pg.pageNo} onClick={() => p.onView?.(pg.pageNo)}>{t('page', { n: pg.pageNo })}</button>)}</div>
      <figure className={styles.viewer}>
        {image?.state === 'READY' ? <img src={image.src} alt={t('page', { n: p.viewing })} className={styles.image} data-testid="paper-import-image"/>
          : <p className={shared.meta} role="status">{t(image?.state === 'UNAVAILABLE' ? 'pageUnavailable' : 'pageLoading')}</p>}
      </figure>
    </> : null}
    {open ? <>
      <label className={shared.field}>{t('addPhotos')}
        <input type="file" accept="image/jpeg,image/png,image/webp,image/*" capture="environment" multiple disabled={p.locked || full} data-testid="paper-import-file"
          onChange={(e) => { p.onFiles?.(Array.from(e.currentTarget.files ?? [])); e.currentTarget.value = ''; }}/></label>
      <p className={shared.meta}>{t('photoHelp')}</p>
      <div className={shared.row}><button type="button" className={shared.secondary} disabled={p.locked || full} onClick={p.onSample} data-testid="paper-import-sample">{t('trySample')}</button></div>
    </> : null}
  </div>;
}

function Table({ p, set, draft, columns, t }: { p: PaperImportViewProps; set: PaperImportSummary; draft: PaperDraft; columns: readonly string[]; t: T }) {
  const outcome = set.readOutcome;
  return <div className={styles.tablePane} data-testid="paper-import-table">
    <h3>{t('tableTitle')}</h3>
    {outcome ? <p className={`${shared.notice} ${outcome === 'NOT_READABLE' ? shared.warn : ''}`} data-testid="paper-import-read-outcome">{t(`outcome_${outcome}`)}</p> : null}
    <div className={shared.tableWrap}><table className={shared.table}>
      <thead><tr><th scope="col">#</th>{columns.map((c) => <th key={c} scope="col">{t(`fld_${c}` as PaperCopyKey)}</th>)}<th scope="col"><span className={styles.hidden}>{t('removeRow', { n: '' })}</span></th></tr></thead>
      <tbody>{draft.rows.map((row, r) => <tr key={r} data-testid="paper-import-row">
        <td>{r + 1}</td>
        {columns.map((c, col) => {
          const unsure = draft.unsure[r]?.[col] === true;
          return <td key={c} data-unsure={unsure} className={unsure ? styles.unsure : undefined}>
            <input className={styles.cell} value={row[col] ?? ''} maxLength={200} disabled={p.locked} aria-label={`${t(`fld_${c}` as PaperCopyKey)} ${r + 1}`}
              onChange={(e) => p.onCell?.(r, col, e.currentTarget.value)}/>
            {unsure ? <span className={styles.unsureTag}>{t('unsure')}</span> : null}
          </td>;
        })}
        <td><button type="button" className={shared.secondary} disabled={p.locked} onClick={() => p.onRemoveRow?.(r)} aria-label={t('removeRow', { n: r + 1 })}>×</button></td>
      </tr>)}</tbody>
    </table></div>
    <div className={shared.row}>
      <button type="button" className={shared.secondary} disabled={p.locked || draft.rows.length >= 200} onClick={p.onAddRow}>{t('addRow')}</button>
      <button type="button" className={shared.primary} disabled={p.locked || !draft.dirty} onClick={p.onSave} data-testid="paper-import-save">{t('save')}</button>
    </div>
    {draft.dirty ? <p className={`${shared.meta} ${shared.warnText}`} role="status">{t('unsaved')}</p> : null}
  </div>;
}

function SetCard({ p, t }: { p: PaperImportViewProps; t: T }) {
  const detail = shownDetail(p), set = detail?.set;
  const draft = detail && p.draft && p.draft.setId.toLowerCase() === detail.set.id.toLowerCase() ? p.draft : null;
  return <article className={shared.card} aria-labelledby="paper-import-set-title" data-testid="paper-import-detail">
    <div className={shared.cardHead}><h2 id="paper-import-set-title">{set ? t(`k_${set.kind}`) : t('title')}</h2>
      <button type="button" className={shared.secondary} disabled={p.locked} onClick={() => p.onOpen?.(null)}>{t('back')}</button></div>
    {p.detail.state === 'DENIED' ? <p className={shared.meta} role="status">{t('e_DENIED')}</p>
      : p.detail.state === 'GONE' ? <p className={shared.meta} role="status">{t('e_GONE')}</p>
      : p.detail.state === 'UNAVAILABLE' ? <p className={shared.meta} role="status">{t('recentUnavailable')}</p>
      : !detail || !set ? <p className={shared.meta} role="status">{t('recentLoading')}</p>
      : set.status === 'DELETED' ? <p data-testid="paper-import-deleted">{t(set.deleteReason === 'EXPIRED' ? 'deleted_EXPIRED' : 'deleted_STAFF', { date: when(p.language, set.deletedAt ?? set.expiresAt) })}</p>
      : <>
        <p><span className={shared.chip} data-state={set.status === 'SENT' ? 'FINALIZED' : 'STAGED'}>{t(`st_${set.status}`)}</span> <span className={shared.meta}>{t('expires', { date: when(p.language, set.expiresAt) })}</span></p>
        {set.status === 'SENT' ? <div className={shared.form} data-testid="paper-import-sent">
          <p>{t(set.target === 'ATTENDANCE' ? 'sentAttendance' : 'sentStudents', { n: filledRows(detail.rows) })}</p>
          <div className={shared.row}><a className={shared.primary} href={set.target === 'ATTENDANCE' ? '/staff/migration/classes' : '/staff/migration/students'}>{t(set.target === 'ATTENDANCE' ? 'openAttendance' : 'openStudents')}</a></div>
        </div> : null}
        <div className={styles.split}>
          <Photos p={p} set={set} detail={detail} t={t}/>
          {set.status === 'READ' && draft ? <Table p={p} set={set} draft={draft} columns={detail.columns} t={t}/> : null}
        </div>
        {set.status === 'OPEN' ? <div className={shared.form} data-testid="paper-import-read">
          <h3>{t('readTitle')}</h3><p className={shared.meta}>{t('readHelp')}</p>
          <div className={shared.row}><button type="button" className={shared.primary} disabled={p.locked || detail.pages.length === 0} onClick={p.onRead}>{p.outcome?.kind === 'SENDING' && p.outcome.action === 'read' ? t('reading') : t('read')}</button></div>
        </div> : null}
        {set.status === 'READ' && draft ? <div className={shared.form} data-testid="paper-import-send">
          <h3>{t('sendTitle')}</h3><p className={shared.meta}>{t('sendHelp')}</p>
          <div className={shared.row}><button type="button" className={shared.primary} disabled={p.locked || draft.dirty || filledRows(draft.rows) === 0} onClick={p.onSend}>{t('send')}</button></div>
        </div> : null}
        <div className={`${shared.form} ${shared.danger}`} data-testid="paper-import-delete">
          {p.confirmDelete ? <><p>{t('deleteConfirm')}</p><div className={shared.row}>
            <button type="button" className={shared.primary} disabled={p.locked} onClick={() => p.onDelete?.(true)}>{t('deleteYes')}</button>
            <button type="button" className={shared.secondary} disabled={p.locked} onClick={() => p.onDelete?.(false)}>{t('deleteNo')}</button></div></>
            : <div className={shared.row}><button type="button" className={shared.secondary} disabled={p.locked} onClick={() => p.onDelete?.(null)}>{t('delete')}</button></div>}
        </div>
      </>}
  </article>;
}

/** Pure view. Sets, photos and the table come only from the school's reads; nothing shows before the shell verifies the school. */
export function PaperImportView(p: PaperImportViewProps): React.ReactElement {
  const t = paperCopy(p.language);
  const notice = p.waiting ? t('waiting') : p.concealed ? t('concealed') : !p.hasSchool ? t('noSchool') : null;
  return <section className={shared.page} aria-labelledby="paper-import-title" data-hon-native="" data-testid="paper-import">
    <header className={shared.head}>
      <div><h1 id="paper-import-title">{t('title')}</h1><p className={shared.intro}>{t('intro')}</p></div>
      {notice === null && p.onRefresh ? <button type="button" className={shared.secondary} onClick={p.onRefresh} disabled={p.locked}>{t('refresh')}</button> : null}
    </header>
    <p className={shared.meta}>{t('scope')}</p>
    <p className={shared.meta}>{t('privacy')}</p>
    {notice ? <p className={shared.notice} role="status">{notice}</p> : <>
      <p className={`${shared.notice} ${shared.warn}`} data-testid="paper-import-stand-in">{t('standIn')}</p>
      {p.outcome && !(p.outcome.kind === 'DONE' && p.outcome.action !== 'save') ? <div className={shared.notice} role="status" data-testid="paper-import-outcome" data-kind={p.outcome.kind}>
        <p>{p.outcome.kind === 'SENDING' ? t(p.outcome.action === 'read' ? 'reading' : 'sending') : p.outcome.kind === 'DONE' ? t('saved') : t(`e_${p.outcome.kind}`)}</p>
        {p.canRetry && p.onTryAgain ? <button type="button" className={shared.primary} onClick={p.onTryAgain}>{t('tryAgain')}</button> : null}</div> : null}
      {p.selected ? <SetCard p={p} t={t}/> : <>
        {p.list.state === 'READY' ? <Start p={p} t={t}/> : null}
        <Recent p={p} t={t}/>
      </>}
    </>}
  </section>;
}
