'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  MEMBERSHIP_AGREEMENT_LANGUAGES, MEMBERSHIP_AGREEMENT_TEXT_CONFIRMATION, type MembershipAgreementLanguage, type MembershipAgreementTemplate,
  type SaveMembershipAgreementInput,
} from '@hon/contracts';
import { useLocale } from '../localization/provider';
import { useSchoolShell } from '../school-shell/context';
import { agreementText, type AgreementKey } from './copy';
import { AgreementError, prepareAgreementSave, readAgreementTemplate, sendAgreementSave, type AgreementRequest, type SchoolScope } from './http';
import styles from './agreement.module.css';

/**
 * The school's membership agreement (0410), on the Membership pages. English is required, Korean and Spanish optional. Each save
 * is a new version; links already sent keep the wording they were sent with. The owner also chooses whether a membership may
 * start only once its agreement is signed. Nothing here sends anything.
 */
export type AgreementForm = Readonly<{ texts: Readonly<Record<MembershipAgreementLanguage, { title: string; body: string }>>; signatureRequired: boolean; checked: boolean }>;
export type EditorLoad = Readonly<{ kind: 'NO_SCHOOL' | 'LOADING' | 'UNAVAILABLE' | 'DENIED' }> | Readonly<{ kind: 'READY'; template: MembershipAgreementTemplate }>;

const blank = { title: '', body: '' };
export function formFrom(template: MembershipAgreementTemplate): AgreementForm {
  const t = (template.texts ?? {}) as Partial<Record<MembershipAgreementLanguage, { title: string; body: string }>>;
  return { texts: { en: t.en ?? blank, ko: t.ko ?? blank, es: t.es ?? blank }, signatureRequired: template.texts ? template.signatureRequired : true, checked: false };
}
/** The exact save for this form, or what is still missing. A language with both fields empty is left out. */
export function saveInput(form: AgreementForm, expectedVersion: number | null): SaveMembershipAgreementInput | Readonly<{ problem: AgreementKey; language?: MembershipAgreementLanguage }> {
  const texts: Partial<Record<MembershipAgreementLanguage, { title: string; body: string }>> = {};
  for (const language of MEMBERSHIP_AGREEMENT_LANGUAGES) {
    const title = form.texts[language].title.trim(), body = form.texts[language].body;
    if (!title && !body.trim()) { if (language === 'en') return { problem: 'e_EN_REQUIRED' }; continue; }
    if (!title || !body.trim()) return language === 'en' ? { problem: 'e_EN_REQUIRED' } : { problem: 'e_BOTH', language };
    texts[language] = { title, body };
  }
  if (!form.checked) return { problem: 'e_UNCHECKED' };
  return { expectedVersion, texts: texts as SaveMembershipAgreementInput['texts'], signatureRequired: form.signatureRequired, confirmation: MEMBERSHIP_AGREEMENT_TEXT_CONFIRMATION };
}
function problemOf(error: unknown): AgreementKey {
  if (!(error instanceof AgreementError)) return 'e_UNKNOWN';
  return error.problem === 'STALE' ? 'e_STALE' : error.problem === 'DENIED' ? 'e_DENIED' : error.problem === 'SESSION' ? 'e_SESSION'
    : error.problem === 'UNKNOWN' ? 'e_UNKNOWN' : 'e_REFUSED';
}
const day = (language: string, value: string) => new Date(value).toLocaleDateString(language, { dateStyle: 'medium' });

export type AgreementEditorViewProps = Readonly<{
  language: string; load: EditorLoad; form: AgreementForm; notice: Readonly<{ key: AgreementKey; vars?: Record<string, string | number> }> | null; busy: boolean; canRetry: boolean;
  onForm?: ((form: AgreementForm) => void) | undefined; onSave?: (() => void) | undefined; onRetry?: (() => void) | undefined; onReload?: (() => void) | undefined;
}>;

export function AgreementEditorView(p: AgreementEditorViewProps): React.ReactElement {
  const t = (key: AgreementKey, vars?: Record<string, string | number>) => agreementText(p.language, key, vars);
  const head = <header><h1>{t('editorTitle')}</h1><p className={styles.meta}>{t('editorIntro')}</p></header>;
  const l = p.load;
  if (l.kind !== 'READY') return <main className={styles.page} data-testid="agreement-editor">{head}
    <p className={styles.notice} role="status" data-kind={l.kind}>{l.kind === 'NO_SCHOOL' ? t('chooseSchool') : l.kind === 'LOADING' ? t('editorLoading')
      : l.kind === 'DENIED' ? t('editorDenied') : t('unavailable')}</p>
    {l.kind === 'UNAVAILABLE' && p.onReload ? <button type="button" className={styles.secondary} onClick={p.onReload}>{t('tryAgain')}</button> : null}</main>;
  const v = l.template, set = (language: MembershipAgreementLanguage, field: 'title' | 'body', value: string) =>
    p.onForm?.({ ...p.form, checked: false, texts: { ...p.form.texts, [language]: { ...p.form.texts[language], [field]: value } } });
  return <main className={styles.page} data-testid="agreement-editor">{head}
    <p className={styles.meta} data-testid="agreement-version">{v.textVersion ? t('version', { n: v.textVersion, date: day(p.language, v.updatedAt!) }) : t('noVersion')}</p>
    <fieldset disabled={p.busy} style={{ display: 'grid', gap: 16, border: 0, padding: 0, margin: 0 }}>
      {MEMBERSHIP_AGREEMENT_LANGUAGES.map(language => <section key={language} className={styles.card} aria-label={t(`language_${language}`)}>
        <h2>{t(`language_${language}`)}</h2>
        <label className={styles.field}>{t('title')}<input maxLength={200} value={p.form.texts[language].title} data-testid={`agreement-title-${language}`}
          lang={language} onChange={e => set(language, 'title', e.target.value)}/></label>
        <label className={styles.field}>{t('body')}<textarea maxLength={20000} value={p.form.texts[language].body} data-testid={`agreement-body-${language}`}
          lang={language} onChange={e => set(language, 'body', e.target.value)}/></label>
      </section>)}
      <section className={styles.card}>
        <label className={styles.check}><input type="checkbox" checked={p.form.signatureRequired} data-testid="agreement-required"
          onChange={e => p.onForm?.({ ...p.form, checked: false, signatureRequired: e.target.checked })}/>{t('requireSignature')}</label>
        <p className={styles.meta}>{t('requireHelp')}</p>
        <label className={styles.check}><input type="checkbox" checked={p.form.checked} data-testid="agreement-confirm"
          onChange={e => p.onForm?.({ ...p.form, checked: e.target.checked })}/>{t('saveConfirm')}</label>
      </section>
    </fieldset>
    {p.notice ? <div className={styles.notice} role="status" data-testid="agreement-notice"><p>{t(p.notice.key, p.notice.vars)}</p>
      {p.canRetry && p.onRetry ? <button type="button" className={styles.primary} onClick={p.onRetry} disabled={p.busy}>{t('tryAgain')}</button> : null}</div> : null}
    <div className={styles.row}><button type="button" className={styles.primary} data-testid="agreement-save" disabled={p.busy || !p.form.checked} onClick={p.onSave}>
      {p.busy ? t('saving') : t('save')}</button></div>
  </main>;
}

