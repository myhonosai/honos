import React from 'react';
import {
  HISTORY_IMPORT_FIELDS, HISTORY_IMPORT_KINDS, HISTORY_IMPORT_REQUIRED,
  type HistoryImportDetail, type HistoryImportKind, type HistoryImportList, type HistoryImportMappingTarget, type HistoryImportRow,
} from '@hon/contracts';
import { HISTORY_IMPORT_LANGUAGES, historyImportText, type HistoryImportKey } from './copy';
import { mappingProblem, type ImportErrorKind } from './http';
import styles from '../student-import/student-import.module.css';

type T = (key: HistoryImportKey, vars?: Record<string, string>) => string;
export type Choice = 'IMPORT' | 'SKIP';
export type ImportAction = 'stage' | 'decide' | 'finalize';
export type ListState = { state: 'LOADING' | 'DENIED' | 'UNAVAILABLE' } | { state: 'READY'; list: HistoryImportList };
export type DetailState = { state: 'IDLE' | 'LOADING' | 'DENIED' | 'GONE' | 'UNAVAILABLE' } | { state: 'READY'; detail: HistoryImportDetail };
export type UploadState = { phase: 'NONE' } | { phase: 'FILE_ERROR'; problem: 'TOO_LARGE' | 'UNREADABLE' }
  | { phase: 'MAPPING'; fileName: string; csv: string; headers: readonly string[]; mapping: Readonly<Record<string, HistoryImportMappingTarget>> };
export type ImportOutcome = null | Readonly<{ kind: 'SENDING' | 'DONE' | ImportErrorKind; action: ImportAction }>;

export type HistoryImportViewProps = Readonly<{
  language: string; waiting: boolean; concealed: boolean; hasSchool: boolean; kind: HistoryImportKind;
  list: ListState; selected: string | null; detail: DetailState; upload: UploadState; choices: Readonly<Record<number, Choice>>;
  outcome: ImportOutcome; locked: boolean; canRetry: boolean;
  onRefresh?: (() => void) | undefined; onOpen?: ((batchId: string | null) => void) | undefined; onKind?: ((kind: HistoryImportKind) => void) | undefined;
  onFile?: ((file: File | null) => void) | undefined; onMap?: ((header: string, target: HistoryImportMappingTarget) => void) | undefined;
  onCancelUpload?: (() => void) | undefined; onStage?: (() => void) | undefined;
  onChoice?: ((index: number, choice: Choice) => void) | undefined; onAll?: ((which: 'VALID' | 'SKIP') => void) | undefined;
  onSave?: (() => void) | undefined; onFinalize?: (() => void) | undefined; onTryAgain?: (() => void) | undefined;
}>;

const day = (language: string, value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value)
  ? new Date(`${value}T00:00:00Z`).toLocaleDateString(language, { dateStyle: 'medium', timeZone: 'UTC' }) : value;
const when = (language: string, value: string) => new Date(value).toLocaleString(language, { dateStyle: 'medium', timeStyle: 'short' });
/** "1,3" (ISO weekdays, Monday = 1) as short day names in the reader's language. 2024-01-01 was a Monday. */
export function weekdayNames(language: string, value: string): string {
  const days = value.split(',').map(Number).filter((d) => Number.isInteger(d) && d >= 1 && d <= 7);
  if (!days.length) return value;
  return days.map((d) => new Date(Date.UTC(2024, 0, d)).toLocaleDateString(language, { weekday: 'short', timeZone: 'UTC' })).join(', ');
}

/** The decision shown for a row: an unsaved edit, else the saved choice, else the default (ready rows import, rows with problems skip). */
export function effectiveChoice(row: HistoryImportRow, choices: Readonly<Record<number, Choice>>): Choice {
  const edit = choices[row.index];
  if (edit && (edit === 'SKIP' || row.errors.length === 0)) return edit;
  return row.choice ?? (row.errors.length ? 'SKIP' : 'IMPORT');
}
/** The decisions the server does not have yet. */
export function unsavedDecisions(detail: HistoryImportDetail, choices: Readonly<Record<number, Choice>>): { index: number; choice: Choice }[] {
  if (detail.batch.status !== 'STAGED') return [];
  return detail.rows.filter((r) => effectiveChoice(r, choices) !== r.choice).map((r) => ({ index: r.index, choice: effectiveChoice(r, choices) }));
}
const has = (key: string): key is HistoryImportKey => Object.hasOwn(HISTORY_IMPORT_LANGUAGES.en, key);
const ALL_FIELDS: readonly string[] = [...new Set([...HISTORY_IMPORT_FIELDS.CLASSES, ...HISTORY_IMPORT_FIELDS.ATTENDANCE])];
/** "field:PROBLEM" codes from the server, in words. Unknown codes still show, as "needs checking". */
export function problemText(code: string, t: T): string {
  const [field = '', problem = ''] = code.split(':');
  const label = ALL_FIELDS.includes(field) ? t(`fld_${field}` as HistoryImportKey) : field === 'student' ? t('pf_student') : field === 'row' ? t('pf_row') : field;
  const specific = `r_${field}_${problem}`, general = `p_${problem}`;
  return `${label}: ${t(has(specific) ? specific : has(general) ? general : 'p_OTHER')}`;
}

