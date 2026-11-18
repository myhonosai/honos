'use client';
import React, { useCallback, useEffect, useId, useState } from 'react';
import { faceCheckInSignerNameOk, type FamilyFaceCheckInChild, type FamilyFaceCheckInRead } from '@hon/contracts';
import { useLocale } from '../localization/provider';
import { faceLanguage, faceText, type FaceKey } from './copy';
import { OutcomeLine } from './settings';
import { useFaceCommands, type FaceOutcome } from './commands';
import { FaceError, familyFaceApi, type FamilyFaceApi } from './http';
import base from '../attendance-cards/cards.module.css';
import styles from './face.module.css';

export type FamilyState = Readonly<{ state: 'LOADING' | 'DENIED' | 'UNAVAILABLE' }> | Readonly<{ state: 'READY'; read: FamilyFaceCheckInRead }>;
export type SignDraft = Readonly<{ studentProfileId: string; read: boolean; signerName: string }>;

/** A child can be signed for when the school is on and there is no current consent; withdrawn when one is on file. */
export function childActions(read: FamilyFaceCheckInRead, c: FamilyFaceCheckInChild): Readonly<{ sign: boolean; withdraw: boolean }> {
  const state = c.consent?.state ?? null;
  return { sign: read.canSign && (state === null || state === 'WITHDRAWN' || state === 'RENEW'), withdraw: read.canWithdraw && (state === 'GIVEN' || state === 'RENEW') };
}
const day = (iso: string, language: string) => new Date(iso).toLocaleDateString(language, { year: 'numeric', month: 'long', day: 'numeric' });

export type FamilyViewProps = Readonly<{
  language: string; state: FamilyState; formLanguage: string; draft: SignDraft | null; confirmWithdraw: string | null; outcome: FaceOutcome; busy: boolean;
  onFormLanguage?: ((l: string) => void) | undefined; onDraft?: ((d: SignDraft | null) => void) | undefined; onSign?: (() => void) | undefined;
  onAskWithdraw?: ((studentProfileId: string | null) => void) | undefined; onWithdraw?: (() => void) | undefined; onReload?: (() => void) | undefined;
  onTryAgain?: (() => void) | undefined; onStop?: (() => void) | undefined;
}>;

/** Pure view of the parent portal's face check-in consent page. */
export function FamilyFaceCheckInView(p: FamilyViewProps): React.ReactElement {
  const t = (key: FaceKey, vars?: Record<string, string>) => faceText(p.language, key, vars);
  const id = useId();
  const head = <header><h1 id={`${id}-title`}>{t('famTitle')}</h1><p className={base.intro}>{t('famIntro')}</p></header>;
  if (p.state.state !== 'READY') {
    return <section className={base.page} aria-labelledby={`${id}-title`} data-testid="face-family">{head}
      <p className={base.meta} role="status">{t(p.state.state === 'LOADING' ? 'loading' : p.state.state === 'DENIED' ? 'famDenied' : 'famUnavailable')}</p>
      {p.state.state === 'UNAVAILABLE' && p.onReload ? <div className={base.actions}><button type="button" className={base.secondary} onClick={p.onReload}>{t('reload')}</button></div> : null}
    </section>;
  }
  const r = p.state.read;
  const form = r.forms.find(f => f.language === faceLanguage(p.formLanguage)) ?? r.forms[0] ?? null;
  return <section className={base.page} aria-labelledby={`${id}-title`} data-testid="face-family" data-school={r.schoolStatus}>
    {head}
    <OutcomeLine language={p.language} outcome={p.outcome} onTryAgain={p.onTryAgain} onStop={p.onStop}/>
    {r.program === 'CLOSED' ? <p className={base.meta} role="status">{t('famClosed')}</p>
      : r.schoolStatus === 'OFF' ? <p className={base.meta} role="status">{t('famOff')}</p> : null}
    {r.schoolStatus === 'ON' && !r.canSign ? <p className={base.meta}>{t('famViewer')}</p> : null}
    {form ? <div className={base.panel} data-testid="face-family-form">
      <h2>{t('readForm')} <span className={styles.badge}>{t('draft')}</span></h2>
      <div className={base.field}><label htmlFor={`${id}-lang`}>{t('formLanguage')}</label>
        <select id={`${id}-lang`} value={form.language} onChange={e => p.onFormLanguage?.(e.currentTarget.value)}>
          {r.forms.map(f => <option key={f.formId} value={f.language}>{t(f.language)}</option>)}
        </select></div>
      <h3 lang={form.language}>{form.title}</h3>
      <pre className={styles.formBody} lang={form.language}>{form.body}</pre>
    </div> : null}
    {r.children.map(c => {
      const a = childActions(r, c), name = `${c.givenName} ${c.familyName}`, consent = c.consent;
      const drafting = p.draft?.studentProfileId === c.studentProfileId ? p.draft : null;
      return <div key={c.studentProfileId} className={styles.child} data-testid="face-child" data-consent={consent?.state ?? 'NONE'}>
        <h2>{name}</h2>
        <p>{consent?.state === 'GIVEN' ? t('signedOn', { how: t(consent.method), date: day(consent.signedAt, p.language) })
          : consent?.state === 'RENEW' ? t('renewNote')
          : consent?.state === 'WITHDRAWN' && consent.withdrawnAt ? t('withdrawnOn', { date: day(consent.withdrawnAt, p.language) }) : t('notSigned')}</p>
        {c.enrolled ? <p className={base.meta}>{t('setUp')}</p> : null}
        {a.sign && form && !drafting ? <div className={base.actions}><button type="button" className={base.primary} disabled={p.busy}
          onClick={() => p.onDraft?.({ studentProfileId: c.studentProfileId, read: false, signerName: '' })}>{t('signFor', { name })}</button></div> : null}
        {drafting && form ? <div className={styles.dialog} data-testid="face-sign">
          <label className={styles.check}><input type="checkbox" checked={drafting.read} onChange={e => p.onDraft?.({ ...drafting, read: e.currentTarget.checked })}/>{t('iHaveRead')}</label>
          <div className={base.field}><label htmlFor={`${id}-${c.studentProfileId}-name`}>{t('typeName')}</label>
            <input id={`${id}-${c.studentProfileId}-name`} value={drafting.signerName} maxLength={200} autoComplete="name" onChange={e => p.onDraft?.({ ...drafting, signerName: e.currentTarget.value })}/></div>
          <div className={base.actions}>
            <button type="button" className={base.primary} disabled={p.busy || !drafting.read || !faceCheckInSignerNameOk(drafting.signerName.trim())} onClick={p.onSign}>{t('signFor', { name })}</button>
            <button type="button" className={base.secondary} onClick={() => p.onDraft?.(null)}>{t('cancel')}</button></div>
        </div> : null}
        {a.withdraw ? p.confirmWithdraw === c.studentProfileId ? <div className={styles.dialog} role="alertdialog" aria-label={t('withdraw')}>
          <p>{t('famWithdrawAsk', { name })}</p>
          <div className={base.actions}><button type="button" className={base.primary} disabled={p.busy} onClick={p.onWithdraw}>{t('withdrawYes')}</button>
            <button type="button" className={base.secondary} onClick={() => p.onAskWithdraw?.(null)}>{t('cancel')}</button></div>
        </div> : <div className={base.actions}><button type="button" className={base.secondary} disabled={p.busy} onClick={() => p.onAskWithdraw?.(c.studentProfileId)}>{t('withdraw')}</button></div> : null}
      </div>;
    })}
  </section>;
}

