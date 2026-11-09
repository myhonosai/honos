'use client';
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { CommunicationConsentStatus, CommunicationConsentSummary, PersonRecord } from '@hon/contracts';
import { peopleText, type PeopleKey } from './copy';
import { CONSENT_CHANNELS, ConsentError, consentApi, keepConsentForRetry, type ConsentApi, type ConsentChannel, type ConsentErrorKind, type ConsentInput } from './consent-http';
import type { PeopleScope } from './http';
import styles from './people.module.css';

type T = (key: PeopleKey, vars?: Record<string, string>) => string;
export type ConsentRead =
  | Readonly<{ state: 'LOADING' | 'DENIED' | 'UNAVAILABLE' | 'MISSING' }> | Readonly<{ state: 'READY'; rows: readonly CommunicationConsentSummary[] }>;
export type ConsentForm = null | Readonly<{ channel: ConsentChannel; status: CommunicationConsentStatus }>;
export type ConsentOutcome = null | Readonly<{ kind: 'SENDING' | 'DONE' | Exclude<ConsentErrorKind, 'SESSION'>; channel: ConsentChannel; status: CommunicationConsentStatus; replayed?: boolean }>;
export type ConsentCardProps = Readonly<{
  language: string; name: string; canEdit: boolean; summary: PersonRecord['consents']; read: ConsentRead; form: ConsentForm; outcome: ConsentOutcome;
  locked: boolean; canRetry: boolean;
  onOpen?: ((form: Exclude<ConsentForm, null>) => void) | undefined; onClose?: (() => void) | undefined; onConfirm?: (() => void) | undefined;
  onReload?: (() => void) | undefined; onTryAgain?: (() => void) | undefined; onStop?: (() => void) | undefined;
}>;

const OUTCOME: Record<Exclude<NonNullable<ConsentOutcome>['kind'], 'DONE'>, PeopleKey> = { SENDING: 'consentSending', DENIED: 'consentDenied', MISSING: 'consentMissing',
  CONFLICT: 'consentConflict', INVALID: 'consentInvalid', BUSY: 'consentBusy', UNKNOWN: 'consentUnknown' };