function Recent({ p, t }: { p: HistoryImportViewProps; t: T }) {
  const batches = p.list.state === 'READY' ? p.list.list.batches : [];
  return <article className={styles.card} aria-labelledby="history-import-recent-title" data-testid="history-import-recent">
    <h2 id="history-import-recent-title">{t('recentTitle')}</h2>
    {p.list.state === 'LOADING' ? <p className={styles.meta} role="status">{t('recentLoading')}</p>
      : p.list.state === 'DENIED' ? <p className={styles.meta} role="status">{t('recentDenied')}</p>
      : p.list.state === 'UNAVAILABLE' ? <p className={styles.meta} role="status">{t('recentUnavailable')}</p>
      : batches.length === 0 ? <p className={styles.meta}>{t('recentNone')}</p>
      : <ul className={styles.list}>{batches.map((b) => <li key={b.id} data-testid="history-import-batch">
        <span>{t('recentRow', { kind: t(`kind_${b.kind}`), date: when(p.language, b.createdAt), rows: String(b.rowCount), imported: String(b.importedCount) })}</span>
        <div className={styles.row}><span className={styles.chip} data-state={b.status}>{t(`st_${b.status}`)}</span>
          <button type="button" className={styles.secondary} disabled={p.locked || p.selected?.toLowerCase() === b.id.toLowerCase()} onClick={() => p.onOpen?.(b.id)}>{t('open')}</button></div>
      </li>)}</ul>}
  </article>;
}

function Upload({ p, t }: { p: HistoryImportViewProps; t: T }) {
  const u = p.upload, problem = u.phase === 'MAPPING' ? mappingProblem(p.kind, u.mapping) : null;
  const required: readonly string[] = HISTORY_IMPORT_REQUIRED[p.kind];
  return <article className={styles.card} aria-labelledby="history-import-upload-title" data-testid="history-import-upload">
    <h2 id="history-import-upload-title">{t('uploadTitle')}</h2>
    <div className={styles.tabs} role="group" aria-label={t('kindTitle')}>
      {HISTORY_IMPORT_KINDS.map((k) => <button key={k} type="button" className={styles.tab} aria-pressed={p.kind === k} disabled={p.locked}
        data-testid={`history-import-kind-${k}`} onClick={() => p.onKind?.(k)}>{t(`kind_${k}`)}</button>)}
    </div>
    <p className={styles.meta}>{t(`uploadHelp_${p.kind}`)}</p>
    <p className={styles.meta}>{t(`scope_${p.kind}`)}</p>
    {u.phase !== 'MAPPING' ? <label className={styles.field}>{t('chooseFile')}
      <input type="file" accept=".csv,text/csv" disabled={p.locked} data-testid="history-import-file" onChange={(e) => { p.onFile?.(e.currentTarget.files?.[0] ?? null); e.currentTarget.value = ''; }}/></label> : null}
    {u.phase === 'FILE_ERROR' ? <p className={`${styles.notice} ${styles.warn}`} role="status">{t(u.problem === 'TOO_LARGE' ? 'fileTooLarge' : 'fileUnreadable')}</p> : null}
    {u.phase === 'MAPPING' ? <form className={styles.form} data-testid="history-import-mapping" onSubmit={(e) => { e.preventDefault(); if (!problem) p.onStage?.(); }}>
      <h3>{t('mapTitle')}: {u.fileName}</h3>
      <p className={styles.meta}>{t('mapHelp')}</p>
      <div className={styles.grid}>{u.headers.map((h) => <label key={h} className={styles.field}>{h}
        <select value={u.mapping[h] ?? 'ignore'} disabled={p.locked} onChange={(e) => p.onMap?.(h, e.target.value as HistoryImportMappingTarget)}>
          <option value="ignore">{t('ignore')}</option>
          {HISTORY_IMPORT_FIELDS[p.kind].map((f) => <option key={f} value={f}>{required.includes(f) ? t('required', { field: t(`fld_${f}`) }) : t(`fld_${f}`)}</option>)}
        </select></label>)}</div>
      {problem ? <p className={`${styles.notice} ${styles.warn}`} role="status" data-testid="history-import-mapping-problem">
        {t(problem === 'REQUIRED' ? `mp_REQUIRED_${p.kind}` : `mp_${problem}`)}</p> : null}
      <div className={styles.row}><button type="submit" className={styles.primary} disabled={p.locked || problem !== null}>{t('check')}</button>
        <button type="button" className={styles.secondary} disabled={p.locked} onClick={p.onCancelUpload}>{t('cancelUpload')}</button></div>
    </form> : null}
  </article>;
}

