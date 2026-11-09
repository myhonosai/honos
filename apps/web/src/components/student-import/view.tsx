import React from 'react';
import { STUDENT_IMPORT_FIELDS, type StudentImportDetail, type StudentImportList, type StudentImportMappingTarget, type StudentImportRow } from '@hon/contracts';
import { importText, type ImportKey } from './copy';
import { mappingProblem, type ImportErrorKind } from './http';
import styles from './student-import.module.css';

type T = (key: ImportKey, vars?: Record<string, string>) => string;
export type Choice = 'IMPORT' | 'SKIP';
export type ImportAction = 'stage' | 'decide' | 'finalize';
export type ListState = { state: 'LOADING' | 'DENIED' | 'UNAVAILABLE' } | { state: 'READY'; list: StudentImportList };
export type DetailState = { state: 'IDLE' | 'LOADING' | 'DENIED' | 'GONE' | 'UNAVAILABLE' } | { state: 'READY'; detail: StudentImportDetail };
export type UploadState = { phase: 'NONE' } | { phase: 'FILE_ERROR'; problem: 'TOO_LARGE' | 'UNREADABLE' }
  | { phase: 'MAPPING'; fileName: string; csv: string; headers: readonly string[]; mapping: Readonly<Record<string, StudentImportMappingTarget>> };
export type ImportOutcome = null | Readonly<{ kind: 'SENDING' | 'DONE' | ImportErrorKind; action: ImportAction }>;

export type StudentImportViewProps = Readonly<{
  language: string; waiting: boolean; concealed: boolean; hasSchool: boolean;
  list: ListState; selected: string | null; detail: DetailState; upload: UploadState; choices: Readonly<Record<number, Choice>>;
  outcome: ImportOutcome; locked: boolean; canRetry: boolean;
  onRefresh?: (() => void) | undefined; onOpen?: ((batchId: string | null) => void) | undefined;
  onFile?: ((file: File | null) => void) | undefined; onMap?: ((header: string, target: StudentImportMappingTarget) => void) | undefined;
  onCancelUpload?: (() => void) | undefined; onStage?: (() => void) | undefined;
  onChoice?: ((index: number, choice: Choice) => void) | undefined; onAll?: ((which: 'VALID' | 'SKIP') => void) | undefined;
  onSave?: (() => void) | undefined; onFinalize?: (() => void) | undefined; onTryAgain?: (() => void) | undefined;
}>;

const day = (language: string, value: string) => new Date(`${value}T00:00:00Z`).toLocaleDateString(language, { dateStyle: 'medium', timeZone: 'UTC' });
const when = (language: string, value: string) => new Date(value).toLocaleString(language, { dateStyle: 'medium', timeStyle: 'short' });

/** The decision shown for a row: an unsaved edit, else the saved choice, else the default (ready rows import, rows with problems skip). */
export function effectiveChoice(row: StudentImportRow, choices: Readonly<Record<number, Choice>>): Choice {
  const edit = choices[row.index];
  if (edit && (edit === 'SKIP' || row.errors.length === 0)) return edit;
  return row.choice ?? (row.errors.length ? 'SKIP' : 'IMPORT');
}
/** The decisions the server does not have yet. */
export function unsavedDecisions(detail: StudentImportDetail, choices: Readonly<Record<number, Choice>>): { index: number; choice: Choice }[] {
  if (detail.batch.status !== 'STAGED') return [];
  return detail.rows.filter((r) => effectiveChoice(r, choices) !== r.choice).map((r) => ({ index: r.index, choice: effectiveChoice(r, choices) }));
}
/** "field:PROBLEM" codes from the server, in words. Unknown codes still show, as "needs checking". */
export function problemText(code: string, t: T): string {
  const [field = '', problem = ''] = code.split(':');
  const label = (STUDENT_IMPORT_FIELDS as readonly string[]).includes(field) ? t(`fld_${field}` as ImportKey)
    : field === 'student' ? t('pf_student') : field === 'guardian' ? t('pf_guardian') : field;
  const known = `p_${problem}` as ImportKey;
  return `${label}: ${t(Object.hasOwn(importTextKeys, known) ? known : 'p_OTHER')}`;
}
const importTextKeys = Object.fromEntries(['TOO_LONG', 'CONTROL_CHARACTER', 'FORMULA_INJECTION', 'INVALID', 'USE_E164', 'USE_YYYY_MM_DD', 'OUT_OF_RANGE', 'NAME_REQUIRED',
  'GUARDIAN_MISMATCH', 'REQUIRED_FOR_MINOR', 'REQUIRED_WITHOUT_GUARDIAN'].map((p) => [`p_${p}`, true]));