export type AgreementEditorApi = Readonly<{ read: typeof readAgreementTemplate; save: typeof sendAgreementSave }>;
const defaultApi: AgreementEditorApi = { read: readAgreementTemplate, save: sendAgreementSave };

/** Controller: reads the current version for the shell's school, saves one new version. An unknown outcome resends the identical request. */
export function AgreementEditor({ api = defaultApi, scope: fixedScope, language: fixedLanguage }: { api?: AgreementEditorApi; scope?: SchoolScope; language?: string }): React.ReactElement {
  const { preferences } = useLocale(), shell = useSchoolShell();
  const language = fixedLanguage ?? preferences.language;
  const organizationId = fixedScope?.organizationId ?? shell.selection?.organizationId ?? null, schoolId = fixedScope?.schoolId ?? shell.selection?.schoolId ?? null;
  const [load, setLoad] = useState<EditorLoad>({ kind: 'LOADING' });
  const [form, setForm] = useState<AgreementForm>(formFrom({ textVersion: null, signatureRequired: true, texts: null, updatedAt: null }));
  const [notice, setNotice] = useState<AgreementEditorViewProps['notice']>(null), [busy, setBusy] = useState(false), [reads, setReads] = useState(0);
  const kept = useRef<AgreementRequest | null>(null), mounted = useRef(true), keepForm = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; kept.current = null; }; }, []);
  useEffect(() => {
    if (!organizationId || !schoolId) { setLoad({ kind: 'NO_SCHOOL' }); return; }
    const abort = new AbortController();
    setLoad({ kind: 'LOADING' });
    api.read({ organizationId, schoolId }, abort.signal).then(template => {
      if (abort.signal.aborted) return;
      setLoad({ kind: 'READY', template });
      if (!keepForm.current) setForm(formFrom(template));
      keepForm.current = false;
    }, error => {
      if (!abort.signal.aborted) setLoad({ kind: error instanceof AgreementError && (error.problem === 'DENIED' || error.problem === 'SESSION') ? 'DENIED' : 'UNAVAILABLE' });
    });
    return () => { abort.abort(); };
  }, [api, organizationId, schoolId, reads]);

  const send = useCallback(async (request: AgreementRequest) => {
    setBusy(true); setNotice(null);
    try {
      const saved = await api.save(request);
      kept.current = null;
      if (!mounted.current) return;
      setLoad({ kind: 'READY', template: saved }); setForm(formFrom(saved));
      setNotice({ key: 'saved', vars: { n: saved.textVersion ?? '' } });
    } catch (error) {
      const key = problemOf(error);
      kept.current = key === 'e_UNKNOWN' ? request : null;
      if (!mounted.current) return;
      setNotice({ key });
      // A newer version: show it, but keep what this person typed so nothing is lost.
      if (key === 'e_STALE') { keepForm.current = true; setForm(prior => ({ ...prior, checked: false })); setReads(n => n + 1); }
    } finally { if (mounted.current) setBusy(false); }
  }, [api]);
  const onSave = useCallback(() => {
    if (busy || kept.current || load.kind !== 'READY' || !organizationId || !schoolId) return;
    const input = saveInput(form, load.template.textVersion);
    if ('problem' in input) { setNotice({ key: input.problem, vars: input.language ? { language: agreementText(language, `language_${input.language}`) } : {} }); return; }
    let request: AgreementRequest;
    try { request = prepareAgreementSave({ organizationId, schoolId }, input, globalThis.crypto.randomUUID()); } catch { setNotice({ key: 'e_REFUSED' }); return; }
    void send(request);
  }, [busy, load, form, organizationId, schoolId, language, send]);
  const onRetry = useCallback(() => { if (kept.current && !busy) void send(kept.current); }, [busy, send]);
  const onForm = useCallback((next: AgreementForm) => { if (!kept.current) { setForm(next); setNotice(null); } }, []);
  return <AgreementEditorView language={language} load={load} form={form} notice={notice} busy={busy} canRetry={kept.current !== null}
    onForm={onForm} onSave={onSave} onRetry={onRetry} onReload={() => setReads(n => n + 1)}/>;
}