/** The parent portal page. It names no family, school or child: the server uses the parent's one live family grant. */
export function FamilyFaceCheckIn({ api = familyFaceApi }: { api?: FamilyFaceApi }): React.ReactElement {
  const { preferences } = useLocale();
  const language = preferences.language;
  const [state, setState] = useState<FamilyState>({ state: 'LOADING' });
  const [generation, setGeneration] = useState(0);
  const [formLanguage, setFormLanguage] = useState<string>(language);
  const [draft, setDraft] = useState<SignDraft | null>(null);
  const [confirmWithdraw, setConfirmWithdraw] = useState<string | null>(null);
  const reload = useCallback(() => setGeneration(g => g + 1), []);
  const commands = useFaceCommands(language, reload);
  useEffect(() => {
    let live = true; const abort = new AbortController();
    api.read(abort.signal, () => live).then(read => { if (live) setState({ state: 'READY', read }); },
      error => { if (live && !abort.signal.aborted) setState({ state: error instanceof FaceError && error.kind === 'DENIED' ? 'DENIED' : 'UNAVAILABLE' }); });
    return () => { live = false; abort.abort(); };
  }, [api, generation]);

  const read = state.state === 'READY' ? state.read : null;
  const sign = () => {
    if (!read || !draft || !draft.read) return;
    const form = read.forms.find(f => f.language === faceLanguage(formLanguage)) ?? read.forms[0];
    if (!form) return;
    const input = { studentProfileId: draft.studentProfileId, formId: form.formId, formDigest: form.digest, signerName: draft.signerName.trim() };
    if (commands.start(async (key, signal, owned) => { await api.sign(input, key, signal, owned); return faceText(language, 'famSaved'); })) setDraft(null);
  };
  const withdraw = () => {
    const c = read?.children.find(x => x.studentProfileId === confirmWithdraw)?.consent;
    if (!c) return;
    if (commands.start(async (key, signal, owned) => { await api.withdraw(c.consentId, c.version, key, signal, owned); return faceText(language, 'famWithdrawn'); })) setConfirmWithdraw(null);
  };
  return <FamilyFaceCheckInView language={language} state={state} formLanguage={formLanguage} draft={draft} confirmWithdraw={confirmWithdraw}
    outcome={commands.outcome} busy={commands.busy} onFormLanguage={setFormLanguage} onDraft={d => { setConfirmWithdraw(null); setDraft(d); }} onSign={sign}
    onAskWithdraw={sid => { setDraft(null); setConfirmWithdraw(sid); }} onWithdraw={withdraw} onReload={reload} onTryAgain={commands.tryAgain} onStop={commands.stop}/>;
}
