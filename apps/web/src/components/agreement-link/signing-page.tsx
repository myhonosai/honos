'use client';
import React, { useCallback, useEffect, useId, useState } from 'react';
import type { MembershipAgreementLanguage } from '@hon/contracts';
import { agreementLinkText, type AgreementLinkKey } from './copy';
import { publicAgreementLinkApi, type PublicAgreementLinkApi, type PublicLinkRead, type PublicLinkSign } from './http';
import styles from '../people/people.module.css';

/**
 * 0499 the family's signing page at /agreement/<token>. No account: the token is the only key. The guardian reads the
 * school's current agreement in a language it was published in, picks the children they sign for, types their full name and
 * agrees to sign electronically. Signing is optional for the school; the page never mentions payment.
 */
export type SigningState = Readonly<{ kind: 'LOADING' }> | Readonly<{ kind: 'READ'; read: PublicLinkRead }> | Readonly<{ kind: 'SIGNED' }>;
export type SigningForm = Readonly<{ language: MembershipAgreementLanguage; children: readonly string[]; name: string; esign: boolean }>;
export type SigningViewProps = Readonly<{
  uiLanguage: string; state: SigningState; form: SigningForm; busy: boolean; notice: AgreementLinkKey | null;
  onForm?: ((form: SigningForm) => void) | undefined; onSign?: (() => void) | undefined; onReload?: (() => void) | undefined;
}>;
export const nameOk = (v: string) => v.trim() === v && v.length >= 2 && v.length <= 200 && !/[<>\u0000-\u001f\u007f]/.test(v);

export function SigningView(p: SigningViewProps): React.ReactElement {
  const ui = p.form.language;
  const t = (key: AgreementLinkKey, vars?: Record<string, string>) => agreementLinkText(ui, key, vars);
  const base = useId();
  const shell = (body: React.ReactNode) => <main className={styles.people} data-testid="agreement-signing" lang={ui}>
    <article className={styles.card} aria-labelledby={`${base}-title`}><h1 id={`${base}-title`}>{t('pageTitle')}</h1>{body}</article></main>;
  const s = p.state;
  if (s.kind === 'LOADING') return shell(<p className={styles.meta} role="status">{t('pageLoading')}</p>);
  if (s.kind === 'SIGNED') return shell(<p role="status" data-kind="DONE">{t('done')}</p>);
  const r = s.read;
  if (r === 'GONE') return shell(<p role="status" data-kind="GONE">{t('pageGone')}</p>);
  if (r === 'UNAVAILABLE') return shell(<div role="status" data-kind="UNAVAILABLE"><p>{t('pageUnavailable')}</p>
    {p.onReload ? <button type="button" className={styles.secondary} onClick={p.onReload}>{t('reload')}</button> : null}</div>);
  if (r.state !== 'OPEN') return shell(<p role="status" data-kind={r.state}>{t(r.state === 'SIGNED' ? 'pageSigned' : r.state === 'EXPIRED' ? 'pageExpired' : 'pageReplaced', { school: r.schoolName })}</p>);
  if (!r.agreement) return shell(<p role="status" data-kind="NO_AGREEMENT">{t('noAgreement', { school: r.schoolName })}</p>);
  if (!r.children.length) return shell(<p role="status" data-kind="NOBODY">{t('nobody')}</p>);
  const text = r.agreement.texts.find(x => x.language === p.form.language) ?? r.agreement.texts[0]!;
  const day = new Intl.DateTimeFormat(ui, { dateStyle: 'medium' }).format(new Date(r.expiresAt));
  const ready = p.form.esign && p.form.children.length > 0 && nameOk(p.form.name);
  return shell(<>
    <p>{t('hello', { name: r.recipientGivenName, school: r.schoolName })}</p>
    <p className={styles.meta}>{t('expires', { date: day })}</p>
    {r.agreement.texts.length > 1 ? <label>{t('language')} <select value={text.language} data-testid="agreement-signing-language"
      onChange={e => p.onForm?.({ ...p.form, language: e.target.value as MembershipAgreementLanguage })}>
      {r.agreement.texts.map(x => <option key={x.language} value={x.language}>{t(`language_${x.language}` as AgreementLinkKey)}</option>)}
    </select></label> : null}
    <section lang={text.language} data-testid="agreement-signing-text"><h2>{text.title}</h2><div style={{ whiteSpace: 'pre-wrap' }}>{text.body}</div></section>
    <form className={styles.form} noValidate onSubmit={e => { e.preventDefault(); p.onSign?.(); }}>
      <fieldset disabled={p.busy}>
        <legend>{t('forWhom')}</legend>
        {r.children.map(c => <label key={c.studentProfileId} className={styles.check}>
          <input type="checkbox" checked={p.form.children.includes(c.studentProfileId)}
            onChange={e => p.onForm?.({ ...p.form, children: e.target.checked ? [...p.form.children, c.studentProfileId] : p.form.children.filter(x => x !== c.studentProfileId) })}/>
          <span>{c.givenName}</span></label>)}
      </fieldset>
      <label htmlFor={`${base}-name`}>{t('fullName')}</label>
      <input id={`${base}-name`} value={p.form.name} maxLength={200} autoComplete="name" disabled={p.busy} data-testid="agreement-signing-name"
        onChange={e => p.onForm?.({ ...p.form, name: e.target.value })}/>
      <label className={styles.check}><input type="checkbox" checked={p.form.esign} disabled={p.busy} data-testid="agreement-signing-esign"
        onChange={e => p.onForm?.({ ...p.form, esign: e.target.checked })}/><span>{t('esign')}</span></label>
      {p.notice ? <p role="status" data-testid="agreement-signing-notice">{t(p.notice)}</p> : null}
      <button type="submit" className={styles.primary} disabled={p.busy || !ready} data-testid="agreement-signing-submit">{p.busy ? t('signing') : t('signButton')}</button>
    </form>
  </>);
}