function Problems({ r, t }: { r: HistoryImportRow; t: T }) {
  return r.errors.length === 0 ? <span className={styles.meta}>{t('none')}</span>
    : <ul className={styles.problems}>{r.errors.map((code) => <li key={code}>{problemText(code, t)}</li>)}</ul>;
}
function Decision({ p, r, staged, t }: { p: HistoryImportViewProps; r: HistoryImportRow; staged: boolean; t: T }) {
  const choice = effectiveChoice(r, p.choices);
  return staged ? <fieldset className={styles.choice} disabled={p.locked} aria-label={`${t('col_choice')} ${r.index}`}>
    <label><input type="radio" name={`choice-${r.index}`} value="IMPORT" checked={choice === 'IMPORT'} disabled={r.errors.length > 0} onChange={() => p.onChoice?.(r.index, 'IMPORT')}/>{t('choiceImport')}</label>
    <label><input type="radio" name={`choice-${r.index}`} value="SKIP" checked={choice === 'SKIP'} onChange={() => p.onChoice?.(r.index, 'SKIP')}/>{t('choiceSkip')}</label>
  </fieldset> : <span className={styles.chip} data-state={r.created ? 'FINALIZED' : 'SKIPPED'}>{t(r.created ? 'imported' : 'notImported')}</span>;
}

function Rows({ p, detail, t }: { p: HistoryImportViewProps; detail: HistoryImportDetail; t: T }) {
  const staged = detail.batch.status === 'STAGED', classes = detail.batch.kind === 'CLASSES';
  const heads: HistoryImportKey[] = classes ? ['col_row', 'col_class', 'col_when', 'col_details', 'col_problems', 'col_choice']
    : ['col_row', 'col_student', 'col_date', 'col_visits', 'col_class', 'col_problems', 'col_choice'];
  return <div className={styles.tableWrap}><table className={styles.table} data-testid="history-import-rows">
    <thead><tr>{heads.map((h) => <th key={h} scope="col">{t(h)}</th>)}</tr></thead>
    <tbody>{detail.rows.map((r) => {
      const n = r.normalized;
      const booking = n.bookingPolicy && has(`bp_${n.bookingPolicy}`) ? t(`bp_${n.bookingPolicy}` as HistoryImportKey) : n.bookingPolicy ?? '';
      return <tr key={r.index} data-problem={r.errors.length > 0} data-testid="history-import-row">
        <td>{r.index}</td>
        {classes ? <>
          <td>{n.className || '—'}{n.programName && n.programName !== n.className ? <div className={styles.meta}>{n.programName}</div> : null}</td>
          <td>{n.weekdays && n.startTime && n.durationMinutes ? t('when', { days: weekdayNames(p.language, n.weekdays), time: n.startTime, minutes: n.durationMinutes }) : '—'}</td>
          <td>{t('details', { capacity: n.capacity ?? '', booking, date: day(p.language, n.startsOn ?? '') })}{n.roomName ? <div className={styles.meta}>{t('room', { room: n.roomName })}</div> : null}</td>
        </> : <>
          <td>{`${n.studentGivenName ?? ''} ${n.studentFamilyName ?? ''}`.trim() || '—'}
            {n.birthDate ? <div className={styles.meta}>{t('born', { date: day(p.language, n.birthDate) })}</div> : null}
            {r.matchedStudentProfileId ? <div className={styles.meta}>{t('matched')}</div> : null}</td>
          <td>{n.attendedOn ? day(p.language, n.attendedOn) : '—'}</td>
          <td>{n.visits || '—'}</td>
          <td>{n.className || '—'}</td>
        </>}
        <td><Problems r={r} t={t}/></td>
        <td><Decision p={p} r={r} staged={staged} t={t}/></td>
      </tr>;
    })}</tbody>
  </table></div>;
}

