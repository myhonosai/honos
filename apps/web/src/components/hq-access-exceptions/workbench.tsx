'use client';
import React, { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react';
import Link from 'next/link';
import { SAAS_ACCESS_EXCEPTION_PURPOSES, type SaasAccessException } from '@hon/contracts';
import { formatLocaleDateTime } from '@hon/design-system';
import { useLocale } from '../localization/provider';
import { useHqModern } from '../hq-modern/shell';
import { AccessExceptionController, bindExceptionPrivacy, blockers } from './controller';
import { exceptionCatalog, exceptionText, type CopyKey } from './catalog';
import styles from './workbench.module.css';

export function HqAccessExceptionsLink(): React.ReactElement {
  const { preferences } = useLocale();
  return <p><Link className={styles.link} href="/hq/access-exceptions">{exceptionText(preferences.language, 'title')} →</Link></p>;
}
export function HqAccessExceptions(): React.ReactElement {
  const [controller] = useState(() => new AccessExceptionController()), facts = useRef<HTMLDivElement>(null);
  useEffect(() => {
    controller.start();
    const unbind = bindExceptionPrivacy(controller, () => { if (facts.current) { facts.current.hidden = true; facts.current.inert = true; } }, window, document);
    const leave = (event: BeforeUnloadEvent) => { if (controller.retainsRequest() || controller.snapshot().busy) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', leave);
    return () => { unbind(); controller.stop(); window.removeEventListener('beforeunload', leave); };
  }, [controller]);
  return <AccessExceptionView controller={controller} facts={facts} />;
}
/** The production view is also used directly in deterministic presentation tests; there is no bypass route. */
export function AccessExceptionView({ controller, facts }: { controller: AccessExceptionController; facts?: RefObject<HTMLDivElement | null> }): React.ReactElement {
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot), fallback = useRef<HTMLDivElement>(null);
  const { preferences, number } = useLocale(), { view } = useHqModern();
  const t = (key: CopyKey) => exceptionText(preferences.language, key);
  const label = (value: string) => Object.hasOwn(exceptionCatalog.en, value) ? t(value as CopyKey) : value;
  const date = (value: string) => formatLocaleDateTime({ ...preferences, timeZone: 'UTC' }, value) + ' UTC';
  const profile = (value: string) => t(value === 'CORE' ? 'standard' : 'complete');
  const selected = state.data?.exceptions.exceptions.filter(x => x.schoolId === state.selectors.schoolId) ?? [];
  const chosen = selected.find(x => x.exceptionId === state.revokeId), failures = state.data ? blockers(state.data) : [];
  const ack = (copy: CopyKey) => <label className={styles.confirm}><input type="checkbox" checked={state.confirmed} disabled={state.busy} onChange={e => controller.confirm(e.target.checked)} />{t(copy)}</label>;
  const exception = (x: SaasAccessException, receipt = false) => <article className={styles.record} key={x.exceptionId}>
    <h3>{label(x.purpose)}</h3>
    <dl className={styles.facts}>
      <div><dt>{t('exceptionId')}</dt><dd><code>{x.exceptionId}</code></dd></div>
      <div><dt>{t('schoolId')}</dt><dd><code>{x.schoolId}</code></dd></div>
      <div><dt>{t('lifecycle')}</dt><dd>{label(x.lifecycle)}</dd></div>
      <div><dt>{t('profile')}</dt><dd>{profile(x.scopeTier)}</dd></div>
      <div><dt>{t('starts')}</dt><dd><time dateTime={x.startsAt}>{date(x.startsAt)}</time></dd></div>
      <div><dt>{t('expires')}</dt><dd><time dateTime={x.expiresAt}>{date(x.expiresAt)}</time></dd></div>
      <div><dt>{t('reasonLabel')}</dt><dd dir="auto">{x.reason}</dd></div>
      <div><dt>{t('governing')}</dt><dd>{x.governingPolicy ? <><code>{x.governingPolicy.approvalId}</code><br />{t('revision')}: {number(x.governingPolicy.revision)} · {t('limit')}: {number(x.governingPolicy.maxDays)}</> : t('unverified')}</dd></div>
    </dl>
    <details><summary>{t('capability')}</summary><p>{t('capabilityNote')}</p><ul>{x.capabilities.map(value => <li key={value}><code>{value}</code></li>)}</ul></details>
    {!receipt && x.status === 'GRANTED' && <button type="button" disabled={state.busy || !!state.pending} onClick={() => controller.selectRevoke(x.exceptionId)}>{t('revoke')}</button>}
  </article>;
  return <div className={`${styles.page} ${styles[`view_${view}`]}`} data-access-exceptions data-access-exceptions-busy={state.busy}>
    <header><h2>{t('title')}</h2><p>{t('intro')}</p></header>
    <aside className={styles.notice}>{t('boundary')}</aside>
    <p role="status" aria-live="polite" aria-atomic="true" className={styles.status}>{label(state.busy ? 'WORKING' : state.message)}</p>
    {state.hidden && <section className={styles.panel}><h2>{t('hidden')}</h2><p>{t('hiddenNote')}</p>
      {state.status === 'signed-out' && <p><Link className={styles.link} href="/auth/login">{t('signIn')}</Link></p>}
      <button type="button" disabled={state.busy} onClick={() => void controller.restore()}>{t('restore')}</button>
    </section>}
    <div ref={facts ?? fallback} hidden={state.hidden} inert={state.hidden} data-access-exceptions-facts>
      <section className={styles.panel} aria-labelledby="exception-selectors"><h2 id="exception-selectors">{t('selectors')}</h2><p>{t('selectorNote')}</p><p>{t('mappingNote')}</p>
        <form onSubmit={e => { e.preventDefault(); void controller.load(); }}><fieldset disabled={state.busy || !!state.pending} className={styles.fields}>
          <label>{t('organizationId')}<input name="organizationId" value={state.selectors.organizationId} required autoComplete="off" maxLength={36} onChange={e => controller.editSelector('organizationId', e.target.value)} /></label>
          <label>{t('schoolId')}<input name="schoolId" value={state.selectors.schoolId} required autoComplete="off" maxLength={36} onChange={e => controller.editSelector('schoolId', e.target.value)} /></label>
        </fieldset><button type="submit" disabled={state.busy}>{t('load')}</button></form>
      </section>
      {state.pending ? <section className={`${styles.panel} ${styles.notice}`} aria-labelledby="exception-retry"><h2 id="exception-retry">{t('retryTitle')}</h2><p>{t('retryNote')}</p>
        <h3>{t(state.pending.kind === 'grant' ? 'grant' : 'revokeTitle')}</h3>
        <dl className={styles.facts}><div><dt>{t('organizationId')}</dt><dd><code>{state.pending.target.organizationId}</code></dd></div><div><dt>{t('schoolId')}</dt><dd><code>{state.pending.target.schoolId}</code></dd></div>
          {state.pending.exceptionId && <div><dt>{t('exceptionId')}</dt><dd><code>{state.pending.exceptionId}</code></dd></div>}
          {Object.entries(JSON.parse(state.pending.body) as Record<string, unknown>).filter(([key]) => ['purpose','reason','scopeTier','startsAt','expiresAt','expectedEntitlementVersion'].includes(key)).map(([key, value]) => <div key={key}><dt>{t(({ purpose: 'purpose', reason: 'reasonLabel', scopeTier: 'profile', startsAt: 'starts', expiresAt: 'expires', expectedEntitlementVersion: 'version' } as Record<string, CopyKey>)[key]!)}</dt><dd>{typeof value === 'number' ? number(value) : key === 'scopeTier' ? profile(String(value)) : ['startsAt','expiresAt'].includes(key) ? date(String(value)) : key === 'purpose' ? label(String(value)) : String(value)}</dd></div>)}
        </dl>{ack('retryConfirm')}<button type="button" disabled={state.busy || !state.confirmed} onClick={() => void controller.retry()}>{t('retryButton')}</button>
      </section> : null}
      {state.receipt && <section className={styles.panel} aria-labelledby="exception-receipt"><h2 id="exception-receipt">{t('receipt')}</h2><p>{t(state.receipt.data.replayed ? 'replayed' : 'recorded')}</p><p>{t('receiptNote')}</p>
        {exception(state.receipt.data.exception, true)}
        {state.receipt.kind === 'revoke' && <p>{t(state.receipt.data.entitlementSuspended ? 'suspended' : 'notSuspended')}</p>}
      </section>}
      {state.data && <>
        <section className={styles.panel} aria-labelledby="exception-policy"><h2 id="exception-policy">{t('policy')}</h2><p>{t('policyNote')}</p>
          <dl className={styles.facts}>
            <div><dt>{t('policyStatus')}</dt><dd>{label(state.data.policy.effectiveStatus)}</dd></div><div><dt>{t('terms')}</dt><dd>{label(state.data.policy.termsStatus)}</dd></div>
            <div><dt>{t('paidProgram')}</dt><dd>{label(state.data.policy.paidAccessProgram)}</dd></div><div><dt>{t('creditProgram')}</dt><dd>{label(state.data.policy.aiCreditProgram)}</dd></div>
            {state.data.policy.current && <><div><dt>{t('decisionStatus')}</dt><dd>{label(state.data.policy.current.status)}</dd></div><div><dt>{t('policyId')}</dt><dd><code>{state.data.policy.current.approvalId}</code></dd></div><div><dt>{t('revision')}</dt><dd>{number(state.data.policy.current.revision)}</dd></div>
              <div><dt>{t(state.data.policy.current.status === 'APPROVED' ? 'limit' : 'decisionLimit')}</dt><dd>{number(state.data.policy.current.maxDays)}</dd></div><div><dt>{t('policyFrom')}</dt><dd>{date(state.data.policy.current.validFrom)}</dd></div><div><dt>{t('policyUntil')}</dt><dd>{date(state.data.policy.current.validUntil)}</dd></div></>}
          </dl>{!state.data.policy.current && <p>{t('noPolicy')}</p>}
        </section>
        <section className={styles.panel} aria-labelledby="exception-current"><h2 id="exception-current">{t('current')}</h2>
          <p>{t('asOf')}: {date(state.data.exceptions.asOf)}</p><p>{t('eligibilityNote')}</p>
          <dl className={styles.facts}><div><dt>{t('organization')}</dt><dd dir="auto">{state.data.subscription.organizationName}</dd></div><div><dt>{t('state')}</dt><dd>{label(state.data.exceptions.access.state)}</dd></div>
            <div><dt>{t('entitlement')}</dt><dd>{label(state.data.exceptions.access.entitlement?.status ?? 'NONE')}</dd></div><div><dt>{t('version')}</dt><dd>{state.data.exceptions.access.entitlement ? number(state.data.exceptions.access.entitlement.version) : '—'}</dd></div>
          </dl><details><summary>{t('capability')}</summary><p>{t('capabilityNote')}</p>{state.data.exceptions.access.capabilities.length ? <ul>{state.data.exceptions.access.capabilities.map(value => <li key={value}><code>{value}</code></li>)}</ul> : <p>{t('noCapabilities')}</p>}</details>
          {!!failures.length && <div className={styles.notice}><h3>{t('blocked')}</h3><ul>{failures.map(code => <li key={code}>{label(code)}</li>)}</ul></div>}
        </section>
        {!state.pending && (chosen ? <section className={styles.panel} aria-labelledby="exception-revoke"><h2 id="exception-revoke">{t('revokeTitle')}</h2>{exception(chosen, true)}<p>{t('conversion')}</p>
          <form onSubmit={e => { e.preventDefault(); void controller.revoke(); }}><label>{t('reason')}<textarea required minLength={10} maxLength={500} disabled={state.busy} value={state.revokeReason} onChange={e => controller.editRevokeReason(e.target.value)} /></label>
            {ack('revokeConfirm')}<button type="submit" disabled={state.busy || !state.confirmed}>{t('revokeButton')}</button><button type="button" disabled={state.busy} onClick={() => controller.cancelRevoke()}>{t('cancelRevoke')}</button>
          </form>
        </section> : <section className={styles.panel} aria-labelledby="exception-grant"><h2 id="exception-grant">{t('grant')}</h2><p>{t('datesNote')}</p>
          <form onSubmit={e => { e.preventDefault(); void controller.grant(); }}><fieldset disabled={state.busy || failures.length > 0} className={styles.fields}>
            <label>{t('purpose')}<select value={state.draft.purpose} onChange={e => controller.editDraft('purpose', e.target.value)}>{SAAS_ACCESS_EXCEPTION_PURPOSES.map(purpose => <option value={purpose} key={purpose}>{label(purpose)}</option>)}</select></label>
            <label>{t('profile')}<select value={state.draft.scopeTier} onChange={e => controller.editDraft('scopeTier', e.target.value)}><option value="CORE">{t('standard')}</option><option value="COMPLETE">{t('complete')}</option></select></label>
            <label>{t('start')}<input required type="datetime-local" step="60" value={state.draft.startsAt} onChange={e => controller.editDraft('startsAt', e.target.value)} /></label>
            <label>{t('expiry')}<input required type="datetime-local" step="60" value={state.draft.expiresAt} onChange={e => controller.editDraft('expiresAt', e.target.value)} /></label>
            <label className={styles.wide}>{t('reason')}<textarea required minLength={10} maxLength={500} value={state.draft.reason} onChange={e => controller.editDraft('reason', e.target.value)} /></label>
          </fieldset><p>{t('capabilityNote')}</p>{ack('grantConfirm')}<button type="submit" disabled={state.busy || failures.length > 0 || !state.confirmed}>{t('grantButton')}</button></form>
        </section>)}
        <section className={styles.panel} aria-labelledby="exception-history"><h2 id="exception-history">{t('history')}</h2><p>{t('historyNote')}</p>{selected.length ? selected.map(x => exception(x)) : <p>{t('noHistory')}</p>}</section>
      </>}
    </div>
  </div>;
}
