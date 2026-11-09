import React, { useId } from 'react';
import type { PersonRecord } from '@hon/contracts';
import { accountValue } from '../account-status/copy';
import { peopleText, type PeopleKey } from './copy';
import { PEOPLE_LIST_LIMIT, PEOPLE_QUERY_MAX } from './http';
import { localToday, type CommandKind, type ListState, type RecordState, type SaveOutcome } from './model';
import styles from './people.module.css';

type T = (key: PeopleKey, vars?: Record<string, string>) => string;
export type ContactDraft = Readonly<{ givenName: string; familyName: string; email: string; phone: string }>;
export type BirthDraft = Readonly<{ birthDate: string; reason: string }>;
export type PeopleViewProps = Readonly<{
  language: string; waiting: boolean; concealed: boolean; hasSchool: boolean;
  list: ListState; record: RecordState; selectedId: string | null; outcome: SaveOutcome;
  /** True while a save from this tab is sending, or kept for "Try again": both forms stay locked. */
  locked: boolean; canRetry: boolean;
  onSearch?: ((query: string) => void) | undefined; onOpen?: ((personId: string) => void) | undefined; onReload?: (() => void) | undefined;
  onSaveContact?: ((draft: ContactDraft) => void) | undefined; onSaveBirth?: ((draft: BirthDraft) => void) | undefined;
  onTryAgain?: (() => void) | undefined; onDiscard?: (() => void) | undefined;
  /** The contact consent card for the open person (its own reads and commands); without it the saved summary is shown. */
  consentSlot?: ((record: PersonRecord) => React.ReactNode) | undefined;
}>;

const FIELD: Record<string, PeopleKey> = { givenName: 'givenNameField', familyName: 'familyNameField', email: 'emailField', phoneE164: 'phoneE164Field' };
export function outcomeText(language: string, outcome: SaveOutcome): Readonly<{ tone: 'ok' | 'waiting' | 'blocked'; text: string }> | null {
  const t: T = (key, vars) => peopleText(language, key, vars);
  if (!outcome) return null;
  switch (outcome.kind) {
    case 'SENDING': return { tone: 'waiting', text: t('saving') };
    case 'SAVED': return { tone: 'ok', text: outcome.command === 'contact'
      ? t('savedContact', { fields: outcome.fields.map(f => FIELD[f] ? t(FIELD[f]!) : f).join(', ') })
      : outcome.enrollmentCorrected ? t('savedEnrollment') : t('savedBirth') };
    case 'UNKNOWN': return { tone: 'waiting', text: t('unknown') };
    case 'BUSY': return { tone: 'waiting', text: t('busy') };
    case 'DENIED': return { tone: 'blocked', text: t('denied') };
    case 'OWNER_REQUIRED': return { tone: 'blocked', text: t('ownerRequired') };
    case 'INVALID': return { tone: 'blocked', text: t('invalid') };
    case 'LOCAL_INVALID': return { tone: 'blocked', text: outcome.command === 'contact' ? t('localInvalid') : t('localInvalidBirth') };
    case 'UNCHANGED': case 'LOCAL_UNCHANGED': return { tone: 'blocked', text: t('unchanged') };
    case 'MISSING': return { tone: 'blocked', text: t('missing') };
    case 'CONFLICT': return { tone: 'blocked', text: t('conflict') };
    case 'CONSENT': return { tone: 'blocked', text: t('consent') };
  }
}

/** Pure view. Every name, address and date comes from the school's people reads; nothing is shown before the shell verifies the school. */
export function PeopleView(props: PeopleViewProps): React.ReactElement {
  const { language, waiting, concealed, hasSchool, list, record, selectedId, onSearch, onOpen, onReload } = props;
  const t: T = (key, vars) => peopleText(language, key, vars);
  const searchId = useId();
  const notice = waiting ? t('waiting') : concealed ? t('concealed') : !hasSchool ? t('noSchool') : null;
  const visible = notice === null;
  return <section className={styles.people} aria-labelledby="people-title" data-hon-native="">
    <header className={styles.head}>
      <div><h1 id="people-title">{t('title')}</h1><p className={styles.intro}>{t('intro')}</p></div>
    </header>
    {notice ? <p className={styles.notice} role="status">{notice}</p> : null}
    {visible ? <div className={styles.layout}>
      <article className={styles.card} aria-labelledby="people-list-title">
        <h2 id="people-list-title">{t('listTitle')}</h2>
        <form className={styles.search} role="search" onSubmit={e => { e.preventDefault(); onSearch?.(String(new FormData(e.currentTarget).get('query') ?? '')); }}>
          <label htmlFor={searchId}>{t('searchLabel')}</label>
          <div className={styles.searchRow}>
            <input id={searchId} name="query" type="search" maxLength={PEOPLE_QUERY_MAX} autoComplete="off" defaultValue={list.state === 'READY' ? list.query : ''}/>
            <button type="submit" className={styles.secondary} disabled={list.state === 'LOADING'}>{t('searchButton')}</button>
          </div>
        </form>
        <PeopleList list={list} selectedId={selectedId} onOpen={onOpen} t={t}/>
      </article>
      <div className={styles.detail}>
        <RecordPanel {...props} t={t} onReload={onReload}/>
      </div>
    </div> : null}
  </section>;
}