function Review({ p, t }: { p: HistoryImportViewProps; t: T }) {
  const ready = p.detail.state === 'READY' && p.detail.detail.batch.id.toLowerCase() === p.selected?.toLowerCase() ? p.detail.detail : null;
  const unsaved = ready ? unsavedDecisions(ready, p.choices) : [];
  const b = ready?.batch;
  const canFinalize = !!b && b.status === 'STAGED' && unsaved.length === 0 && b.undecidedCount === 0 && b.importCount > 0;
  return <article className={styles.card} aria-labelledby="history-import-review-title" data-testid="history-import-review">
    <div className={styles.cardHead}><h2 id="history-import-review-title">{t(b ? `reviewTitle_${b.kind}` : `reviewTitle_${p.kind}`)}</h2>
      <button type="button" className={styles.secondary} disabled={p.locked} onClick={() => p.onOpen?.(null)}>{t('back')}</button></div>
    {p.detail.state === 'DENIED' ? <p className={styles.meta} role="status">{t('batchDenied')}</p>
      : p.detail.state === 'GONE' ? <p className={styles.meta} role="status">{t('batchGone')}</p>
      : p.detail.state === 'UNAVAILABLE' ? <p className={styles.meta} role="status">{t('batchUnavailable')}</p>
      : !ready || !b ? <p className={styles.meta} role="status">{t('batchLoading')}</p>
      : <>
        <p><span className={styles.chip} data-state={b.status}>{t(`st_${b.status}`)}</span> {t('summary', { rows: String(b.rowCount), valid: String(b.validCount), problems: String(b.rowCount - b.validCount) })}</p>
        <p className={styles.meta}>{t(`scope_${b.kind}`)}</p>
        {b.status === 'FINALIZED' ? <>
          <p data-testid="history-import-imported">{t(`importedSummary_${b.kind}`, { n: String(b.importedCount), date: when(p.language, b.finalizedAt ?? b.createdAt) })}</p>
          {b.kind === 'CLASSES' ? <div className={styles.row}><a className={styles.secondary} href="/staff/schedule">{t('openSchedule')} →</a></div> : null}
        </> : <>
          <p className={styles.meta}>{t('counts', { import: String(b.importCount), skip: String(b.skipCount), undecided: String(b.undecidedCount) })}</p>
          <p className={styles.meta}>{t('reviewHelp')}</p>
          {b.kind === 'CLASSES' ? <p className={styles.meta}>{t('defaults')}</p> : null}
          <div className={styles.row}>
            <button type="button" className={styles.secondary} disabled={p.locked} onClick={() => p.onAll?.('VALID')}>{t('markValid')}</button>
            <button type="button" className={styles.secondary} disabled={p.locked} onClick={() => p.onAll?.('SKIP')}>{t('skipAll')}</button>
            <button type="button" className={styles.primary} disabled={p.locked || unsaved.length === 0} onClick={p.onSave} data-testid="history-import-save">{t('saveChoices')}</button>
          </div>
          {unsaved.length ? <p className={`${styles.meta} ${styles.warnText}`} role="status">{t('unsaved')}</p> : null}
        </>}
        <Rows p={p} detail={ready} t={t}/>
        {b.status === 'STAGED' ? <div className={`${styles.form} ${styles.danger}`} data-testid="history-import-finalize">
          <h3>{t('finalizeTitle')}</h3>
          <p>{t(`finalizeHelp_${b.kind}`, { n: String(b.importCount) })}</p>
          {!canFinalize ? <p className={styles.meta}>{unsaved.length || b.undecidedCount ? t('finalizeNeedsDecisions') : t('finalizeNothing')}</p> : null}
          <div className={styles.row}><button type="button" className={styles.primary} disabled={p.locked || !canFinalize} onClick={p.onFinalize}>{t(`finalizeConfirm_${b.kind}`, { n: String(b.importCount) })}</button></div>
        </div> : null}
      </>}
  </article>;
}

/** Pure view. Imports, rows and decisions come only from the school's reads; nothing shows before the shell verifies the school. */
export function HistoryImportView(p: HistoryImportViewProps): React.ReactElement {
  const t: T = (key, vars) => historyImportText(p.language, key, vars);
  const notice = p.waiting ? t('waiting') : p.concealed ? t('concealed') : !p.hasSchool ? t('noSchool') : null;
  const allowed = p.list.state === 'READY';
  return <section className={styles.page} aria-labelledby="history-import-title" data-hon-native="" data-testid="history-import">
    <header className={styles.head}>
      <div><h1 id="history-import-title">{t('title')}</h1><p className={styles.intro}>{t('intro')}</p></div>
      {notice === null && p.onRefresh ? <button type="button" className={styles.secondary} onClick={p.onRefresh} disabled={p.locked}>{t('refresh')}</button> : null}
    </header>
    {notice ? <p className={styles.notice} role="status">{notice}</p> : <>
      {p.outcome ? <div className={styles.notice} role="status" data-testid="history-import-outcome" data-kind={p.outcome.kind}>
        <p>{p.outcome.kind === 'SENDING' ? t('sending') : p.outcome.kind === 'DONE' ? t(`done_${p.outcome.action}`) : t(`e_${p.outcome.kind}`)}</p>
        {p.canRetry && p.onTryAgain ? <button type="button" className={styles.primary} onClick={p.onTryAgain}>{t('tryAgain')}</button> : null}</div> : null}
      {p.selected ? <Review p={p} t={t}/> : <>
        {allowed ? <Upload p={p} t={t}/> : null}
        <Recent p={p} t={t}/>
      </>}
    </>}
  </section>;
}
