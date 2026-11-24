import React from 'react';
import { HQ_PROSPECT_CHANNELS, HQ_PROSPECT_CONSENT_STATUSES, HQ_PROSPECT_LIMITS, HQ_PROSPECT_PURPOSES, hqMayRecordProspectConsent, isHqEmail,
  isHqProspectText, normalizeHqPhone, type HqProspect, type HqProspectChannel, type HqProspectConsentStatus, type HqProspectPurpose, type HqProspectConsentInput, type HqProspectCreateInput, type HqProspectDetail, type HqProspectList, type HqProspectReceipt,
  type HqProspectStatus, type HqProspectUpdateInput } from '@hon/contracts';
import type { CommsOutcome } from '../hq-communications/model';
import { formatTime } from '../hq-support/parts';
import styles from '../hq-access/hq-access.module.css';
import { prospectRefusalKey, prospectText, type ProspectKey } from './copy';

export type ProspectDraft = Readonly<{ fullName: string; schoolName: string; email: string; phone: string; source: string }>;
export type ConsentDraft = Readonly<{ channel: string; purpose: string; status: string; note: string }>;
type T = (key: ProspectKey, vars?: Record<string, string>) => string;
const translator = (language: string): T => (key, vars) => prospectText(language, key, vars);

/** The add/correct form as fields, or null. The email is lower-cased; a phone is normalized to E.164; one of them is required. */
export function prospectFieldsFrom(d: ProspectDraft): { fullName: string; schoolName: string | null; email: string | null; phone: string | null } | null {
  const fullName = d.fullName.trim(), schoolName = d.schoolName.trim(), email = d.email.trim().toLowerCase(), rawPhone = d.phone.trim();
  const phone = rawPhone ? normalizeHqPhone(rawPhone) : null;
  if (!isHqProspectText(fullName, 1, HQ_PROSPECT_LIMITS.fullName) || (schoolName && !isHqProspectText(schoolName, 1, HQ_PROSPECT_LIMITS.schoolName))) return null;
  if ((email && !isHqEmail(email)) || (rawPhone && !phone) || (!email && !phone)) return null;
  return { fullName, schoolName: schoolName || null, email: email || null, phone };
}
export function createInputFrom(d: ProspectDraft): HqProspectCreateInput | null {
  const f = prospectFieldsFrom(d);
  if (!f || (d.source !== 'HQ_ENTERED' && d.source !== 'IMPORT')) return null;
  return { ...f, campaignId: null, source: d.source };
}
export function updateInputFrom(p: HqProspect, d: ProspectDraft | null, status: HqProspectStatus): HqProspectUpdateInput | null {
  const f = d ? prospectFieldsFrom(d) : { fullName: p.fullName, schoolName: p.schoolName, email: p.email, phone: p.phone };
  if (!f) return null;
  return { ...f, campaignId: p.campaign?.campaignId ?? null, status, expectedVersion: p.version };
}
export type ConsentChoice = Readonly<{ channel: HqProspectChannel; purpose: HqProspectPurpose; status: HqProspectConsentStatus }>;
/** The answers HQ may record for this prospect now: an address it has, an answer HQ may record, no opt-in while archived, and not the answer already on file. */
export function consentChoicesFor(p: HqProspect): ConsentChoice[] {
  const out: ConsentChoice[] = [];
  for (const channel of HQ_PROSPECT_CHANNELS) {
    if ((channel === 'EMAIL' ? p.email : p.phone) === null) continue;
    for (const purpose of HQ_PROSPECT_PURPOSES) for (const status of HQ_PROSPECT_CONSENT_STATUSES) {
      if (!hqMayRecordProspectConsent(channel, purpose, status) || (status === 'OPTED_IN' && p.status === 'ARCHIVED')) continue;
      if (p.consent[channel][purpose]?.status === status) continue;
      out.push({ channel, purpose, status });
    }
  }
  return out;
}
const choiceValue = (c: ConsentChoice) => `${c.channel}.${c.purpose}.${c.status}`;
/** The consent form as a request, or null. Only an answer in consentChoicesFor is ever sent. */
export function consentInputFrom(p: HqProspect, d: ConsentDraft): HqProspectConsentInput | null {
  const note = d.note.trim();
  const choice = consentChoicesFor(p).find((c) => c.channel === d.channel && c.purpose === d.purpose && c.status === d.status);
  if (!choice || !isHqProspectText(note, 3, HQ_PROSPECT_LIMITS.note)) return null;
  return { ...choice, note, expectedVersion: p.version };
}

