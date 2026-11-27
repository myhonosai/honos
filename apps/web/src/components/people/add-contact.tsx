'use client';
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { addContactText, type AddContactKey } from './add-contact-copy';
import { AddContactError, addContactApi, buildContactPlan, prepareContact, type AddContactApi, type ContactAdded, type ContactCapsule, type ContactForm, type ContactProblem, type ContactScope } from './add-contact-http';
import styles from './people.module.css';

export type AddContactSave = { state: 'IDLE' | 'SAVING' | 'DENIED' | 'REJECTED' | 'UNCERTAIN' } | { state: 'SAVED'; name: string; family: boolean }
  | { state: 'PROBLEM'; problem: ContactProblem } | { state: 'PARTIAL'; name: string; denied: boolean };
const EMPTY: ContactForm = Object.freeze({ kind: 'FAMILY', givenName: '', familyName: '', email: '', phone: '', childGivenName: '', childFamilyName: '', adultStudent: true, consent: true });

/** What a failed run means. Once the adult exists, a later refusal is "partly saved", and the same capsule finishes it. */
export function saveAfterError(error: unknown, name: string): AddContactSave {
  if (!(error instanceof AddContactError)) return { state: 'UNCERTAIN' };
  if (error.kind === 'UNKNOWN') return { state: 'UNCERTAIN' };
  if (error.step === 'adult') return { state: error.kind === 'REJECTED' ? 'REJECTED' : 'DENIED' };
  return { state: 'PARTIAL', name, denied: error.kind !== 'REJECTED' };
}

/**
 * The Add contact button and its form on Contacts. One press makes one capsule (plan plus five keys); while its outcome
 * is unknown or partly saved the form is locked and "Try again" resends that capsule exactly. The capsule lives in
 * memory only and is dropped on a definite answer, on Start over, or when the school changes (the parent re-keys us).
 */
