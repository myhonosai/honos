'use client';
import React, { useCallback, useEffect, useId, useState } from 'react';
import {
  faceCheckInSignerNameOk, type BiometricAddOn, type FaceCheckInAcknowledgement, type FaceCheckInChoice, type FaceCheckInForm, type FaceCheckInRead,
  type FaceCheckInStudent,
} from '@hon/contracts';
import { useLocale } from '../localization/provider';
import { useSchoolShell } from '../school-shell/context';
import { FaceCheckInNoticeView as AddressNotice } from '../school-location/notice';
import { faceLanguage, faceText, type FaceKey } from './copy';
import { useFaceCommands, type FaceOutcome } from './commands';
import { FaceError, faceApi, type FaceApi } from './http';
import base from '../attendance-cards/cards.module.css';
import styles from './face.module.css';

export type FaceReadState = Readonly<{ state: 'LOADING' | 'DENIED' | 'UNAVAILABLE' | 'NO_SCHOOL' }> | Readonly<{ state: 'READY'; read: FaceCheckInRead }>;
export type PaperDraft = Readonly<{ studentProfileId: string; formId: number; signerName: string; witnessed: boolean }>;
export type Confirm = null | Readonly<{ kind: 'TURN_OFF' }> | Readonly<{ kind: 'WITHDRAW'; studentProfileId: string }>;

/** The city-limits answer to use: the only one when there is no question, else the one picked. */
export function chosenAnswer(choices: readonly FaceCheckInChoice[], picked: string | null | undefined): FaceCheckInChoice | null {
  if (choices.length === 1 && choices[0]!.cityLimits === null) return choices[0]!;
  return picked === undefined ? null : choices.find(c => c.cityLimits === picked) ?? null;
}
/** Turning on is possible only in test mode, at an available location, with every step it needs confirmed. */
export function canTurnOn(read: FaceCheckInRead, choice: FaceCheckInChoice | null, acks: ReadonlySet<FaceCheckInAcknowledgement>): boolean {
  return read.program === 'TEST_MODE' && read.settings.status === 'OFF' && choice !== null && choice.status === 'AVAILABLE_WITH_CONSENT'
    && choice.acknowledgements.every(a => acks.has(a));
}
/** What a student row offers once face check-in is on. */
export function studentActions(s: FaceCheckInStudent): Readonly<{ record: boolean; withdraw: boolean; enroll: 'DONE' | 'READY' | 'NEEDS_CONSENT' | 'NEEDS_PHOTO' }> {
  const state = s.consent?.state ?? null;
  return { record: state === null || state === 'WITHDRAWN' || state === 'RENEW', withdraw: state === 'GIVEN' || state === 'RENEW',
    enroll: s.enrolled ? 'DONE' : state !== 'GIVEN' ? 'NEEDS_CONSENT' : !s.hasPhoto ? 'NEEDS_PHOTO' : 'READY' };
}
const formFor = (forms: readonly FaceCheckInForm[], language: string) => forms.find(f => f.language === faceLanguage(language)) ?? forms[0] ?? null;
const nameOf = (s: { givenName: string; familyName: string }) => `${s.givenName} ${s.familyName}`;

export type FaceSettingsViewProps = Readonly<{
  language: string; state: FaceReadState; picked: string | null | undefined; acks: ReadonlySet<FaceCheckInAcknowledgement>; formLanguage: string;
  paper: PaperDraft | null; confirm: Confirm; outcome: FaceOutcome; busy: boolean;
  onPick?: ((cityLimits: string | null) => void) | undefined; onAck?: ((a: FaceCheckInAcknowledgement, on: boolean) => void) | undefined;
  onTurnOn?: (() => void) | undefined; onAskTurnOff?: (() => void) | undefined; onConfirm?: (() => void) | undefined; onCancelConfirm?: (() => void) | undefined;
  onFormLanguage?: ((l: string) => void) | undefined; onOpenPaper?: ((studentProfileId: string) => void) | undefined; onPaper?: ((d: PaperDraft) => void) | undefined;
  onSavePaper?: (() => void) | undefined; onClosePaper?: (() => void) | undefined; onAskWithdraw?: ((studentProfileId: string) => void) | undefined;
  onEnroll?: ((studentProfileId: string) => void) | undefined; onReload?: (() => void) | undefined; onTryAgain?: (() => void) | undefined; onStop?: (() => void) | undefined;
}>;

