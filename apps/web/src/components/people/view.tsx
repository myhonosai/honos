import React, { useEffect, useId, useRef, useState } from 'react';
import type { PersonRecord, SchoolContactCard, SchoolContactOptions } from '@hon/contracts';
import { accountValue } from '../account-status/copy';
import { peopleText, type PeopleKey } from './copy';
import { ContactsList } from './contacts-list';
import { ContactCard as ContactCardTabs, type CardState, type CardTab, type AgreementSlot, type MembershipSlot, type MembershipToolsSlot } from './contact-card';
import type { ContactFilters } from './contacts-http';
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
  /** The contacts list filters (C1, 0521) and the rank, program and plan choices read with the first page. */
  filters: ContactFilters; options: SchoolContactOptions | null;
  /** The open person's contact card (C2, 0522), read beside the editable record. */
  card?: CardState | undefined;
  /** The tab the card opens on (a People link can ask for one), and the actions under each membership. */
  cardTab?: CardTab | undefined; membershipSlot?: MembershipSlot | undefined; membershipTools?: MembershipToolsSlot | undefined; agreementSlot?: AgreementSlot | undefined;
  /** C3 (0523): delete, restore and merge for the open contact (its own reads and commands), and what the last one did. */
  actionsSlot?: ((card: SchoolContactCard) => React.ReactNode) | undefined; actionNotice?: string | null | undefined;
  onFilters?: ((filters: ContactFilters) => void) | undefined; onMore?: (() => void) | undefined; onOpen?: ((personId: string) => void) | undefined; onReload?: (() => void) | undefined;
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
  const { language, waiting, concealed, hasSchool, list, selectedId, onOpen, onReload } = props;
  const t: T = (key, vars) => peopleText(language, key, vars);
  const notice = waiting ? t('waiting') : concealed ? t('concealed') : !hasSchool ? t('noSchool') : null;
  const visible = notice === null;
  // Edit profile pop-up (owner, 2026-11-21): the name, contact, consent and child-detail forms open from the button beside the
  // name instead of sitting under the card. Without a readable card the forms stay inline, so editing never disappears.
  const [profileFor, setProfileFor] = useState<string | null>(null);
  const cardReady = props.card?.state === 'READY', cardLoading = props.card?.state === 'LOADING';
  const profileOpen = !!selectedId && profileFor === selectedId && cardReady;
  const canOpenProfile = !!selectedId && cardReady && props.record.state !== 'NONE';
  const recordPanel = <RecordPanel {...props} t={t} onReload={onReload}/>;
  return <section className={styles.people} aria-labelledby="people-title" data-hon-native="">
    <header className={styles.head}>
      <div><h1 id="people-title">{t('title')}</h1><p className={styles.intro}>{t('intro')}</p></div>
    </header>
    {notice ? <p className={styles.notice} role="status">{notice}</p> : null}
    {visible ? <div className={styles.layout}>
      <article className={styles.card} aria-labelledby="people-list-title">
        <h2 id="people-list-title">{t('listTitle')}</h2>
        <ContactsList language={language} list={list} filters={props.filters} options={props.options} selectedId={selectedId} pt={t}
          onOpen={onOpen} onFilters={props.onFilters} onMore={props.onMore}/>
      </article>
      <div className={styles.detail}>
        {props.actionNotice ? <p className={styles.notice} role="status" data-testid="contact-action-done">{props.actionNotice}</p> : null}
        {props.card && selectedId ? <ContactCardTabs key={selectedId} language={language} card={props.card} initialTab={props.cardTab ?? 'overview'} membershipSlot={props.membershipSlot} membershipTools={props.membershipTools} agreementSlot={props.agreementSlot}
          onEditProfile={canOpenProfile ? () => setProfileFor(selectedId) : undefined}/> : null}
        {props.card?.state === 'READY' && props.actionsSlot ? props.actionsSlot(props.card.card) : null}
        {props.record.state === 'NONE' || (!cardReady && !cardLoading) ? recordPanel : null}
        {profileOpen ? <ProfileDialog t={t} onClose={() => setProfileFor(null)}>{recordPanel}</ProfileDialog> : null}
      </div>
    </div> : null}
  </section>;
}

/** A modal pop-up over the People page. Escape, the close button or a click outside closes it; focus returns to Edit profile. */
function ProfileDialog({ t, onClose, children }: { t: T; onClose: () => void; children: React.ReactNode }): React.ReactElement {
  const title = useId(), close = useRef<HTMLButtonElement>(null), box = useRef<HTMLDivElement>(null), latest = useRef(onClose);
  latest.current = onClose;
  // Runs once per opening: a re-render while staff type never moves focus. Tab and Shift+Tab stay inside the pop-up.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    close.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { latest.current(); return; }
      if (e.key !== 'Tab' || !box.current) return;
      const items = [...box.current.querySelectorAll<HTMLElement>('a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])')]
        .filter(el => !el.hasAttribute('disabled') && el.getClientRects().length > 0);
      const first = items[0], last = items[items.length - 1];
      if (!first || !last) return;
      if (e.shiftKey && (document.activeElement === first || !box.current.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || !box.current.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); opener?.focus(); };
  }, []);
  return <div className={styles.backdrop} onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div ref={box} className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby={title} data-testid="contact-profile-dialog">
      <header className={styles.dialogHead}>
        <div><h2 id={title}>{t('profileTitle')}</h2><p className={styles.meta}>{t('profileIntro')}</p></div>
        <button ref={close} type="button" className={styles.dialogClose} aria-label={t('profileClose')} onClick={onClose}>×</button>
      </header>
      {children}
    </div>
  </div>;
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