export function ProspectOutcome({ language, outcome, canRetry, onTryAgain, localInvalid }: { language: string; outcome: CommsOutcome<HqProspectReceipt>;
  canRetry: boolean; onTryAgain: () => void; localInvalid?: ProspectKey | null }): React.ReactElement | null {
  const t = translator(language);
  if (localInvalid) return <p className={styles.outcome} data-tone="blocked" role="alert" data-prospect-outcome="local_invalid">{t(localInvalid)}</p>;
  if (!outcome || outcome.kind === 'LOCAL_INVALID') return null;
  if (outcome.kind === 'SENDING') return <p className={styles.outcome} role="status" data-prospect-outcome="sending">{t('sending')}</p>;
  if (outcome.kind === 'DONE') return <p className={styles.outcome} data-tone="ok" role="status" data-prospect-outcome="done">{t('saved')}</p>;
  if (outcome.kind === 'UNKNOWN') return <div className={styles.outcome} data-tone="waiting" role="alert" data-prospect-outcome="unknown"><p>{t('unknown')}</p>
    {canRetry && <button type="button" className={styles.secondary} onClick={onTryAgain}>{t('tryAgain')}</button>}</div>;
  const key: ProspectKey = outcome.kind === 'CHANGED' ? 'changed' : outcome.kind === 'KEY_REUSED' ? 'keyReused' : outcome.kind === 'DENIED' ? 'deniedCommand'
    : outcome.kind === 'INVALID' ? 'invalidCommand' : outcome.kind === 'GONE' ? 'goneCommand' : prospectRefusalKey(outcome.code);
  return <p className={styles.outcome} data-tone="blocked" role="alert" data-prospect-outcome={outcome.kind.toLowerCase()}>{t(key)}</p>;
}

function ProspectForm({ t, prospect, withSource, locked, label, onSubmit }: { t: T; prospect: HqProspect | null; withSource: boolean; locked: boolean;
  label: ProspectKey; onSubmit: (d: ProspectDraft) => void }): React.ReactElement {
  const id = prospect ? `hq-prospect-edit` : 'hq-prospect-add';
  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const f = new FormData(event.currentTarget), v = (k: string) => String(f.get(k) ?? '');
    onSubmit({ fullName: v('fullName'), schoolName: v('schoolName'), email: v('email'), phone: v('phone'), source: v('source') || 'HQ_ENTERED' });
  };
  return <form className={styles.form} onSubmit={submit} data-prospect-form={prospect ? 'edit' : 'add'}>
    <fieldset className={styles.fields} disabled={locked}>
      <label htmlFor={`${id}-name`}>{t('fullName')}</label><input id={`${id}-name`} name="fullName" required maxLength={HQ_PROSPECT_LIMITS.fullName} defaultValue={prospect?.fullName} autoComplete="off"/>
      <label htmlFor={`${id}-school`}>{t('schoolName')}</label><input id={`${id}-school`} name="schoolName" maxLength={HQ_PROSPECT_LIMITS.schoolName} defaultValue={prospect?.schoolName ?? ''} autoComplete="off"/>
      <label htmlFor={`${id}-email`}>{t('email')}</label><input id={`${id}-email`} name="email" type="email" maxLength={254} defaultValue={prospect?.email ?? ''} autoComplete="off"/>
      <label htmlFor={`${id}-phone`}>{t('phone')}</label><input id={`${id}-phone`} name="phone" type="tel" maxLength={24} defaultValue={prospect?.phone ?? ''} autoComplete="off"
        aria-describedby={`${id}-contact-help`}/>
      <p id={`${id}-contact-help`} className={styles.meta}>{t('contactHelp')}</p>
      {withSource && <><label htmlFor={`${id}-source`}>{t('source')}</label>
        <select id={`${id}-source`} name="source" defaultValue="HQ_ENTERED"><option value="HQ_ENTERED">{t('HQ_ENTERED')}</option><option value="IMPORT">{t('IMPORT')}</option></select></>}
    </fieldset>
    <div className={styles.actions}><button type="submit" className={styles.primary} disabled={locked}>{t(label)}</button></div>
  </form>;
}