function Recent({ p, t }: { p: StudentImportViewProps; t: T }) {
  const batches = p.list.state === 'READY' ? p.list.list.batches : [];
  return <article className={styles.card} aria-labelledby="student-import-recent-title" data-testid="student-import-recent">
    <h2 id="student-import-recent-title">{t('recentTitle')}</h2>
    {p.list.state === 'LOADING' ? <p className={styles.meta} role="status">{t('recentLoading')}</p>
      : p.list.state === 'DENIED' ? <p className={styles.meta} role="status">{t('recentDenied')}</p>
      : p.list.state === 'UNAVAILABLE' ? <p className={styles.meta} role="status">{t('recentUnavailable')}</p>
      : batches.length === 0 ? <p className={styles.meta}>{t('recentNone')}</p>
      : <ul className={styles.list}>{batches.map((b) => <li key={b.id} data-testid="student-import-batch">
        <span>{t('recentRow', { date: when(p.language, b.createdAt), rows: String(b.rowCount), imported: String(b.importedCount) })}</span>
        <div className={styles.row}><span className={styles.chip} data-state={b.status}>{t(`st_${b.status}`)}</span>
          <button type="button" className={styles.secondary} disabled={p.locked || p.selected?.toLowerCase() === b.id.toLowerCase()} onClick={() => p.onOpen?.(b.id)}>{t('open')}</button></div>
      </li>)}</ul>}
  </article>;
}

function Upload({ p, t }: { p: StudentImportViewProps; t: T }) {
  const u = p.upload, problem = u.phase === 'MAPPING' ? mappingProblem(u.mapping) : null;
  return <article className={styles.card} aria-labelledby="student-import-upload-title" data-testid="student-import-upload">
    <h2 id="student-import-upload-title">{t('uploadTitle')}</h2>
    <p className={styles.meta}>{t('uploadHelp')}</p>
    {u.phase !== 'MAPPING' ? <label className={styles.field}>{t('chooseFile')}
      <input type="file" accept=".csv,text/csv" disabled={p.locked} data-testid="student-import-file" onChange={(e) => { p.onFile?.(e.currentTarget.files?.[0] ?? null); e.currentTarget.value = ''; }}/></label> : null}
    {u.phase === 'FILE_ERROR' ? <p className={`${styles.notice} ${styles.warn}`} role="status">{t(u.problem === 'TOO_LARGE' ? 'fileTooLarge' : 'fileUnreadable')}</p> : null}
    {u.phase === 'MAPPING' ? <form className={styles.form} data-testid="student-import-mapping" onSubmit={(e) => { e.preventDefault(); if (!problem) p.onStage?.(); }}>
      <h3>{t('mapTitle')}: {u.fileName}</h3>
      <p className={styles.meta}>{t('mapHelp')}</p>
      <div className={styles.grid}>{u.headers.map((h) => <label key={h} className={styles.field}>{h}
        <select value={u.mapping[h] ?? 'ignore'} disabled={p.locked} onChange={(e) => p.onMap?.(h, e.target.value as StudentImportMappingTarget)}>
          <option value="ignore">{t('ignore')}</option>
          {STUDENT_IMPORT_FIELDS.map((f) => <option key={f} value={f}>{t(`fld_${f}`)}</option>)}
        </select></label>)}</div>
      {problem ? <p className={`${styles.notice} ${styles.warn}`} role="status" data-testid="student-import-mapping-problem">{t(`mp_${problem}`)}</p> : null}
      <div className={styles.row}><button type="submit" className={styles.primary} disabled={p.locked || problem !== null}>{t('check')}</button>
        <button type="button" className={styles.secondary} disabled={p.locked} onClick={p.onCancelUpload}>{t('cancelUpload')}</button></div>
    </form> : null}
  </article>;
}

