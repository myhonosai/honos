import React from 'react';
import {
  BILLING_IMPORT_FIELDS, BILLING_IMPORT_REQUIRED,
  type BillingImportDetail, type BillingImportList, type BillingImportMappingTarget, type BillingImportRow,
} from '@hon/contracts';
import { BILLING_IMPORT_LANGUAGES, billingImportText, type BillingImportKey } from './copy';
import { mappingProblem, type ImportErrorKind } from './http';
import styles from '../student-import/student-import.module.css';

type T = (key: BillingImportKey, vars?: Record<string, string>) => string;
export type Choice = 'IMPORT' | 'SKIP';
export type ImportAction = 'stage' | 'decide' | 'finalize';
export type ListState = { state: 'LOADING' | 'DENIED' | 'UNAVAILABLE' } | { state: 'READY'; list: BillingImportList };
export type DetailState = { state: 'IDLE' | 'LOADING' | 'DENIED' | 'GONE' | 'UNAVAILABLE' } | { state: 'READY'; detail: BillingImportDetail };
export type UploadState = { phase: 'NONE' } | { phase: 'FILE_ERROR'; problem: 'TOO_LARGE' | 'UNREADABLE' }
  | { phase: 'MAPPING'; fileName: string; csv: string; headers: readonly string[]; mapping: Readonly<Record<string, BillingImportMappingTarget>> };
export type ImportOutcome = null | Readonly<{ kind: 'SENDING' | 'DONE' | ImportErrorKind; action: ImportAction }>;

export type BillingImportViewProps = Readonly<{
  language: string; waiting: boolean; concealed: boolean; hasSchool: boolean;
  list: ListState; selected: string | null; detail: DetailState; upload: UploadState; choices: Readonly<Record<number, Choice>>;
  outcome: ImportOutcome; locked: boolean; canRetry: boolean;
  onRefresh?: (() => void) | undefined; onOpen?: ((batchId: string | null) => void) | undefined;
  onFile?: ((file: File | null) => void) | undefined; onMap?: ((header: string, target: BillingImportMappingTarget) => void) | undefined;
  onCancelUpload?: (() => void) | undefined; onStage?: (() => void) | undefined;
  onChoice?: ((index: number, choice: Choice) => void) | undefined; onAll?: ((which: 'VALID' | 'SKIP') => void) | undefined;
  onSave?: (() => void) | undefined; onFinalize?: (() => void) | undefined; onTryAgain?: (() => void) | undefined;
}>;

const day = (language: string, value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value)
  ? new Date(`${value}T00:00:00Z`).toLocaleDateString(language, { dateStyle: 'medium', timeZone: 'UTC' }) : value;
const when = (language: string, value: string) => new Date(value).toLocaleString(language, { dateStyle: 'medium', timeStyle: 'short' });
const WHOLE_UNITS = new Set(['JPY', 'KRW']);
/** Minor units from the server as money in the reader's language. JPY and KRW have no minor unit. */
export function money(language: string, minor: string, currency: string): string {
  const n = Number(minor);
  if (!/^\d+$/.test(minor) || !Number.isSafeInteger(n)) return minor;
  const code = /^[A-Z]{3}$/.test(currency) ? currency : 'USD';
  const value = WHOLE_UNITS.has(code) ? n : n / 100;
  try { return new Intl.NumberFormat(language, { style: 'currency', currency: code }).format(value); } catch { return `${value} ${code}`; }
}

/** The decision shown for a row: an unsaved edit, else the saved choice, else the default (ready rows import, rows with problems skip). */
export function effectiveChoice(row: BillingImportRow, choices: Readonly<Record<number, Choice>>): Choice {
  const edit = choices[row.index];
  if (edit && (edit === 'SKIP' || row.errors.length === 0)) return edit;
  return row.choice ?? (row.errors.length ? 'SKIP' : 'IMPORT');
}
/** The decisions the server does not have yet. */
export function unsavedDecisions(detail: BillingImportDetail, choices: Readonly<Record<number, Choice>>): { index: number; choice: Choice }[] {
  if (detail.batch.status !== 'STAGED') return [];
  return detail.rows.filter((r) => effectiveChoice(r, choices) !== r.choice).map((r) => ({ index: r.index, choice: effectiveChoice(r, choices) }));
}
const has = (key: string): key is BillingImportKey => Object.hasOwn(BILLING_IMPORT_LANGUAGES.en, key);
const FIELDS: readonly string[] = BILLING_IMPORT_FIELDS;
const PSEUDO: Record<string, BillingImportKey> = { student: 'pf_student', payer: 'pf_payer', row: 'pf_row' };
/** "field:PROBLEM" codes from the server, in words. Unknown codes still show, as "needs checking". */
export function problemText(code: string, t: T): string {
  const [field = '', problem = ''] = code.split(':');
  const pseudo = PSEUDO[field];
  const label = FIELDS.includes(field) ? t(`fld_${field}` as BillingImportKey) : pseudo ? t(pseudo) : field;
  const specific = `r_${field}_${problem}`, general = `p_${problem}`;
  return `${label}: ${t(has(specific) ? specific : has(general) ? general : 'p_OTHER')}`;
}
const text = (v: string | boolean | undefined) => typeof v === 'string' ? v : '';