function ConsentGrid({ t, p, locale }: { t: T; p: HqProspect; locale: string }): React.ReactElement {
  return <table className={styles.list} data-prospect-consent-grid><thead><tr><th scope="col">{t('consent')}</th>
    {HQ_PROSPECT_PURPOSES.map((pu) => <th key={pu} scope="col">{t(pu)}</th>)}</tr></thead>
    <tbody>{HQ_PROSPECT_CHANNELS.map((ch) => <tr key={ch}><th scope="row">{t(ch)}</th>
      {HQ_PROSPECT_PURPOSES.map((pu) => { const c = p.consent[ch][pu];
        return <td key={pu} data-consent={`${ch}-${pu}`} data-status={c?.status ?? 'NONE'}>{c ? `${t(c.status)} · ${t(c.source)} · ${formatTime(locale, c.capturedAt)}` : t('unknownConsent')}</td>; })}
    </tr>)}</tbody></table>;
}

export type ProspectListState = { state: 'LOADING' } | { state: 'DENIED' } | { state: 'UNAVAILABLE' }
  | { state: 'READY'; list: HqProspectList; prospects: readonly HqProspect[]; loadingMore: boolean; moreFailed: boolean };
export type ProspectListViewProps = Readonly<{ language: string; formattingLocale: string; concealed: boolean; state: ProspectListState; filter: HqProspectStatus | null;
  outcome: CommsOutcome<HqProspectReceipt>; locked: boolean; canRetry: boolean; localInvalid: ProspectKey | null; formKey: number;
  onFilter: (s: HqProspectStatus | null) => void; onMore: () => void; onRefresh: () => void; onReveal: () => void; onAdd: (d: ProspectDraft) => void; onTryAgain: () => void }>;

export function ProspectListView(p: ProspectListViewProps): React.ReactElement {
  const t = translator(p.language);
  const head = <header className={styles.head}><h1>{t('title')}</h1><p className={styles.intro}>{t('intro')}</p></header>;
  if (p.concealed) return <main className={styles.access} data-hq-prospects="concealed">{head}<p className={styles.notice}>{t('concealed')}</p>
    <div className={styles.actions}><button type="button" className={styles.secondary} onClick={p.onReveal}>{t('reveal')}</button></div></main>;
  if (p.state.state !== 'READY') {
    const key: ProspectKey = p.state.state === 'LOADING' ? 'loading' : p.state.state === 'DENIED' ? 'denied' : 'unavailable';
    return <main className={styles.access} data-hq-prospects={p.state.state.toLowerCase()}>{head}
      <p className={styles.notice} role={p.state.state === 'LOADING' ? 'status' : 'alert'}>{t(key)}</p>
      {p.state.state === 'UNAVAILABLE' && <div className={styles.actions}><button type="button" className={styles.secondary} onClick={p.onRefresh}>{t('refresh')}</button></div>}</main>;
  }
  const s = p.state;
  return <main className={styles.access} data-hq-prospects="ready">{head}
    <p className={styles.meta}>{t('asOf', { time: formatTime(p.formattingLocale, s.list.asOf) })}</p>
    <section className={styles.card} aria-labelledby="hq-prospect-add-title"><h2 id="hq-prospect-add-title">{t('add')}</h2>
      <ProspectOutcome language={p.language} outcome={p.outcome} canRetry={p.canRetry} onTryAgain={p.onTryAgain} localInvalid={p.localInvalid}/>
      <ProspectForm key={p.formKey} t={t} prospect={null} withSource locked={p.locked} label="save" onSubmit={p.onAdd}/>
    </section>
    <div className={styles.filters} role="group" aria-label={t('status')}>
      {([null, 'ACTIVE', 'ARCHIVED'] as const).map((f) => <button key={f ?? 'ALL'} type="button" className={styles.secondary} aria-pressed={p.filter === f}
        onClick={() => p.onFilter(f)}>{t(f ?? 'filterAll')}</button>)}
      <button type="button" className={styles.secondary} onClick={p.onRefresh}>{t('refresh')}</button>
    </div>
    {s.prospects.length === 0 ? <p className={styles.notice}>{t('none')}</p> : <ul className={styles.list} data-prospect-list>
      {s.prospects.map((x) => <li key={x.prospectId} className={styles.card} data-prospect={x.prospectId} data-status={x.status}>
        <div className={styles.cardHead}><h3><a href={`/hq/growth/prospects/${x.prospectId}`}>{x.fullName}</a></h3><span className={styles.status}>{t(x.status)}</span></div>
        <p className={styles.meta}>{[x.schoolName, x.email, x.phone, t(x.source), x.campaign?.name].filter(Boolean).join(' · ')}</p>
      </li>)}</ul>}
    {s.moreFailed && <p className={styles.notice} role="alert">{t('moreFailed')}</p>}
    {s.list.nextCursor && <div className={styles.actions}><button type="button" className={styles.secondary} disabled={s.loadingMore} onClick={p.onMore}>{t('more')}</button></div>}
  </main>;
}