function Rows({ p, detail, t }: { p: StudentImportViewProps; detail: StudentImportDetail; t: T }) {
  const staged = detail.batch.status === 'STAGED';
  return <div className={styles.tableWrap}><table className={styles.table} data-testid="student-import-rows">
    <thead><tr><th scope="col">{t('col_row')}</th><th scope="col">{t('col_student')}</th><th scope="col">{t('col_birth')}</th><th scope="col">{t('col_guardian')}</th>
      <th scope="col">{t('col_problems')}</th><th scope="col">{t('col_choice')}</th></tr></thead>
    <tbody>{detail.rows.map((r) => {
      const n = r.normalized, g = n.guardian, choice = effectiveChoice(r, p.choices);
      const existing = r.suggestions.flatMap((s) => 'personId' in s ? [t(`r_${s.reason}`)] : []);
      const inFile = r.suggestions.flatMap((s) => 'rowIndex' in s ? [String(s.rowIndex)] : []);
      return <tr key={r.index} data-problem={r.errors.length > 0} data-testid="student-import-row">
        <td>{r.index}</td>
        <td>{`${n.studentGivenName ?? ''} ${n.studentFamilyName ?? ''}`.trim() || '—'}{n.studentEmail ? <div className={styles.meta}>{n.studentEmail}</div> : null}</td>
        <td>{n.birthDate || '—'}</td>
        <td>{g ? `${g.givenName} ${g.familyName}` : '—'}{g && (g.email || g.mobile) ? <div className={styles.meta}>{[g.email, g.mobile].filter(Boolean).join(' · ')}</div> : null}</td>
        <td>{r.errors.length === 0 && existing.length === 0 && inFile.length === 0 ? <span className={styles.meta}>{t('none')}</span> : <ul className={styles.problems}>
          {r.errors.map((code) => <li key={code}>{problemText(code, t)}</li>)}
          {existing.length ? <li className={styles.meta}>{t('suggestExisting', { reasons: [...new Set(existing)].join(', ') })}</li> : null}
          {inFile.length ? <li className={styles.meta}>{t('suggestInFile', { rows: inFile.join(', ') })}</li> : null}</ul>}</td>
        <td>{staged ? <fieldset className={styles.choice} disabled={p.locked} aria-label={`${t('col_choice')} ${r.index}`}>
          <label><input type="radio" name={`choice-${r.index}`} value="IMPORT" checked={choice === 'IMPORT'} disabled={r.errors.length > 0} onChange={() => p.onChoice?.(r.index, 'IMPORT')}/>{t('choiceImport')}</label>
          <label><input type="radio" name={`choice-${r.index}`} value="SKIP" checked={choice === 'SKIP'} onChange={() => p.onChoice?.(r.index, 'SKIP')}/>{t('choiceSkip')}</label>
        </fieldset> : <span className={styles.chip} data-state={r.created ? 'FINALIZED' : 'SKIPPED'}>{t(r.created ? 'imported' : 'notImported')}</span>}</td>
      </tr>;
    })}</tbody>
  </table></div>;
}