const pickLanguage = (preferred: string, available: readonly MembershipAgreementLanguage[]): MembershipAgreementLanguage => {
  const want = preferred.toLowerCase().split('-')[0] as MembershipAgreementLanguage;
  return available.includes(want) ? want : available[0] ?? 'en';
};
export function AgreementSigningPage({ token, api = publicAgreementLinkApi, preferred }: { token: string; api?: PublicAgreementLinkApi; preferred?: string }): React.ReactElement {
  const [state, setState] = useState<SigningState>({ kind: 'LOADING' });
  const [form, setForm] = useState<SigningForm>({ language: 'en', children: [], name: '', esign: false });
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState<AgreementLinkKey | null>(null), [reads, setReads] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    api.read(token, abort.signal).then(read => {
      if (abort.signal.aborted) return;
      setState({ kind: 'READ', read });
      if (typeof read === 'object' && read.state === 'OPEN') {
        const langs = read.agreement?.texts.map(x => x.language) ?? [];
        setForm(prior => ({ ...prior, language: pickLanguage(preferred ?? globalThis.navigator?.language ?? 'en', langs), children: read.children.map(c => c.studentProfileId) }));
      }
    }, () => { if (!abort.signal.aborted) setState({ kind: 'READ', read: 'UNAVAILABLE' }); });
    return () => abort.abort();
  }, [api, token, reads, preferred]);
  const onSign = useCallback(async () => {
    if (busy || state.kind !== 'READ' || typeof state.read !== 'object' || state.read.state !== 'OPEN' || !state.read.agreement) return;
    const text = state.read.agreement.texts.find(x => x.language === form.language) ?? state.read.agreement.texts[0]!;
    if (!nameOk(form.name) || !form.esign || !form.children.length) { setNotice('invalidSign'); return; }
    setBusy(true); setNotice(null);
    let result: PublicLinkSign;
    try {
      result = await api.sign(token, { versionId: state.read.agreement.versionId, language: text.language, digest: text.digest, signerName: form.name, eSignConsent: true,
        studentProfileIds: form.children }, new AbortController().signal);
    } finally { setBusy(false); }
    if (result === 'SIGNED' || result === 'ALREADY_SIGNED') { setState({ kind: 'SIGNED' }); return; }
    if (result === 'CHANGED') { setNotice('changed'); setReads(n => n + 1); return; }
    if (result === 'GONE') { setReads(n => n + 1); return; }
    setNotice(result === 'INVALID' ? 'invalidSign' : 'pageUnavailable');
  }, [api, busy, form, state, token]);
  return <SigningView uiLanguage={form.language} state={state} form={form} busy={busy} notice={notice} onForm={f => { setForm(f); setNotice(null); }}
    onSign={() => { void onSign(); }} onReload={() => setReads(n => n + 1)}/>;
}
