import React from 'react';
import type { HqInvitationCounts, HqSchoolDetail } from '@hon/contracts';
import { accessText } from '../hq-access/copy';
import { schoolDetailText, type SchoolDetailKey } from './copy';
import styles from '../hq-access/hq-access.module.css';

export type SchoolDetailState =
  | { state: 'LOADING' } | { state: 'DENIED' } | { state: 'GONE' } | { state: 'INVALID' } | { state: 'UNAVAILABLE' }
  | { state: 'READY'; view: HqSchoolDetail };
export type SchoolDetailViewProps = Readonly<{ language: string; formattingLocale: string; concealed: boolean; state: SchoolDetailState; busy: boolean;
  onRefresh: () => void; onReveal: () => void }>;

const STATUS = new Set(['ACTIVE', 'SUSPENDED', 'ARCHIVED']);
const tone = (status: string) => status === 'PAID_ACCESS' || status === 'PROVISIONED_ACCESS' || status === 'EXCEPTION_IN_EFFECT' ? 'ready'
  : status === 'NO_ACCESS' ? 'blocked' : 'waiting';

function Facts({ rows }: { rows: readonly [string, React.ReactNode][] }) {
  return <dl className={styles.facts}>{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
}

/** Presentation only. Every fact comes from the verified server answer; nothing here is inferred. */
export function HqSchoolDetailView(props: SchoolDetailViewProps): React.ReactElement {
  const { language, formattingLocale, concealed, state, busy } = props;
  const t = (key: SchoolDetailKey, vars?: Record<string, string>) => schoolDetailText(language, key, vars);
  const date = (iso: string) => new Intl.DateTimeFormat(formattingLocale, { timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric' }).format(new Date(iso));
  const time = (iso: string) => new Intl.DateTimeFormat(formattingLocale, { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
  const status = (s: string) => t((STATUS.has(s) ? s : 'OTHER') as SchoolDetailKey);
  const head = <header className={styles.head}>
    <div><p className={styles.meta}><a href="/hq/schools">{t('back')}</a></p><h1>{state.state === 'READY' && !concealed ? state.view.school.schoolDisplayName || t('title') : t('title')}</h1>
      <p className={styles.intro}>{t('intro')}</p></div>
    {!concealed && <button type="button" className={styles.secondary} disabled={busy || state.state === 'INVALID'} onClick={props.onRefresh}>{t('refresh')}</button>}
  </header>;
  if (concealed) return <section className={styles.access} data-hq-school-detail="concealed">{head}
    <div className={styles.notice} role="status"><p>{t('concealed')}</p><button type="button" className={styles.secondary} onClick={props.onReveal}>{t('reveal')}</button></div></section>;
  if (state.state !== 'READY') {
    const key: SchoolDetailKey = state.state === 'LOADING' ? 'loading' : state.state === 'DENIED' ? 'denied' : state.state === 'GONE' ? 'gone' : state.state === 'INVALID' ? 'invalid' : 'unavailable';
    return <section className={styles.access} data-hq-school-detail={state.state.toLowerCase()} aria-busy={state.state === 'LOADING'}>{head}
      <p className={styles.notice} role="status">{t(key)}</p></section>;
  }
  const v = state.view, org = v.organization;
  const counts = (kind: 'OWNER' | 'STAFF' | 'FAMILY', c: HqInvitationCounts) => <tr key={kind}><th scope="row">{t(`kind${kind}` as SchoolDetailKey)}</th>
    <td>{c.pending}</td><td>{c.expired}</td><td>{c.accepted}</td><td>{c.revoked}</td><td>{kind === 'FAMILY' ? c.ended : '—'}</td></tr>;
  const x = org.currentException;
  return <section className={styles.access} data-hq-school-detail="ready">{head}
    {!v.viewer.canManageOwnership && <p className={styles.notice}>{t('viewerOperator')}</p>}

    <article className={styles.card} aria-labelledby="hq-sd-school"><div className={styles.cardHead}><h2 id="hq-sd-school">{t('sectionSchool')}</h2>
      <span className={styles.status} data-tone={v.school.schoolStatus === 'ACTIVE' ? 'ready' : 'blocked'}>{status(v.school.schoolStatus)}</span></div>
      <Facts rows={[[t('slug'), v.school.slug], [t('timezone'), v.school.timezone], [t('schoolStatus'), status(v.school.schoolStatus)], [t('created'), `${date(v.school.createdAt)} UTC`]]}/>
    </article>

    <article className={styles.card} aria-labelledby="hq-sd-access"><div className={styles.cardHead}><h2 id="hq-sd-access">{t('sectionAccess')}</h2>
      <span className={styles.status} data-tone={tone(org.accessStatus)}>{accessText(language, org.accessStatus)}</span></div>
      <Facts rows={[[t('organization'), org.organizationDisplayName], [t('organizationStatus'), status(org.organizationStatus)],
        [t('plan'), org.entitlement ? `${org.entitlement.tier} · ${t(org.entitlement.inEffect ? 'inEffect' : 'notInEffect')}` : t('planNone')],
        [t('exception'), x ? `${accessText(language, x.purpose)} · ${t('exceptionWindow', { from: date(x.startsAt), to: date(x.expiresAt) })}` : t('exceptionNone')],
        [t('subscription'), org.subscription ? `${org.subscription.planCode} · ${org.subscription.status}` : t('subscriptionNone')],
        [t('ownerInvite'), accessText(language, org.ownerOnboarding.status)]]}/>
      {!v.exceptionPolicyReady && <p className={styles.meta}>{t('policyMissing')}</p>}
      {org.exceptionGrant.blockers.length > 0 && <p className={styles.meta}>{accessText(language, 'cannotGrant')} {org.exceptionGrant.blockers.map(b => accessText(language, b)).join('; ')}.</p>}
      <div className={styles.actions}><a className={styles.secondary} href="/hq/schools/access">{t('openAccess')}</a></div>
    </article>

    <article className={styles.card} aria-labelledby="hq-sd-owners"><div className={styles.cardHead}><h2 id="hq-sd-owners">{t('sectionOwners')}</h2></div>
      <Facts rows={[[t('ownerCount'), String(v.ownership.ownerCount)], [t('primary'), t(v.ownership.primaryOwnerGrantId ? 'primarySet' : 'primaryNone')],
        [t('hqSeats'), t('hqSeatsValue', { n: String(v.ownership.hqSeatCount) })]]}/>
      {v.ownership.ownerCount === 0 && <p className={styles.meta}>{t('noOwners')}</p>}
      {v.ownership.primaryNeeded && <p className={styles.outcome} data-tone="waiting" role="note">{t('primaryNeeded')}</p>}
      <div className={styles.actions}><a className={styles.secondary} href="/hq/schools/owners">{t('manageOwners')}</a>
        <a className={styles.secondary} href="/hq/school-owner-invitations">{t('inviteOwner')}</a></div>
    </article>

    <article className={styles.card} aria-labelledby="hq-sd-invitations"><div className={styles.cardHead}><h2 id="hq-sd-invitations">{t('sectionInvitations')}</h2></div>
      <div role="region" aria-labelledby="hq-sd-invitations" tabIndex={0} style={{ overflowX: 'auto' }}>
        <table><thead><tr><th scope="col">{t('kind')}</th><th scope="col">{t('pending')}</th><th scope="col">{t('expired')}</th><th scope="col">{t('accepted')}</th>
          <th scope="col">{t('revoked')}</th><th scope="col">{t('ended')}</th></tr></thead>
          <tbody>{counts('OWNER', v.invitations.owner)}{counts('STAFF', v.invitations.staff)}{counts('FAMILY', v.invitations.family)}</tbody></table>
      </div>
    </article>

    <article className={styles.card} aria-labelledby="hq-sd-people"><div className={styles.cardHead}><h2 id="hq-sd-people">{t('sectionPeople')}</h2></div>
      <Facts rows={[[t('staffWithAccess'), String(v.people.staffWithAccess)], [t('familyMembersWithAccess'), String(v.people.familyMembersWithAccess)],
        [t('activeStudents'), String(v.people.activeStudents)]]}/>
      <p className={styles.meta}>{t('staffHelp')}</p>
    </article>
    <p className={styles.meta}>{t('asOf', { time: time(v.asOf) })}</p>
  </section>;
}