function Review({ p, t }: { p: StudentImportViewProps; t: T }) {
  const ready = p.detail.state === 'READY' && p.detail.detail.batch.id.toLowerCase() === p.selected?.toLowerCase() ? p.detail.detail : null;
  const unsaved = ready ? unsavedDecisions(ready, p.choices) : [];
  const b = ready?.batch;
  const canFinalize = !!b && b.status === 'STAGED' && unsaved.length === 0 && b.undecidedCount === 0 && b.importCount > 0;
  return <article className={styles.card} aria-labelledby="student-import-review-title" data-testid="student-import-review">
    <div className={styles.cardHead}><h2 id="student-import-review-title">{t('reviewTitle')}</h2>
      <button type="button" className={styles.secondary} disabled={p.locked} onClick={() => p.onOpen?.(null)}>{t('back')}</button></div>
    {p.detail.state === 'DENIED' ? <p className={styles.meta} role="status">{t('batchDenied')}</p>
      : p.detail.state === 'GONE' ? <p className={styles.meta} role="status">{t('batchGone')}</p>
      : p.detail.state === 'UNAVAILABLE' ? <p className={styles.meta} role="status">{t('batchUnavailable')}</p>
      : !ready || !b ? <p className={styles.meta} role="status">{t('batchLoading')}</p>
      : <>
        <p><span className={styles.chip} data-state={b.status}>{t(`st_${b.status}`)}</span> {t('summary', { rows: String(b.rowCount), valid: String(b.validCount), problems: String(b.rowCount - b.validCount) })}</p>
        {b.status === 'FINALIZED' ? <p data-testid="student-import-imported">{t('importedSummary', { n: String(b.importedCount), date: when(p.language, b.finalizedAt ?? b.createdAt) })}</p>
          : <>
            <p className={styles.meta}>{t('counts', { import: String(b.importCount), skip: String(b.skipCount), undecided: String(b.undecidedCount) })}</p>
            <p className={styles.meta}>{t('reviewHelp')}</p>
            <div className={styles.row}>
              <button type="button" className={styles.secondary} disabled={p.locked} onClick={() => p.onAll?.('VALID')}>{t('markValid')}</button>
              <button type="button" className={styles.secondary} disabled={p.locked} onClick={() => p.onAll?.('SKIP')}>{t('skipAll')}</button>
              <button type="button" className={styles.primary} disabled={p.locked || unsaved.length === 0} onClick={p.onSave} data-testid="student-import-save">{t('saveChoices')}</button>
            </div>
            {unsaved.length ? <p className={`${styles.meta} ${styles.warnText}`} role="status">{t('unsaved')}</p> : null}
          </>}
        <Rows p={p} detail={ready} t={t}/>
        {b.status === 'STAGED' ? <div className={`${styles.form} ${styles.danger}`} data-testid="student-import-finalize">
          <h3>{t('finalizeTitle')}</h3>
          <p>{t('finalizeHelp', { n: String(b.importCount) })}</p>
          {!canFinalize ? <p className={styles.meta}>{unsaved.length || b.undecidedCount ? t('finalizeNeedsDecisions') : t('finalizeNothing')}</p> : null}
          <div className={styles.row}><button type="button" className={styles.primary} disabled={p.locked || !canFinalize} onClick={p.onFinalize}>{t('finalizeConfirm', { n: String(b.importCount) })}</button></div>
        </div> : null}
      </>}
  </article>;
}

/** Pure view. Imports, rows and decisions come only from the school's reads; nothing shows before the shell verifies the school. */
export function StudentImportView(p: StudentImportViewProps): React.ReactElement {
  const t: T = (key, vars) => importText(p.language, key, vars);
  const notice = p.waiting ? t('waiting') : p.concealed ? t('concealed') : !p.hasSchool ? t('noSchool') : null;
  const allowed = p.list.state === 'READY';
  return <section className={styles.page} aria-labelledby="student-import-title" data-hon-native="" data-testid="student-import">
    <header className={styles.head}>
      <div><h1 id="student-import-title">{t('title')}</h1><p className={styles.intro}>{t('intro')}</p></div>
      {notice === null && p.onRefresh ? <button type="button" className={styles.secondary} onClick={p.onRefresh} disabled={p.locked}>{t('refresh')}</button> : null}
    </header>
    <p className={styles.meta}>{t('scope')}</p>
    {notice ? <p className={styles.notice} role="status">{notice}</p> : <>
      {p.outcome ? <div className={styles.notice} role="status" data-testid="student-import-outcome" data-kind={p.outcome.kind}>
        <p>{p.outcome.kind === 'SENDING' ? t('sending') : p.outcome.kind === 'DONE' ? t(`done_${p.outcome.action}`) : t(`e_${p.outcome.kind}`)}</p>
        {p.canRetry && p.onTryAgain ? <button type="button" className={styles.primary} onClick={p.onTryAgain}>{t('tryAgain')}</button> : null}</div> : null}
      {p.selected ? <Review p={p} t={t}/> : <>
        {allowed ? <Upload p={p} t={t}/> : null}
        <Recent p={p} t={t}/>
      </>}
    </>}
  </section>;
}
