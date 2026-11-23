import React, { useState } from 'react';
import type { SchoolContactCard } from '@hon/contracts';
import { cardText, codeLabel, type CardKey } from './contact-card-copy';
import { contactsText } from './contacts-copy';
import { endBadge } from './contacts-list';
import { Fold } from './fold';
import styles from './people.module.css';

/** The contact card (C2, 0522) as read for the open person. */
export type CardState =
  | Readonly<{ state: 'NONE' }> | Readonly<{ state: 'LOADING' }> | Readonly<{ state: 'UNAVAILABLE' }> | Readonly<{ state: 'READY'; card: SchoolContactCard }>;
export const CARD_TABS = ['overview', 'family', 'appointments', 'tasks', 'membership', 'billing', 'messages', 'timeline'] as const;
export type CardTab = typeof CARD_TABS[number];
type T = (key: CardKey, vars?: Readonly<Record<string, string | number>>) => string;

export function formatMinor(language: string, currency: string, minor: number): string {
  try {
    const f = new Intl.NumberFormat(language, { style: 'currency', currency });
    const digits = f.resolvedOptions().maximumFractionDigits ?? 2;
    return f.format(minor / 10 ** digits);
  } catch { return `${currency} ${minor}`; }
}
const day = (language: string, at: string) => new Intl.DateTimeFormat(language, { dateStyle: 'medium' }).format(new Date(at));
const when = (language: string, at: string) => new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(at));

/** Tabs for one contact. A tab the viewer's role does not include says so; nothing is guessed. */
export type MembershipItem = SchoolContactCard['membership'] extends infer M ? M extends { items: readonly (infer I)[] } ? I : never : never;
/** The People page puts each membership's actions here (pause, cancel, start, …); the card itself only shows what the server read. */
export type MembershipSlot = (item: MembershipItem) => React.ReactNode;
/** The People page puts New membership and Renew here, at the top of the membership tab (shown even before the first membership). */
export type MembershipToolsSlot = (items: readonly MembershipItem[]) => React.ReactNode;
export function ContactCard({ language, card, initialTab = 'overview', membershipSlot, membershipTools, onEditProfile }: { language: string; card: CardState; initialTab?: CardTab;
  membershipSlot?: MembershipSlot | undefined; membershipTools?: MembershipToolsSlot | undefined;
  /** Opens the Edit profile pop-up; absent while the person's record cannot be edited or read yet. */
  onEditProfile?: (() => void) | undefined }): React.ReactElement | null {
  const [tab, setTab] = useState<CardTab>(initialTab);
  const t: T = (key, vars) => cardText(language, key, vars);
  if (card.state === 'NONE') return null;
  if (card.state === 'LOADING') return <p className={styles.notice} role="status">{t('loading')}</p>;
  if (card.state === 'UNAVAILABLE') return <p className={styles.notice} role="status">{t('unavailable')}</p>;
  const c = card.card;
  const allowed = (k: CardTab) => k === 'overview' || k === 'timeline' || (c[k] as { allowed: boolean }).allowed;
  return <article className={styles.card} aria-label={`${c.person.givenName} ${c.person.familyName}`} data-testid="contact-card">
    <header className={styles.personHead}>
      <span className={styles.headTools}>
        <h2>{c.person.givenName} {c.person.familyName}</h2>
        {onEditProfile ? <button type="button" className={styles.editProfile} data-testid="contact-edit-profile" aria-haspopup="dialog" onClick={onEditProfile}>
          <span aria-hidden="true">✎</span>{t('editProfile')}</button> : null}
      </span>
      <span className={styles.segment} data-segment={c.overview.segment}>{contactsText(language, `row${c.overview.segment}`)}</span>
    </header>
    <div className={styles.tabs} role="group" aria-label={t('tabsLabel')}>
      {CARD_TABS.map(k => <button key={k} type="button" className={styles.tab} aria-pressed={tab === k} data-tab={k} data-allowed={allowed(k) ? 'true' : 'false'}
        onClick={() => setTab(k)}>{t(k)}{k === 'messages' && c.messages.allowed ? <span className={styles.count}>{c.messages.direct + (c.messages.family ?? 0)}</span> : null}</button>)}
    </div>
    <div className={styles.tabBody} data-testid={`contact-tab-${tab}`}><Body language={language} c={c} tab={tab} t={t} slot={membershipSlot} tools={membershipTools}/></div>
  </article>;
}