export function OutcomeLine({ language, outcome, onTryAgain, onStop }: { language: string; outcome: FaceOutcome; onTryAgain?: (() => void) | undefined; onStop?: (() => void) | undefined }) {
  if (!outcome) return null;
  return <div className={base.outcome} role="status" aria-live="polite" data-testid="face-outcome" data-tone={outcome.tone}>
    <p>{outcome.text}</p>
    {outcome.canRetry ? <div className={base.actions}>
      {onTryAgain ? <button type="button" className={base.primary} onClick={onTryAgain}>{faceText(language, 'tryAgain')}</button> : null}
      {onStop ? <button type="button" className={base.secondary} onClick={onStop}>{faceText(language, 'stop')}</button> : null}
    </div> : null}
  </div>;
}

/** Pure view of the school's face check-in settings. */
export function FaceSettingsView(p: FaceSettingsViewProps): React.ReactElement {
  const t = (key: FaceKey, vars?: Record<string, string | number>) => faceText(p.language, key, vars);
  const id = useId();
  const head = <header><h1 id={`${id}-title`}>{t('title')}</h1><p className={base.intro}>{t('intro')}</p></header>;
  if (p.state.state !== 'READY') {
    const key: FaceKey = p.state.state === 'LOADING' ? 'loading' : p.state.state === 'NO_SCHOOL' ? 'noSchool' : p.state.state === 'DENIED' ? 'denied' : 'unavailable';
    return <section className={base.page} aria-labelledby={`${id}-title`} data-testid="face-settings">{head}
      <p className={base.meta} role="status">{t(key)}</p>
      {p.state.state === 'UNAVAILABLE' && p.onReload ? <div className={base.actions}><button type="button" className={base.secondary} onClick={p.onReload}>{t('reload')}</button></div> : null}
    </section>;
  }
  const r = p.state.read, on = r.settings.status === 'ON';
  const choice = chosenAnswer(r.choices, p.picked);
  const question = r.choices.length > 1 || (r.choices.length === 1 && r.choices[0]!.cityLimits !== null);
  const form = formFor(r.forms, p.formLanguage);
  const notice = { ...r.addressNotice, laws: [...r.addressNotice.laws], addOns: [...r.addressNotice.addOns] as BiometricAddOn[] } as Parameters<typeof AddressNotice>[0]['notice'];
  const paperStudent = p.paper ? r.students.find(s => s.studentProfileId === p.paper!.studentProfileId) ?? null : null;
  const withdrawStudent = p.confirm?.kind === 'WITHDRAW' ? r.students.find(s => s.studentProfileId === (p.confirm as { studentProfileId: string }).studentProfileId) ?? null : null;
  const paperForm = p.paper ? r.forms.find(f => f.formId === p.paper!.formId) ?? null : null;

  return <section className={base.page} aria-labelledby={`${id}-title`} data-testid="face-settings" data-status={r.settings.status} data-program={r.program}>
    {head}
    <p className={base.meta} data-testid="face-program">{t(r.program === 'TEST_MODE' ? 'programTest' : 'programClosed')}</p>
    <OutcomeLine language={p.language} outcome={p.outcome} onTryAgain={p.onTryAgain} onStop={p.onStop}/>

    <div className={base.panel}>
      <p><strong>{t('statusLabel')}:</strong> <span data-testid="face-status">{t(r.settings.status)}</span></p>
      {!on && r.settings.offReason === 'LOCATION_CHANGED' ? <p className={base.meta}>{t('offLocation')}</p> : null}
      {!on ? <AddressNotice notice={notice} language={p.language} className={base.meta}/> : null}
      {r.choices.length === 0 ? <p className={base.meta}>{t('noAddress')} <a href="/staff/settings/location">{t('locationLink')}</a></p> : null}

      {!on && r.choices.length > 0 ? <div className={base.form}>
        {question ? <fieldset data-testid="face-city"><legend>{t('cityLegend')}</legend>
          {r.choices.map(c => <label key={c.cityLimits ?? 'ONLY'} className={base.choice}>
            <input type="radio" name={`${id}-city`} checked={p.picked !== undefined && p.picked === c.cityLimits} disabled={p.busy} onChange={() => p.onPick?.(c.cityLimits)}/>
            {c.cityLimits && Object.prototype.hasOwnProperty.call({ NONE: 1, US_NYC: 1, US_PORTLAND_BAN: 1 }, c.cityLimits) ? t(c.cityLimits as FaceKey) : c.cityLimits}
          </label>)}
        </fieldset> : null}
        {choice && choice.status !== 'AVAILABLE_WITH_CONSENT' ? <p className={base.meta} data-testid="face-choice-status">{t(choice.status as FaceKey)}</p> : null}
        {choice && choice.status === 'AVAILABLE_WITH_CONSENT' && choice.acknowledgements.length > 0 ? <fieldset data-testid="face-acks"><legend>{t('ackLegend')}</legend>
          {choice.acknowledgements.map(a => <label key={a} className={styles.check}>
            <input type="checkbox" checked={p.acks.has(a)} disabled={p.busy} onChange={e => p.onAck?.(a, e.currentTarget.checked)}/>{t(a)}</label>)}
        </fieldset> : null}
        <div className={base.actions}>
          <button type="button" className={base.primary} disabled={p.busy || !canTurnOn(r, choice, p.acks)} onClick={p.onTurnOn} data-testid="face-turn-on">{t('turnOn')}</button>
        </div>
      </div> : null}

      {on ? <div className={base.actions}>
        <button type="button" className={base.secondary} disabled={p.busy} onClick={p.onAskTurnOff} data-testid="face-turn-off">{t('turnOff')}</button>
      </div> : null}
      {p.confirm?.kind === 'TURN_OFF' ? <div className={styles.dialog} role="alertdialog" aria-label={t('turnOff')}>
        <p>{t('turnOffAsk')}</p>
        <div className={base.actions}><button type="button" className={base.primary} disabled={p.busy} onClick={p.onConfirm}>{t('turnOffYes')}</button>
          <button type="button" className={base.secondary} onClick={p.onCancelConfirm}>{t('keepOn')}</button></div>
      </div> : null}
      <p className={base.meta}>{t('deletions', { n: r.deletionsLast30Days })}</p>
    </div>

    {on && form ? <div className={base.panel} data-testid="face-form">
      <h2>{t('formTitle')} <span className={styles.badge}>{t('draft')}</span></h2>
      <div className={base.field}><label htmlFor={`${id}-lang`}>{t('formLanguage')}</label>
        <select id={`${id}-lang`} value={form.language} onChange={e => p.onFormLanguage?.(e.currentTarget.value)}>
          {r.forms.map(f => <option key={f.formId} value={f.language}>{t(f.language)}</option>)}
        </select></div>
      <h3 lang={form.language}>{form.title}</h3>
      <pre className={styles.formBody} lang={form.language}>{form.body}</pre>
    </div> : null}

    <div className={base.panel}>
      <h2>{t('studentsTitle')}</h2>
      {!on ? <p className={base.meta}>{t('turnOnFirst')}</p> : null}
      {p.confirm?.kind === 'WITHDRAW' && withdrawStudent ? <div className={styles.dialog} role="alertdialog" aria-label={t('withdraw')}>
        <p>{t('withdrawAsk', { name: nameOf(withdrawStudent) })}</p>
        <div className={base.actions}><button type="button" className={base.primary} disabled={p.busy} onClick={p.onConfirm}>{t('withdrawYes')}</button>
          <button type="button" className={base.secondary} onClick={p.onCancelConfirm}>{t('cancel')}</button></div>
      </div> : null}
      {p.paper && paperStudent && paperForm ? <div className={styles.dialog} role="dialog" aria-labelledby={`${id}-paper`} data-testid="face-paper">
        <h3 id={`${id}-paper`}>{t('paperTitle', { name: nameOf(paperStudent) })}</h3>
        <p className={base.meta}>{t('signerKind')}: <strong>{t(paperStudent.adult ? 'ADULT_STUDENT' : 'GUARDIAN')}</strong></p>
        <div className={base.field}><label htmlFor={`${id}-plang`}>{t('formLanguage')}</label>
          <select id={`${id}-plang`} value={p.paper.formId} onChange={e => p.onPaper?.({ ...p.paper!, formId: Number(e.currentTarget.value) })}>
            {r.forms.map(f => <option key={f.formId} value={f.formId}>{t(f.language)}</option>)}
          </select></div>
        <div className={base.field}><label htmlFor={`${id}-pname`}>{t('signerName')}</label>
          <input id={`${id}-pname`} value={p.paper.signerName} maxLength={200} autoComplete="off" onChange={e => p.onPaper?.({ ...p.paper!, signerName: e.currentTarget.value })}/>
          <small className={base.meta}>{t('signerNameHelp')}</small></div>
        <label className={styles.check}><input type="checkbox" checked={p.paper.witnessed} onChange={e => p.onPaper?.({ ...p.paper!, witnessed: e.currentTarget.checked })}/>{t('witness')}</label>
        <div className={base.actions}>
          <button type="button" className={base.primary} disabled={p.busy || !p.paper.witnessed || !faceCheckInSignerNameOk(p.paper.signerName.trim())} onClick={p.onSavePaper}>{t('saveConsent')}</button>
          <button type="button" className={base.secondary} onClick={p.onClosePaper}>{t('cancel')}</button></div>
      </div> : null}
      <div className={base.tableWrap}><table className={base.table}>
        <thead><tr><th>{t('colName')}</th><th>{t('colConsent')}</th><th>{t('colPhoto')}</th><th>{t('colFace')}</th></tr></thead>
        <tbody>{r.students.map(s => {
          const a = studentActions(s), c = s.consent;
          return <tr key={s.studentProfileId} data-testid="face-student" data-student={s.studentProfileId} data-consent={c?.state ?? 'NONE'} data-enrolled={String(s.enrolled)}>
            <td>{nameOf(s)}{s.adult ? <> <small className={base.meta}>({t('adult')})</small></> : null}</td>
            <td>{c ? `${t(c.state)} (${t(c.method)})` : t('notSigned')}
              {on ? <div className={base.actions}>
                {a.record ? <button type="button" className={base.secondary} disabled={p.busy} onClick={() => p.onOpenPaper?.(s.studentProfileId)}>{t('recordPaper')}</button> : null}
                {a.withdraw ? <button type="button" className={base.secondary} disabled={p.busy} onClick={() => p.onAskWithdraw?.(s.studentProfileId)}>{t('withdraw')}</button> : null}
              </div> : null}</td>
            <td>{t(s.hasPhoto ? 'hasPhoto' : 'noPhoto')}</td>
            <td>{a.enroll === 'DONE' ? t('enrolled') : !on ? t('notEnrolled') : a.enroll === 'READY'
              ? <button type="button" className={base.primary} disabled={p.busy} onClick={() => p.onEnroll?.(s.studentProfileId)}>{t('enroll')}</button>
              : t(a.enroll === 'NEEDS_PHOTO' ? 'needPhoto' : 'needConsent')}</td>
          </tr>;
        })}</tbody>
      </table></div>
    </div>
  </section>;
}