function Recent({ p, t }: { p: BillingImportViewProps; t: T }) {
  const batches = p.list.state === 'READY' ? p.list.list.batches : [];
  return <article className={styles.card} aria-labelledby="billing-import-recent-title" data-testid="billing-import-recent">
    <h2 id="billing-import-recent-title">{t('recentTitle')}</h2>
    {p.list.state === 'LOADING' ? <p className={styles.meta} role="status">{t('recentLoading')}</p>
      : p.list.state === 'DENIED' ? <p className={styles.meta} role="status">{t('recentDenied')}</p>
      : p.list.state === 'UNAVAILABLE' ? <p className={styles.meta} role="status">{t('recentUnavailable')}</p>
      : batches.length === 0 ? <p className={styles.meta}>{t('recentNone')}</p>
      : <ul className={styles.list}>{batches.map((b) => <li key={b.id} data-testid="billing-import-batch">
        <span>{t('recentRow', { date: when(p.language, b.createdAt), rows: String(b.rowCount), imported: String(b.importedCount) })}</span>
        <div className={styles.row}><span className={styles.chip} data-state={b.status}>{t(`st_${b.status}`)}</span>
          <button type="button" className={styles.secondary} disabled={p.locked || p.selected?.toLowerCase() === b.id.toLowerCase()} onClick={() => p.onOpen?.(b.id)}>{t('open')}</button></div>
      </li>)}</ul>}
  </article>;
}

function Upload({ p, t }: { p: BillingImportViewProps; t: T }) {
  const u = p.upload, problem = u.phase === 'MAPPING' ? mappingProblem(u.mapping) : null;
  const required: readonly string[] = BILLING_IMPORT_REQUIRED;
  return <article className={styles.card} aria-labelledby="billing-import-upload-title" data-testid="billing-import-upload">
    <h2 id="billing-import-upload-title">{t('uploadTitle')}</h2>
    <p className={styles.meta}>{t('uploadHelp')}</p>
    <p className={styles.meta}>{t('uploadFirst')}</p>
    <p className={styles.meta}>{t('scope')}</p>
    {u.phase !== 'MAPPING' ? <label className={styles.field}>{t('chooseFile')}
      <input type="file" accept=".csv,text/csv" disabled={p.locked} data-testid="billing-import-file" onChange={(e) => { p.onFile?.(e.currentTarget.files?.[0] ?? null); e.currentTarget.value = ''; }}/></label> : null}
    {u.phase === 'FILE_ERROR' ? <p className={`${styles.notice} ${styles.warn}`} role="status">{t(u.problem === 'TOO_LARGE' ? 'fileTooLarge' : 'fileUnreadable')}</p> : null}
    {u.phase === 'MAPPING' ? <form className={styles.form} data-testid="billing-import-mapping" onSubmit={(e) => { e.preventDefault(); if (!problem) p.onStage?.(); }}>
      <h3>{t('mapTitle')}: {u.fileName}</h3>
      <p className={styles.meta}>{t('mapHelp')}</p>
      <div className={styles.grid}>{u.headers.map((h) => <label key={h} className={styles.field}>{h}
        <select value={u.mapping[h] ?? 'ignore'} disabled={p.locked} onChange={(e) => p.onMap?.(h, e.target.value as BillingImportMappingTarget)}>
          <option value="ignore">{t('ignore')}</option>
          {BILLING_IMPORT_FIELDS.map((f) => <option key={f} value={f}>{required.includes(f) ? t('required', { field: t(`fld_${f}`) }) : t(`fld_${f}`)}</option>)}
        </select></label>)}</div>
      {problem ? <p className={`${styles.notice} ${styles.warn}`} role="status" data-testid="billing-import-mapping-problem">{t(`mp_${problem}`)}</p> : null}
      <div className={styles.row}><button type="submit" className={styles.primary} disabled={p.locked || problem !== null}>{t('check')}</button>
        <button type="button" className={styles.secondary} disabled={p.locked} onClick={p.onCancelUpload}>{t('cancelUpload')}</button></div>
    </form> : null}
  </article>;
}