function PeopleList({ list, selectedId, onOpen, t }: { list: ListState; selectedId: string | null; onOpen?: ((id: string) => void) | undefined; t: T }) {
  if (list.state === 'LOADING') return <p className={styles.meta} role="status">{t('listLoading')}</p>;
  if (list.state === 'DENIED') return <p className={styles.meta} role="status">{t('listDenied')}</p>;
  if (list.state === 'UNAVAILABLE') return <p className={styles.meta} role="status">{t('listUnavailable')}</p>;
  if (!list.items.length) return <p className={styles.meta}>{t('listNone')}</p>;
  return <>
    <ul className={styles.list} data-testid="people-list">{list.items.map(p => <li key={p.personId}>
      <button type="button" className={styles.person} aria-current={p.personId === selectedId ? 'true' : undefined} onClick={() => onOpen?.(p.personId)}>
        <strong>{p.givenName} {p.familyName}</strong>
        <small>{p.email ?? t('noEmail')} · {p.phoneE164 ?? t('noPhone')}</small>
      </button>
    </li>)}</ul>
    {list.items.length >= PEOPLE_LIST_LIMIT ? <p className={styles.meta}>{t('listCapped', { n: String(PEOPLE_LIST_LIMIT) })}</p> : null}
  </>;
}

function RecordPanel(props: PeopleViewProps & { t: T }) {
  const { record, t, onReload } = props;
  if (record.state === 'NONE') return <p className={styles.notice}>{t('pick')}</p>;
  if (record.state === 'LOADING') return <p className={styles.notice} role="status">{t('recordLoading')}</p>;
  if (record.state !== 'READY') return <div className={styles.notice} role="status">
    <p>{t(record.state === 'DENIED' ? 'recordDenied' : record.state === 'MISSING' ? 'recordMissing' : 'recordUnavailable')}</p>
    {record.state === 'UNAVAILABLE' && onReload ? <button type="button" className={styles.secondary} onClick={onReload}>{t('reload')}</button> : null}
  </div>;
  const r = record.record;
  return <>
    <ContactCard {...props} r={r}/>
    {props.consentSlot ? props.consentSlot(r) : null}
    {r.student ? <BirthCard {...props} r={r} student={r.student}/> : null}
  </>;
}

function Outcome({ props, command }: { props: PeopleViewProps & { t: T }; command: CommandKind }) {
  const { outcome, language, canRetry, onTryAgain, onDiscard, t } = props;
  if (!outcome || outcome.command !== command) return null;
  const status = outcomeText(language, outcome);
  if (!status) return null;
  const reload = outcome.kind === 'UNKNOWN' || outcome.kind === 'BUSY' || outcome.kind === 'CONFLICT' || outcome.kind === 'MISSING';
  return <div className={styles.outcome} data-tone={status.tone} role="status">
    <p>{status.text}</p>
    {reload ? <div className={styles.actions}>
      {canRetry && onTryAgain ? <button type="button" className={styles.primary} onClick={onTryAgain}>{t('tryAgain')}</button> : null}
      {onDiscard ? <button type="button" className={styles.secondary} onClick={onDiscard}>{t('discard')}</button> : null}
    </div> : null}
  </div>;
}