function Body({ language, c, tab, t, slot, tools }: { language: string; c: SchoolContactCard; tab: CardTab; t: T; slot?: MembershipSlot | undefined;
  tools?: MembershipToolsSlot | undefined }): React.ReactElement {
  const denied = <p className={styles.meta} role="note">{t('notAllowed')}</p>;
  const none = <p className={styles.meta}>{t('none')}</p>;
  switch (tab) {
    case 'overview': {
      const o = c.overview, badge = endBadge(language, o.membershipEndsAt);
      return <Fold id="overview-details" title={t('foldDetails')}><dl className={styles.facts2}>
        <div><dt>{t('plan')}</dt><dd>{o.planName ?? t('noPlan')}{o.programName ? ` · ${o.programName}` : ''}</dd></div>
        <div><dt>{t('ends')}</dt><dd>{badge ? <span className={styles.ends} data-tone={badge.tone}>{badge.text}</span> : '—'}</dd></div>
        <div><dt>{t('belt')}</dt><dd>{o.ranks.length ? o.ranks.map((r, i) => <span key={i} className={styles.rank}>
          <span className={styles.swatch} style={r.color ? { background: r.color } : undefined} aria-hidden="true"/>{r.curriculum}: {r.rank}</span>) : t('noBelt')}</dd></div>
        <div><dt>{t('added')}</dt><dd>{t('addedOn', { date: day(language, c.person.createdAt) })}{o.openLead ? ` · ${t('openLead')}` : ''}</dd></div>
      </dl></Fold>;
    }
    case 'family':
      if (!c.family.allowed) return denied;
      if (!c.family.families.length) return none;
      return <>{c.family.families.map(f => <Fold key={f.familyId} id={`family-${f.familyId}`} title={f.name} count={f.members.length}>
        <ul className={styles.plain}>{f.members.map(m => <li key={m.personId}>
          <strong>{m.givenName} {m.familyName}</strong> · {t(`role_${m.role}` as CardKey)}{m.billingContact ? ` · ${t('billingContact')}` : ''}</li>)}</ul></Fold>)}</>;
    case 'appointments':
      if (!c.appointments.allowed) return denied;
      if (!c.appointments.items.length) return none;
      return <Fold id="appointments" title={t('appointments')} count={c.appointments.items.length}><ul className={styles.plain}>{c.appointments.items.map((a, i) => <li key={i}>
        <strong>{when(language, a.startsAt)}</strong> · {codeLabel(language, a.type)} · {codeLabel(language, a.status)}</li>)}</ul></Fold>;
    case 'tasks':
      if (!c.tasks.allowed) return denied;
      if (!c.tasks.items.length) return none;
      return <Fold id="tasks" title={t('tasks')} count={c.tasks.items.length}><ul className={styles.plain}>{c.tasks.items.map((a, i) => <li key={i}>
        <strong>{a.title}</strong> · {t(`priority_${a.priority}` as CardKey)}{a.dueAt ? ` · ${t('due', { date: day(language, a.dueAt) })}` : ''}</li>)}</ul></Fold>;
    case 'membership':
      if (!c.membership.allowed) return denied;
      return <>{tools ? <Fold id="membership-start" title={t('foldStart')}>{tools(c.membership.items)}</Fold> : null}
        <Fold id="membership-list" title={t('foldMemberships')} count={c.membership.items.length}>{c.membership.items.length ? <ul className={styles.plain}>{c.membership.items.map(m => <li key={m.membershipId} data-testid="card-membership">
        <strong>{m.planName ?? m.planCode}</strong> · {codeLabel(language, m.state)}
        {m.startedAt ? ` · ${day(language, m.startedAt)}` : ''}{m.endsAt ? ` – ${day(language, m.endsAt)}` : ''}{slot ? slot(m) : null}</li>)}</ul> : none}</Fold></>;
    case 'billing':
      if (!c.billing.allowed) return denied;
      return <>
        <p className={styles.value}><span>{t('openBalance')}:</span> <strong>{c.billing.open.length ? c.billing.open.map(o => formatMinor(language, o.currency, o.dueMinor)).join(' · ') : t('nothingOwed')}</strong></p>
        <Fold id="billing-invoices" title={t('foldInvoices')} count={c.billing.invoices.length}>{c.billing.invoices.length ? <ul className={styles.plain}>{c.billing.invoices.map((i, n) => <li key={n}>
          <strong>{day(language, i.createdAt)}</strong> · {codeLabel(language, i.status)} · {t('paidOf', { paid: formatMinor(language, i.currency, i.paidMinor), total: formatMinor(language, i.currency, i.totalMinor) })}
          {i.dueAt && i.status === 'ISSUED' ? ` · ${t('due', { date: day(language, i.dueAt) })}` : ''}</li>)}</ul> : none}</Fold>
      </>;
    case 'messages':
      if (!c.messages.allowed) return denied;
      return <ul className={styles.plain}><li>{t('directMessages', { n: c.messages.direct })}</li>{c.messages.family === null ? null : <li>{t('familyMessages', { n: c.messages.family })}</li>}</ul>;
    case 'timeline':
      return <>
        <p className={styles.meta}>{t('timelineNote')}</p>
        <Fold id="timeline" title={t('foldEvents')} count={c.timeline.length}><ol className={styles.timeline}>{c.timeline.map((e, i) => <li key={i}><time dateTime={e.at}>{day(language, e.at)}</time>
          <span>{t(`kind_${e.kind}` as CardKey)}{e.kind === 'APPOINTMENT' || e.kind === 'ATTENDANCE' ? detail(language, e.detail) : ''}</span></li>)}</ol></Fold>
      </>;
  }
}
/** Appointment and attendance details are closed codes; payment and plan details are not shown in words here. */
function detail(language: string, value: string | null): string {
  if (!value) return '';
  return ` · ${value.split(' ').map(v => codeLabel(language, v)).join(' · ')}`;
}