/** The school's face check-in settings, consent records and set-up. Every permission is the server's. */
export function FaceCheckInSettings({ api = faceApi }: { api?: FaceApi }): React.ReactElement {
  const { preferences } = useLocale();
  const language = preferences.language;
  const shell = useSchoolShell();
  const selection = shell.phase === 'READY' ? shell.selection : null;
  const schoolId = selection?.schoolId ?? null;
  const [state, setState] = useState<FaceReadState>({ state: 'LOADING' });
  const [generation, setGeneration] = useState(0);
  const [picked, setPicked] = useState<string | null | undefined>(undefined);
  const [acks, setAcks] = useState<ReadonlySet<FaceCheckInAcknowledgement>>(new Set());
  const [formLanguage, setFormLanguage] = useState<string>(language);
  const [paper, setPaper] = useState<PaperDraft | null>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const reload = useCallback(() => setGeneration(g => g + 1), []);
  const commands = useFaceCommands(language, reload);

  useEffect(() => {
    if (!schoolId) { setState({ state: shell.phase === 'READY' ? 'NO_SCHOOL' : 'LOADING' }); return; }
    let live = true; const abort = new AbortController();
    api.read(schoolId, abort.signal, () => live).then(read => { if (live) setState({ state: 'READY', read }); },
      error => { if (live && !abort.signal.aborted) setState({ state: error instanceof FaceError && error.kind === 'DENIED' ? 'DENIED' : 'UNAVAILABLE' }); });
    return () => { live = false; abort.abort(); };
  }, [api, schoolId, shell.phase, generation]);
  useEffect(() => { setPicked(undefined); setAcks(new Set()); setPaper(null); setConfirm(null); }, [schoolId]);

  const read = state.state === 'READY' ? state.read : null;
  const turnOn = () => {
    if (!read || !schoolId) return;
    const choice = chosenAnswer(read.choices, picked);
    if (!canTurnOn(read, choice, acks)) return;
    const input = { schoolId, expectedVersion: read.settings.version, enabled: true, cityLimits: choice!.cityLimits, acknowledgements: choice!.acknowledgements.filter(a => acks.has(a)) };
    commands.start(async (key, signal, owned) => { await api.saveSettings(input, key, signal, owned); return faceText(language, 'turnedOn'); });
  };
  const confirmed = () => {
    if (!read || !schoolId || !confirm) return;
    if (confirm.kind === 'TURN_OFF') {
      const input = { schoolId, expectedVersion: read.settings.version, enabled: false, cityLimits: null, acknowledgements: [] };
      commands.start(async (key, signal, owned) => { const out = await api.saveSettings(input, key, signal, owned); return faceText(language, 'turnedOff', { n: out.templatesDeleted }); });
    } else {
      const c = read.students.find(s => s.studentProfileId === confirm.studentProfileId)?.consent;
      if (!c) return;
      commands.start(async (key, signal, owned) => { await api.withdrawConsent(schoolId, c.consentId, c.version, key, signal, owned); return faceText(language, 'withdrawn'); });
    }
    setConfirm(null);
  };
  const savePaper = () => {
    if (!read || !schoolId || !paper) return;
    const student = read.students.find(s => s.studentProfileId === paper.studentProfileId), form = read.forms.find(f => f.formId === paper.formId);
    if (!student || !form || !paper.witnessed) return;
    const input = { schoolId, studentProfileId: student.studentProfileId, formId: form.formId, formDigest: form.digest,
      signerKind: student.adult ? 'ADULT_STUDENT' as const : 'GUARDIAN' as const, signerName: paper.signerName.trim(), witnessAttested: true as const };
    if (commands.start(async (key, signal, owned) => { await api.recordConsent(input, key, signal, owned); return faceText(language, 'consentSaved'); })) setPaper(null);
  };
  const enroll = (studentProfileId: string) => {
    if (!read || !schoolId) return;
    const student = read.students.find(s => s.studentProfileId === studentProfileId); if (!student) return;
    commands.start(async (key, signal, owned) => { await api.enroll(schoolId, studentProfileId, key, signal, owned); return faceText(language, 'enrolledOk', { name: nameOf(student) }); });
  };

  return <FaceSettingsView language={language} state={state} picked={picked} acks={acks} formLanguage={formLanguage} paper={paper} confirm={confirm}
    outcome={commands.outcome} busy={commands.busy}
    onPick={v => { setPicked(v); setAcks(new Set()); }} onAck={(a, on) => setAcks(prev => { const next = new Set(prev); if (on) next.add(a); else next.delete(a); return next; })}
    onTurnOn={turnOn} onAskTurnOff={() => setConfirm({ kind: 'TURN_OFF' })} onConfirm={confirmed} onCancelConfirm={() => setConfirm(null)}
    onFormLanguage={setFormLanguage}
    onOpenPaper={sid => { const f = read ? formFor(read.forms, language) : null; if (f) { setConfirm(null); setPaper({ studentProfileId: sid, formId: f.formId, signerName: '', witnessed: false }); } }}
    onPaper={setPaper} onSavePaper={savePaper} onClosePaper={() => setPaper(null)}
    onAskWithdraw={sid => { setPaper(null); setConfirm({ kind: 'WITHDRAW', studentProfileId: sid }); }} onEnroll={enroll}
    onReload={reload} onTryAgain={commands.tryAgain} onStop={commands.stop}/>;
}