function Problems({ r, t }: { r: BillingImportRow; t: T }) {
  return r.errors.length === 0 ? <span className={styles.meta}>{t('none')}</span>
    : <ul className={styles.problems}>{r.errors.map((code) => <li key={code}>{problemText(code, t)}</li>)}</ul>;
}
function Decision({ p, r, staged, t }: { p: BillingImportViewProps; r: BillingImportRow; staged: boolean; t: T }) {
  const choice = effectiveChoice(r, p.choices);
  return staged ? <fieldset className={styles.choice} disabled={p.locked} aria-label={`${t('col_choice')} ${r.index}`}>
    <label><input type="radio" name={`choice-${r.index}`} value="IMPORT" checked={choice === 'IMPORT'} disabled={r.errors.length > 0} onChange={() => p.onChoice?.(r.index, 'IMPORT')}/>{t('choiceImport')}</label>
    <label><input type="radio" name={`choice-${r.index}`} value="SKIP" checked={choice === 'SKIP'} onChange={() => p.onChoice?.(r.index, 'SKIP')}/>{t('choiceSkip')}</label>
  </fieldset> : <span className={styles.chip} data-state={r.created ? 'FINALIZED' : 'SKIPPED'}>{t(r.created ? 'imported' : 'notImported')}</span>;
}

function Rows({ p, detail, t }: { p: BillingImportViewProps; detail: BillingImportDetail; t: T }) {
  const staged = detail.batch.status === 'STAGED';
  const heads: BillingImportKey[] = ['col_row', 'col_student', 'col_plan', 'col_price', 'col_dates', 'col_balance', 'col_problems', 'col_choice'];
  return <div className={styles.tableWrap}><table className={styles.table} data-testid="billing-import-rows">
    <thead><tr>{heads.map((h) => <th key={h} scope="col">{t(h)}</th>)}</tr></thead>
    <tbody>{detail.rows.map((r) => {
      const n = r.normalized, currency = text(n.currency);
      const freq = text(n.frequency), amountMinor = text(n.amountMinor), balanceMinor = text(n.balanceMinor);
      const everyKey = `every_${freq}`;
      return <tr key={r.index} data-problem={r.errors.length > 0} data-testid="billing-import-row">
        <td>{r.index}</td>
        <td>{`${text(n.studentGivenName)} ${text(n.studentFamilyName)}`.trim() || '—'}
          {n.birthDate ? <div className={styles.meta}>{t('born', { date: day(p.language, text(n.birthDate)) })}</div> : null}
          {r.payerName ? <div className={styles.meta}>{t('paidBy', { name: r.payerName })}</div> : null}</td>
        <td>{text(n.planName) || '—'}
          {n.planMatched === true ? <div className={styles.meta}>{t('catalogPlan')}</div>
            : n.planCode ? <div className={styles.meta}>{t('newCode', { code: text(n.planCode) })}</div> : null}</td>
        <td>{amountMinor && has(everyKey) ? t(everyKey, { amount: money(p.language, amountMinor, currency) }) : text(n.amount) || '—'}</td>
        <td>{n.startedOn ? <div>{t('started', { date: day(p.language, text(n.startedOn)) })}</div> : null}
          <div className={styles.meta}>{n.endsOn ? t('ends', { date: day(p.language, text(n.endsOn)) }) : t('openEnded')}</div>
          {n.nextChargeOn ? <div className={styles.meta}>{t('nextCharge', { date: day(p.language, text(n.nextChargeOn)) })}</div> : null}</td>
        <td>{balanceMinor && balanceMinor !== '0'
          ? t('owes', { amount: money(p.language, balanceMinor, currency), date: day(p.language, text(n.balanceDueOn) || detail.batch.schoolToday) })
          : t('noBalance')}</td>
        <td><Problems r={r} t={t}/></td>
        <td><Decision p={p} r={r} staged={staged} t={t}/></td>
      </tr>;
    })}</tbody>
  </table></div>;
}