/** Pure view. Each channel's state comes from the consent read; when that read is refused the person record's summary is shown, read only. */
export function ConsentCard(p: ConsentCardProps): React.ReactElement {
  const t: T = (key, vars) => peopleText(p.language, key, vars);
  const base = useId();
  const rows = p.read.state === 'READY' ? p.read.rows : null;
  const moment = (iso: string) => new Intl.DateTimeFormat(p.language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
  const channelName = (c: ConsentChannel) => t(c).toLowerCase();
  const outcome = p.outcome;
  return <article className={styles.card} aria-labelledby={`${base}-title`} data-testid="person-consents">
    <h2 id={`${base}-title`}>{t('consentTitle')}</h2>
    <p className={styles.meta}>{t('consentIntro')}</p>
    {p.read.state === 'LOADING' ? <p className={styles.meta} role="status">{t('consentLoading')}</p> : null}
    {p.read.state === 'DENIED' || p.read.state === 'UNAVAILABLE' ? <div className={styles.meta} role="status">
      <p>{t(p.read.state === 'DENIED' ? 'consentReadDenied' : 'consentReadUnavailable')}</p>
      {p.read.state === 'UNAVAILABLE' && p.onReload ? <button type="button" className={styles.secondary} onClick={p.onReload}>{t('consentReload')}</button> : null}
    </div> : null}
    {p.read.state === 'MISSING' ? <p className={styles.meta} role="status">{t('recordMissing')}</p> : null}
    <ul className={styles.consentList}>{CONSENT_CHANNELS.map((c) => {
      const row = rows?.find((r) => r.channel === c) ?? null;
      const status = rows ? row?.status ?? 'NOT_RECORDED' : p.summary[c];
      const next: CommunicationConsentStatus = status === 'OPTED_IN' ? 'OPTED_OUT' : 'OPTED_IN';
      const open = p.form?.channel === c;
      return <li key={c} data-testid={`consent-${c}`} data-status={status}>
        <div className={styles.consentHead}>
          <strong>{t(c)}</strong>
          <span className={styles.status} data-tone={status === 'OPTED_IN' ? 'ready' : 'planned'}>{t(status)}</span>
        </div>
        {row ? <small className={styles.meta}>{t('consentRecorded', { time: moment(row.capturedAt), source: t(`src_${row.source}`) })}</small> : null}
        {rows && p.canEdit && !open ? <button type="button" className={styles.secondary} disabled={p.locked || p.form !== null}
          onClick={() => p.onOpen?.({ channel: c, status: next })}>{t(next === 'OPTED_OUT' ? 'recordOptOut' : 'recordOptIn')}</button> : null}
        {open && p.form ? <form className={styles.form} data-testid="consent-form" onSubmit={(e) => { e.preventDefault(); p.onConfirm?.(); }}>
          <p>{t(p.form.status === 'OPTED_OUT' ? 'optOutAsk' : 'optInAsk', { name: p.name, channel: channelName(c) })}</p>
          {p.form.status === 'OPTED_IN' ? <label className={styles.check}><input type="checkbox" name="attest" required disabled={p.locked}/>
            <span>{t('optInAttest', { name: p.name })}</span></label> : null}
          <div className={styles.actions}>
            <button type="submit" className={styles.primary} disabled={p.locked}>{t(p.form.status === 'OPTED_OUT' ? 'optOutConfirm' : 'optInConfirm')}</button>
            <button type="button" className={styles.secondary} disabled={p.locked} onClick={p.onClose}>{t('consentBack')}</button>
          </div>
        </form> : null}
      </li>;
    })}</ul>
    {outcome ? <div className={styles.outcome} role="status" data-testid="consent-outcome" data-kind={outcome.kind}
      data-tone={outcome.kind === 'DONE' ? 'ok' : outcome.kind === 'SENDING' || outcome.kind === 'UNKNOWN' || outcome.kind === 'BUSY' ? 'waiting' : 'blocked'}>
      <p>{outcome.kind === 'DONE'
        ? `${t(outcome.status === 'OPTED_OUT' ? 'consentDoneOut' : 'consentDoneIn', { channel: channelName(outcome.channel) })}${outcome.replayed ? ` ${t('consentReplayed')}` : ''}`
        : t(OUTCOME[outcome.kind])}</p>
      {p.canRetry ? <div className={styles.actions}>
        {p.onTryAgain ? <button type="button" className={styles.primary} onClick={p.onTryAgain}>{t('tryAgain')}</button> : null}
        {p.onStop ? <button type="button" className={styles.secondary} onClick={p.onStop}>{t('consentStop')}</button> : null}
      </div> : null}
    </div> : null}
  </article>;
}

type Pending = Readonly<{ key: string; channel: ConsentChannel; input: ConsentInput }>;
type Lock = 'NONE' | 'SENDING' | 'KEPT';
const systemNow = () => Date.now();

/** The body for one recorded choice: the version comes from the consent read (absent for a first record), the time is now. */
export function consentInput(rows: readonly CommunicationConsentSummary[], form: Exclude<ConsentForm, null>, now: number): ConsentInput {
  const row = rows.find((r) => r.channel === form.channel);
  return { status: form.status, source: 'STAFF', capturedAt: new Date(now).toISOString(), ...(row ? { expectedVersion: row.version } : {}) };
}

/**
 * Contact consent for one person at the verified school. Mounted per person inside the People page, so a school change,
 * concealment or opening another person unmounts it and drops any kept request. Every answer is followed by a fresh read;
 * an unknown outcome keeps the exact request (same key, same time) so Try again cannot record a second, different choice.
 * Dropping it is safe: a second attempt carries the version it read and is refused if the first one was recorded.
 */
export function PersonConsents({ language, scope, record, canEdit, onRecorded, api = consentApi, now = systemNow }: {
  language: string; scope: PeopleScope; record: PersonRecord; canEdit: boolean;
  onRecorded?: ((channel: ConsentChannel, status: CommunicationConsentStatus) => void) | undefined; api?: ConsentApi; now?: () => number;
}): React.ReactElement {
  const [read, setRead] = useState<ConsentRead>({ state: 'LOADING' });
  const [refresh, setRefresh] = useState(0);
  const [form, setForm] = useState<ConsentForm>(null);
  const [outcome, setOutcome] = useState<ConsentOutcome>(null);
  const [lock, setLock] = useState<Lock>('NONE');
  const generation = useRef(0), mounted = useRef(false), pending = useRef<Pending | null>(null), sending = useRef(false);
  const recorded = useRef(onRecorded); recorded.current = onRecorded;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; pending.current = null; }; }, []);
  const { organizationId, schoolId } = scope, personId = record.personId;

  useEffect(() => {
    const current = ++generation.current;
    const owned = () => mounted.current && current === generation.current;
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    setRead({ state: 'LOADING' });
    api.list({ organizationId, schoolId }, personId, signal, owned).then((rows) => { if (owned()) setRead({ state: 'READY', rows }); }, (error) => {
      if (!owned() || abort.signal.aborted) return;
      const kind = error instanceof ConsentError ? error.kind : 'UNKNOWN';
      setRead({ state: kind === 'DENIED' ? 'DENIED' : kind === 'MISSING' ? 'MISSING' : 'UNAVAILABLE' });
    });
    return () => { abort.abort(); };
  }, [api, organizationId, schoolId, personId, refresh]);

  const send = useCallback(async () => {
    const request = pending.current;
    if (!request || sending.current) return;
    sending.current = true;
    setLock('SENDING'); setOutcome({ kind: 'SENDING', channel: request.channel, status: request.input.status });
    let next: NonNullable<ConsentOutcome>, keep = false;
    try {
      const owned = () => mounted.current && pending.current?.key === request.key;
      const answer = await api.record({ organizationId, schoolId }, personId, request.channel, request.input, request.key, AbortSignal.timeout(30000), owned);
      next = { kind: 'DONE', channel: request.channel, status: answer.consent.status, replayed: answer.replayed };
    } catch (error) {
      keep = keepConsentForRetry(error);
      next = { kind: error instanceof ConsentError && error.kind !== 'SESSION' ? error.kind : 'UNKNOWN', channel: request.channel, status: request.input.status };
    } finally { sending.current = false; }
    if (!mounted.current) return;
    if (pending.current?.key === request.key) pending.current = keep ? request : null;
    setLock(pending.current ? 'KEPT' : 'NONE');
    setOutcome(next);
    if (next.kind === 'DONE') recorded.current?.(request.channel, request.input.status);
    if (!keep) setForm(null);
    setRefresh((n) => n + 1);
  }, [api, organizationId, schoolId, personId]);

  const onConfirm = useCallback(() => {
    if (lock !== 'NONE' || pending.current || sending.current || !form || read.state !== 'READY') return;
    pending.current = { key: globalThis.crypto.randomUUID(), channel: form.channel, input: consentInput(read.rows, form, now()) };
    void send();
  }, [lock, form, read, now, send]);

  return <ConsentCard language={language} name={`${record.givenName} ${record.familyName}`} canEdit={canEdit} summary={record.consents} read={read}
    form={form} outcome={outcome} locked={lock !== 'NONE'} canRetry={lock === 'KEPT'}
    onOpen={(next) => { if (lock === 'NONE') { setForm(next); setOutcome(null); } }} onClose={() => { if (lock === 'NONE') setForm(null); }}
    onConfirm={onConfirm} onReload={() => setRefresh((n) => n + 1)} onTryAgain={() => { void send(); }}
    onStop={() => { if (lock !== 'KEPT' || sending.current) return; pending.current = null; setLock('NONE'); setForm(null); setOutcome(null); setRefresh((n) => n + 1); }}/>;
}
