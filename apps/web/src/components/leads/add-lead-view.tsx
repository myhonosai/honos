import React, { useId } from 'react';
import { addLeadText, type AddLeadKey } from './add-lead-copy';
import { openStageChoices, type LeadForm, type LeadFormProblem, type PipelineOption } from './add-lead-http';
import styles from './leads.module.css';

export type PipelinesState = { state: 'LOADING' | 'DENIED' | 'UNAVAILABLE' } | { state: 'READY'; items: readonly PipelineOption[] };
export type SetupState = { state: 'IDLE' | 'WORKING' | 'DENIED' | 'FAILED' };
export type SaveState = { state: 'IDLE' | 'SAVING' | 'DENIED' | 'REJECTED' | 'UNCERTAIN' } | { state: 'SAVED'; name: string } | { state: 'PROBLEM'; problem: LeadFormProblem };
export type AddLeadViewProps = Readonly<{
  language: string; pipelines: PipelinesState; setup: SetupState; open: boolean; form: LeadForm; stageId: string | null; save: SaveState;
  onSetUp?: (() => void) | undefined; onReload?: (() => void) | undefined; onOpen?: ((open: boolean) => void) | undefined;
  onField?: ((field: keyof LeadForm, value: string) => void) | undefined; onStage?: ((stageId: string) => void) | undefined;
  onSave?: (() => void) | undefined; onRetry?: (() => void) | undefined; onDiscard?: (() => void) | undefined;
}>;

/** Pure view. Nothing shows until the school's stages are read; a reader without lead access sees nothing extra. */
export function AddLeadView(props: AddLeadViewProps): React.ReactElement | null {
  const { language, pipelines, setup, open, form, stageId, save } = props;
  const t = (key: AddLeadKey, vars?: Record<string, string>) => addLeadText(language, key, vars);
  const ids = { given: useId(), family: useId(), email: useId(), phone: useId(), phoneHelp: useId(), stage: useId() };
  if (pipelines.state !== 'READY') return pipelines.state !== 'UNAVAILABLE' ? null : <div className={styles.notice} role="status"><p>{t('pipelinesUnavailable')}</p>
    <button type="button" className={styles.secondary} onClick={props.onReload}>{t('reload')}</button></div>;
  const choices = openStageChoices(pipelines.items);
  if (!choices.length) return <article className={styles.card} aria-labelledby="leads-setup-title" data-testid="leads-setup">
    <h2 id="leads-setup-title">{t('setupTitle')}</h2>
    <p className={styles.meta}>{t('setupBody')}</p>
    {setup.state === 'DENIED' ? <p className={styles.notice} role="status">{t('setupDenied')}</p> : null}
    {setup.state === 'FAILED' ? <p className={styles.notice} role="alert">{t('setupFailed')}</p> : null}
    {setup.state !== 'DENIED' ? <div><button type="button" className={styles.primary} disabled={setup.state === 'WORKING'} onClick={props.onSetUp}>
      {setup.state === 'WORKING' ? t('setupWorking') : t('setupButton')}</button></div> : null}
  </article>;
  const saved = save.state === 'SAVED' ? <p className={styles.upcoming} role="status">{t('saved', { name: save.name })}</p> : null;
  if (!open) return <div className={styles.addBar}>{saved}<button type="button" className={styles.primary} onClick={() => props.onOpen?.(true)}>{t('addButton')}</button></div>;
  const busy = save.state === 'SAVING', locked = busy || save.state === 'UNCERTAIN';
  const message = save.state === 'PROBLEM' ? t(save.problem) : save.state === 'REJECTED' ? t('rejected') : save.state === 'DENIED' ? t('denied') : save.state === 'UNCERTAIN' ? t('uncertain') : null;
  const field = (key: keyof LeadForm, id: string, label: AddLeadKey, type: string, autoComplete: string, max: number, extra: Record<string, string> = {}) =>
    <div className={styles.filter}><label htmlFor={id}>{t(label)}</label>
      <input id={id} type={type} autoComplete={autoComplete} maxLength={max} value={form[key]} disabled={locked} onChange={(e) => props.onField?.(key, e.target.value)} {...extra}/></div>;
  return <article className={styles.card} aria-labelledby="leads-add-title" data-testid="leads-add">
    <div className={styles.cardHead}><h2 id="leads-add-title">{t('addTitle')}</h2>
      <button type="button" className={styles.secondary} disabled={locked} onClick={() => props.onOpen?.(false)}>{t('close')}</button></div>
    {saved}
    <form className={styles.addForm} noValidate onSubmit={(e) => { e.preventDefault(); if (!locked) props.onSave?.(); }}>
      {field('givenName', ids.given, 'givenName', 'text', 'given-name', 120)}
      {field('familyName', ids.family, 'familyName', 'text', 'family-name', 120)}
      {field('email', ids.email, 'email', 'email', 'email', 320)}
      {field('phone', ids.phone, 'phone', 'tel', 'tel', 32, { 'aria-describedby': ids.phoneHelp })}
      <p id={ids.phoneHelp} className={styles.meta}>{t('phoneHelp')}</p>
      <div className={styles.filter}><label htmlFor={ids.stage}>{t('stage')}</label>
        <select id={ids.stage} value={stageId ?? ''} disabled={locked} onChange={(e) => props.onStage?.(e.target.value)}>
          {choices.map((choice) => <option key={choice.stageId} value={choice.stageId}>{choice.label}</option>)}
        </select></div>
      {message ? <p className={styles.notice} role="alert">{message}</p> : null}
      <div className={styles.addActions}>
        {save.state === 'UNCERTAIN' ? <>
          <button type="button" className={styles.primary} onClick={props.onRetry}>{t('retry')}</button>
          <button type="button" className={styles.secondary} onClick={props.onDiscard}>{t('discard')}</button>
        </> : <button type="submit" className={styles.primary} disabled={busy}>{busy ? t('saving') : t('save')}</button>}
      </div>
    </form>
  </article>;
}