function Review({ p, t }: { p: BillingImportViewProps; t: T }) {
  const ready = p.detail.state === 'READY' && p.detail.detail.batch.id.toLowerCase() === p.selected?.toLowerCase() ? p.detail.detail : null;
  const unsaved = ready ? unsavedDecisions(ready, p.choices) : [];
  const b = ready?.batch;
  const canFinalize = !!b && b.status === 'STAGED' && unsaved.length === 0 && b.undecidedCount === 0 && b.importCount > 0;
  return <article className={styles.card} aria-labelledby="billing-import-review-title" data-testid="billing-import-review">
    <div className={styles.cardHead}><h2 id="billing-import-review-title">{t('reviewTitle')}</h2>
      <button type="button" className={styles.secondary} disabled={p.locked} onClick={() => p.onOpen?.(null)}>{t('back')}</button></div>
    {p.detail.state === 'DENIED' ? <p className={styles.meta} role="status">{t('batchDenied')}</p>
      : p.detail.state === 'GONE' ? <p className={styles.meta} role="status">{t('batchGone')}</p>
      : p.detail.state === 'UNAVAILABLE' ? <p className={styles.meta} role="status">{t('batchUnavailable')}</p>
      : !ready || !b ? <p className={styles.meta} role="status">{t('batchLoading')}</p>
      : <>
        <p><span className={styles.chip} data-state={b.status}>{t(`st_${b.status}`)}</span> {t('summary', { rows: String(b.rowCount), valid: String(b.validCount), problems: String(b.rowCount - b.validCount) })}</p>
        <p className={styles.meta}>{t('scope')}</p>
        {b.status === 'FINALIZED' ? <>
          <p data-testid="billing-import-imported">{t('importedSummary', { n: String(b.importedCount), date: when(p.language, b.finalizedAt ?? b.createdAt), balances: String(b.balanceCount) })}</p>
          <p className={styles.meta}>{t('next')}</p>
          <div className={styles.row}>
            <a className={styles.secondary} href="/staff/memberships">{t('openMemberships')} →</a>
            <a className={styles.secondary} href="/staff/billing/receivables">{t('openBalances')} →</a>
            <a className={styles.secondary} href="/staff/billing/saved-payment-methods">{t('openCards')} →</a>
          </div>
        </> : <>
          <p className={styles.meta}>{t('counts', { import: String(b.importCount), skip: String(b.skipCount), undecided: String(b.undecidedCount) })}</p>
          <p className={styles.meta}>{t('reviewHelp')}</p>
          <p className={styles.meta}>{t('defaults')}</p>
          <div className={styles.row}>
            <button type="button" className={styles.secondary} disabled={p.locked} onClick={() => p.onAll?.('VALID')}>{t('markValid')}</button>
            <button type="button" className={styles.secondary} disabled={p.locked} onClick={() => p.onAll?.('SKIP')}>{t('skipAll')}</button>
            <button type="button" className={styles.primary} disabled={p.locked || unsaved.length === 0} onClick={p.onSave} data-testid="billing-import-save">{t('saveChoices')}</button>
          </div>
          {unsaved.length ? <p className={`${styles.meta} ${styles.warnText}`} role="status">{t('unsaved')}</p> : null}
        </>}
        <Rows p={p} detail={ready} t={t}/>
        {b.status === 'STAGED' ? <div className={`${styles.form} ${styles.danger}`} data-testid="billing-import-finalize">
          <h3>{t('finalizeTitle')}</h3>
          <p>{t('finalizeHelp', { n: String(b.importCount) })}</p>
          {!canFinalize ? <p className={styles.meta}>{unsaved.length || b.undecidedCount ? t('finalizeNeedsDecisions') : t('finalizeNothing')}</p> : null}
          <div className={styles.row}><button type="button" className={styles.primary} disabled={p.locked || !canFinalize} onClick={p.onFinalize}>{t('finalizeConfirm', { n: String(b.importCount) })}</button></div>
        </div> : null}
      </>}
  </article>;
}

/** Pure view. Imports, rows and decisions come only from the school's reads; nothing shows before the shell verifies the school. */
export function BillingImportView(p: BillingImportViewProps): React.ReactElement {
  const t: T = (key, vars) => billingImportText(p.language, key, vars);
  const notice = p.waiting ? t('waiting') : p.concealed ? t('concealed') : !p.hasSchool ? t('noSchool') : null;
  const allowed = p.list.state === 'READY';
  return <section className={styles.page} aria-labelledby="billing-import-title" data-hon-native="" data-testid="billing-import">
    <header className={styles.head}>
      <div><h1 id="billing-import-title">{t('title')}</h1><p className={styles.intro}>{t('intro')}</p></div>
      {notice === null && p.onRefresh ? <button type="button" className={styles.secondary} onClick={p.onRefresh} disabled={p.locked}>{t('refresh')}</button> : null}
    </header>
    {notice ? <p className={styles.notice} role="status">{notice}</p> : <>
      {p.outcome ? <div className={styles.notice} role="status" data-testid="billing-import-outcome" data-kind={p.outcome.kind}>
        <p>{p.outcome.kind === 'SENDING' ? t('sending') : p.outcome.kind === 'DONE' ? t(`done_${p.outcome.action}`) : t(`e_${p.outcome.kind}`)}</p>
        {p.canRetry && p.onTryAgain ? <button type="button" className={styles.primary} onClick={p.onTryAgain}>{t('tryAgain')}</button> : null}</div> : null}
      {p.selected ? <Review p={p} t={t}/> : <>
        {allowed ? <Upload p={p} t={t}/> : null}
        <Recent p={p} t={t}/>
      </>}
    </>}
  </section>;
}