export type ProspectDetailState = { state: 'LOADING' } | { state: 'DENIED' } | { state: 'UNAVAILABLE' } | { state: 'GONE' } | { state: 'INVALID' }
  | { state: 'READY'; detail: HqProspectDetail };
export type ProspectDetailViewProps = Readonly<{ language: string; formattingLocale: string; concealed: boolean; state: ProspectDetailState;
  outcome: CommsOutcome<HqProspectReceipt>; locked: boolean; canRetry: boolean; localInvalid: ProspectKey | null; formKey: number;
  onRefresh: () => void; onReveal: () => void; onEdit: (d: ProspectDraft) => void; onStatus: (s: HqProspectStatus) => void; onConsent: (d: ConsentDraft) => void;
  onTryAgain: () => void }>;

export function ProspectDetailView(p: ProspectDetailViewProps): React.ReactElement {
  const t = translator(p.language);
  const back = <p><a href="/hq/growth/prospects">{t('back')}</a></p>;
  if (p.concealed) return <main className={styles.access} data-hq-prospect="concealed">{back}<p className={styles.notice}>{t('concealed')}</p>
    <div className={styles.actions}><button type="button" className={styles.secondary} onClick={p.onReveal}>{t('reveal')}</button></div></main>;
  if (p.state.state !== 'READY') {
    const key: ProspectKey = p.state.state === 'LOADING' ? 'loadingOne' : p.state.state === 'DENIED' ? 'denied' : p.state.state === 'GONE' ? 'gone'
      : p.state.state === 'INVALID' ? 'invalid' : 'unavailable';
    return <main className={styles.access} data-hq-prospect={p.state.state.toLowerCase()}>{back}<h1>{t('detailTitle')}</h1>
      <p className={styles.notice} role={p.state.state === 'LOADING' ? 'status' : 'alert'}>{t(key)}</p></main>;
  }
  const { prospect: x, consentHistory } = p.state.detail;
  const choices = consentChoicesFor(x);
  const submitConsent = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const f = new FormData(event.currentTarget), v = (k: string) => String(f.get(k) ?? '');
    const [channel = '', purpose = '', status = ''] = v('answer').split('.');
    p.onConsent({ channel, purpose, status, note: v('note') });
  };
  return <main className={styles.access} data-hq-prospect="ready" data-status={x.status}>{back}
    <header className={styles.head}><h1>{x.fullName}</h1><p className={styles.meta}>{[x.schoolName, t(x.status)].filter(Boolean).join(' · ')}</p></header>
    <ProspectOutcome language={p.language} outcome={p.outcome} canRetry={p.canRetry} onTryAgain={p.onTryAgain} localInvalid={p.localInvalid}/>
    <section className={styles.card}><dl className={styles.facts}>
      <div><dt>{t('email')}</dt><dd>{x.email ?? '—'}</dd></div><div><dt>{t('phone')}</dt><dd>{x.phone ?? '—'}</dd></div>
      <div><dt>{t('source')}</dt><dd>{t(x.source)}</dd></div><div><dt>{t('campaign')}</dt><dd>{x.campaign ? `${x.campaign.name} (${x.campaign.code})` : t('noCampaign')}</dd></div>
      <div><dt>{t('created')}</dt><dd>{formatTime(p.formattingLocale, x.createdAt)}{x.createdBy ? ` · ${x.createdBy.displayName}` : ''}</dd></div>
      <div><dt>{t('updated')}</dt><dd>{formatTime(p.formattingLocale, x.updatedAt)}</dd></div></dl>
      <div className={styles.actions}><button type="button" className={x.status === 'ACTIVE' ? styles.danger : styles.secondary} disabled={p.locked}
        onClick={() => p.onStatus(x.status === 'ACTIVE' ? 'ARCHIVED' : 'ACTIVE')}>{t(x.status === 'ACTIVE' ? 'archive' : 'restore')}</button>
        <button type="button" className={styles.secondary} onClick={p.onRefresh}>{t('refresh')}</button></div>
    </section>
    {x.status === 'ACTIVE' && <details className={styles.card}><summary>{t('edit')}</summary>
      <ProspectForm key={p.formKey} t={t} prospect={x} withSource={false} locked={p.locked} label="save" onSubmit={p.onEdit}/></details>}
    <section className={styles.card} aria-labelledby="hq-prospect-consent-title"><h2 id="hq-prospect-consent-title">{t('consent')}</h2>
      <p className={styles.meta}>{t('consentHelp')}</p><ConsentGrid t={t} p={x} locale={p.formattingLocale}/>
      <h3>{t('record')}</h3><p className={styles.meta}>{t('recordHelp')}</p>
      {choices.length === 0 ? <p className={styles.meta} data-prospect-consent-none>{t('nothingToRecord')}</p>
        : <form key={p.formKey} className={styles.form} onSubmit={submitConsent} data-prospect-form="consent"><fieldset className={styles.fields} disabled={p.locked}>
        <label htmlFor="hq-prospect-consent-answer">{t('recordStatus')}</label>
        <select id="hq-prospect-consent-answer" name="answer">{choices.map((c) =>
          <option key={choiceValue(c)} value={choiceValue(c)}>{`${t(c.channel)} · ${t(c.purpose)} · ${t(c.status)}`}</option>)}</select>
        <label htmlFor="hq-prospect-consent-note">{t('note')}</label>
        <input id="hq-prospect-consent-note" name="note" required minLength={3} maxLength={HQ_PROSPECT_LIMITS.note} aria-describedby="hq-prospect-consent-note-help" autoComplete="off"/>
        <p id="hq-prospect-consent-note-help" className={styles.meta}>{t('noteHelp')}</p>
      </fieldset><div className={styles.actions}><button type="submit" className={styles.primary} disabled={p.locked}>{t('recordSave')}</button></div></form>}
      <h3>{t('history')}</h3>
      {consentHistory.length === 0 ? <p className={styles.meta}>{t('noHistory')}</p> : <ul className={styles.list} data-prospect-history>
        {consentHistory.map((h, i) => <li key={i} data-current={h.current}>{`${formatTime(p.formattingLocale, h.capturedAt)} · ${t(h.channel)} ${t(h.purpose)} · ${t(h.status)} · ${t(h.source)} · ${h.address}`}
          {!h.current && ` (${t('notCurrent')})`}{h.note ? ` · “${h.note}”` : ''}{h.recordedBy ? ` · ${h.recordedBy.displayName}` : ''}</li>)}</ul>}
    </section>
  </main>;
}