export function AddContact({ scope, language, onAdded, api = addContactApi, newKey = () => crypto.randomUUID(), initialOpen = false }: {
  scope: ContactScope; language: string; onAdded?: (added: ContactAdded) => void; api?: AddContactApi; newKey?: () => string; initialOpen?: boolean;
}): React.ReactElement {
  const t = (key: AddContactKey, vars?: Record<string, string>) => addContactText(language, key, vars);
  const [open, setOpen] = useState(initialOpen);
  const [form, setForm] = useState<ContactForm>(EMPTY);
  const [save, setSave] = useState<AddContactSave>({ state: 'IDLE' });
  const held = useRef<ContactCapsule | null>(null), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const ids = { title: useId(), given: useId(), family: useId(), email: useId(), phone: useId(), phoneHelp: useId(), childGiven: useId(), childFamily: useId(), help: useId() };

  const send = useCallback((capsule: ContactCapsule) => {
    held.current = capsule;
    setSave({ state: 'SAVING' });
    api.add(capsule, () => alive.current && held.current === capsule).then(
      (added) => { if (held.current === capsule) held.current = null; if (!alive.current) return;
        setForm(EMPTY); setOpen(false); setSave({ state: 'SAVED', name: capsule.plan.label, family: added.familyId !== null }); onAdded?.(added); },
      (error) => { if (!alive.current) return; const next = saveAfterError(error, capsule.plan.label);
        if (next.state === 'DENIED' || next.state === 'REJECTED') { if (held.current === capsule) held.current = null; }
        setSave(next); });
  }, [api, onAdded]);

  const onSave = () => {
    const built = buildContactPlan(form);
    if (!built.ok) { setSave({ state: 'PROBLEM', problem: built.problem }); return; }
    let capsule: ContactCapsule;
    try { capsule = prepareContact(scope, built.plan, form, newKey); } catch { setSave({ state: 'REJECTED' }); return; }
    send(capsule);
  };
  const onRetry = () => { if (held.current) send(held.current); };
  const onDiscard = () => { held.current = null; setForm(EMPTY); setSave({ state: 'IDLE' }); };
  const set = <K extends keyof ContactForm>(key: K, value: ContactForm[K]) => {
    setForm(now => ({ ...now, [key]: value }));
    setSave(now => now.state === 'SAVING' || now.state === 'UNCERTAIN' || now.state === 'PARTIAL' ? now : { state: 'IDLE' });
  };

  const saved = save.state === 'SAVED' ? <p className={styles.outcome} role="status" data-tone="ok">{t(save.family ? 'saved' : 'savedPlain', { name: save.name })}</p> : null;
  if (!open) return <div className={styles.headTools} data-testid="add-contact-bar">{saved}
    <button type="button" className={styles.primary} onClick={() => { setOpen(true); setSave(now => now.state === 'SAVED' ? { state: 'IDLE' } : now); }}>{t('button')}</button></div>;

  const busy = save.state === 'SAVING', kept = save.state === 'UNCERTAIN' || save.state === 'PARTIAL', locked = busy || kept;
  const message = save.state === 'PROBLEM' ? t(save.problem) : save.state === 'REJECTED' ? t('rejected') : save.state === 'DENIED' ? t('denied')
    : save.state === 'UNCERTAIN' ? t('uncertain') : save.state === 'PARTIAL' ? t(save.denied ? 'partialDenied' : 'partialRejected', { name: save.name }) : null;
  const text = (key: 'givenName' | 'familyName' | 'email' | 'phone' | 'childGivenName' | 'childFamilyName', id: string, label: AddContactKey, type: string, autoComplete: string, max: number, extra: Record<string, string> = {}) =>
    <div className={styles.filterField}><label htmlFor={id}>{t(label)}</label>
      <input id={id} type={type} autoComplete={autoComplete} maxLength={max} value={form[key]} disabled={locked} onChange={e => set(key, e.target.value)} {...extra}/></div>;
  const family = form.kind === 'FAMILY';
  return <article className={styles.card} aria-labelledby={ids.title} data-testid="add-contact">
    <div className={styles.personHead}><h2 id={ids.title}>{t('title')}</h2>
      <button type="button" className={styles.secondary} disabled={busy} onClick={() => setOpen(false)}>{t('close')}</button></div>
    <form className={styles.form} noValidate onSubmit={e => { e.preventDefault(); if (!locked) onSave(); }}>
      <fieldset className={styles.addKind} disabled={locked}><legend>{t('kindLabel')}</legend>
        {(['FAMILY', 'ADULT'] as const).map(kind => <label key={kind} className={styles.check}>
          <input type="radio" name="add-contact-kind" value={kind} checked={form.kind === kind} onChange={() => set('kind', kind)}/> {t(`kind${kind}`)}</label>)}
      </fieldset>
      <h3>{t(family ? 'parentHead' : 'adultHead')}</h3>
      <div className={styles.filterGrid}>
        {text('givenName', ids.given, 'givenName', 'text', 'off', 120)}
        {text('familyName', ids.family, 'familyName', 'text', 'off', 120)}
        {text('email', ids.email, 'email', 'email', 'off', 320, { 'aria-describedby': ids.help })}
        {text('phone', ids.phone, 'phone', 'tel', 'off', 32, { 'aria-describedby': ids.phoneHelp })}
      </div>
      <p id={ids.phoneHelp} className={styles.meta}>{t('phoneHelp')}</p>
      {family ? <p id={ids.help} className={styles.meta}>{t('emailTip')}</p> : null}
      {family ? <><h3>{t('childHead')}</h3>
        <div className={styles.filterGrid}>
          {text('childGivenName', ids.childGiven, 'childGivenName', 'text', 'off', 120)}
          {text('childFamilyName', ids.childFamily, 'childFamilyName', 'text', 'off', 120)}
        </div></> : <><label className={styles.check}><input type="checkbox" name="adult-student" checked={form.adultStudent} disabled={locked} onChange={e => set('adultStudent', e.target.checked)}/> {t('adultStudent')}</label>
        <p className={styles.meta}>{t('adultStudentHelp')}</p></>}
      <label className={styles.check}><input type="checkbox" name="record-consent" checked={form.consent} disabled={locked} onChange={e => set('consent', e.target.checked)}/> {t('consent')}</label>
      <p className={styles.meta}>{t('consentHelp')}</p>
      {message ? <p className={styles.notice} role="alert">{message}</p> : null}
      <div className={styles.actions}>
        {kept ? <>
          <button type="button" className={styles.primary} onClick={onRetry}>{t('retry')}</button>
          {save.state === 'UNCERTAIN' ? <button type="button" className={styles.secondary} onClick={onDiscard}>{t('discard')}</button> : null}
        </> : <button type="submit" className={styles.primary} disabled={busy}>{busy ? t('saving') : t('save')}</button>}
      </div>
    </form>
  </article>;
}