function ContactCard(props: PeopleViewProps & { t: T; r: PersonRecord }) {
  const { r, t, locked, onSaveContact } = props;
  const base = useId();
  const editable = r.canEdit && !!onSaveContact;
  const consent = (channel: 'EMAIL' | 'SMS') => r.consents[channel] === 'OPTED_IN';
  return <article className={styles.card} aria-labelledby={`${base}-title`}>
    <h2 id={`${base}-title`}>{t('detailsTitle')}</h2>
    {!r.canEdit ? <p className={styles.meta} role="note">{t('readOnly')}</p> : null}
    <form key={`${r.personId}:${r.version}`} className={styles.form} noValidate onSubmit={e => {
      e.preventDefault(); const f = new FormData(e.currentTarget), v = (k: string) => String(f.get(k) ?? '');
      onSaveContact?.({ givenName: v('givenName'), familyName: v('familyName'), email: v('email'), phone: v('phone') });
    }}>
      <fieldset disabled={!editable || locked} className={styles.fields}>
        <legend className={styles.hidden}>{t('detailsTitle')}</legend>
        <div className={styles.pair}>
          <div><label htmlFor={`${base}-given`}>{t('givenName')}</label>
            <input id={`${base}-given`} name="givenName" defaultValue={r.givenName} maxLength={120} required autoComplete="off"/></div>
          <div><label htmlFor={`${base}-family`}>{t('familyName')}</label>
            <input id={`${base}-family`} name="familyName" defaultValue={r.familyName} maxLength={120} required autoComplete="off"/></div>
        </div>
        <label htmlFor={`${base}-email`}>{t('email')}</label>
        <input id={`${base}-email`} name="email" type="email" defaultValue={r.email ?? ''} maxLength={320} autoComplete="off" aria-describedby={`${base}-email-help`}/>
        <small id={`${base}-email-help`} className={styles.meta}>{consent('EMAIL') ? t('consentLocked', { channel: t('EMAIL').toLowerCase() }) : t('emailHelp')}</small>
        <label htmlFor={`${base}-phone`}>{t('phone')}</label>
        <input id={`${base}-phone`} name="phone" type="tel" inputMode="tel" defaultValue={r.phoneE164 ?? ''} maxLength={16} autoComplete="off" aria-describedby={`${base}-phone-help`}/>
        <small id={`${base}-phone-help`} className={styles.meta}>{consent('SMS') ? t('consentLocked', { channel: t('SMS').toLowerCase() }) : t('phoneHelp')}</small>
      </fieldset>
      {props.consentSlot ? null : <dl className={styles.consents} aria-label={t('consentTitle')}>
        {(['EMAIL', 'SMS'] as const).map(c => <div key={c}><dt>{t(c)}</dt><dd><span className={styles.status} data-tone={r.consents[c] === 'OPTED_IN' ? 'ready' : 'planned'}>{t(r.consents[c])}</span></dd></div>)}
      </dl>}
      {editable ? <div className={styles.actions}><button type="submit" className={styles.primary} disabled={locked}>{t('save')}</button></div> : null}
    </form>
    <Outcome props={props} command="contact"/>
  </article>;
}

function BirthCard(props: PeopleViewProps & { t: T; r: PersonRecord; student: NonNullable<PersonRecord['student']> }) {
  const { r, student, t, locked, language, onSaveBirth } = props;
  const base = useId();
  const canCorrect = r.canEdit && !!onSaveBirth && student.version !== undefined;
  const shown = student.birthDate ? new Intl.DateTimeFormat(language, { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(`${student.birthDate}T00:00:00Z`)) : t('birthNone');
  return <article className={styles.card} aria-labelledby={`${base}-title`}>
    <h2 id={`${base}-title`}>{t('studentTitle')}</h2>
    <p className={styles.meta}>{t('studentStatus', { status: accountValue(language, student.status) })}</p>
    <p className={styles.value}><span>{t('birthDate')}:</span> <strong data-testid="person-birth-date">{shown}</strong></p>
    {r.canEdit && student.version === undefined ? <p className={styles.meta} role="note">{t('birthReload')}</p> : null}
    {canCorrect ? <form key={`${r.personId}:${student.version}`} className={styles.form} noValidate onSubmit={e => {
      e.preventDefault(); const f = new FormData(e.currentTarget);
      onSaveBirth?.({ birthDate: String(f.get('birthDate') ?? ''), reason: String(f.get('reason') ?? '') });
    }}>
      <fieldset disabled={locked} className={styles.fields}>
        <legend className={styles.hidden}>{t('studentTitle')}</legend>
        <label htmlFor={`${base}-date`}>{t('birthDate')}</label>
        <input id={`${base}-date`} name="birthDate" type="date" min="1900-01-01" max={localToday()} defaultValue={student.birthDate ?? ''} required/>
        <label htmlFor={`${base}-reason`}>{t('reason')}</label>
        <textarea id={`${base}-reason`} name="reason" rows={2} maxLength={300} required aria-describedby={`${base}-reason-help ${base}-owner`}/>
        <small id={`${base}-reason-help`} className={styles.meta}>{t('reasonHelp')}</small>
        <small id={`${base}-owner`} className={styles.meta}>{t('ownerRule')}</small>
      </fieldset>
      <div className={styles.actions}><button type="submit" className={styles.primary} disabled={locked}>{t('saveBirth')}</button></div>
    </form> : null}
    <Outcome props={props} command="birthDate"/>
  </article>;
}
