import React from 'react';
import { SOCIAL_PLATFORMS, type SocialAccount, type SocialAccountList, type SocialConnectResult, type SocialPlatform, type SocialProviderRemoval } from '@hon/contracts';
import { socialText, type SocialKey } from './copy';
import type { SocialErrorKind } from './http';
import styles from './social.module.css';

type T = (key: SocialKey, vars?: Record<string, string>) => string;
export type ListState = { state: 'LOADING' | 'DENIED' | 'UNAVAILABLE' } | { state: 'READY'; list: SocialAccountList };
export type Switches = Readonly<{ publishEnabled: boolean; inboxEnabled: boolean; adsEnabled: boolean }>;
export type SocialAction = 'connect' | 'change' | 'disconnect';
export type SocialOutcome = null | Readonly<{ kind: 'SENDING' | 'DONE' | SocialErrorKind; action: SocialAction; removal?: SocialProviderRemoval }>;

export type SocialViewProps = Readonly<{
  language: string; locale: string; waiting: boolean; concealed: boolean; hasSchool: boolean; canManage: boolean;
  list: ListState; edits: Readonly<Record<string, Switches>>; confirming: string | null; outcome: SocialOutcome; locked: boolean; canRetry: boolean;
  onRefresh?: (() => void) | undefined; onConnect?: ((platform: SocialPlatform) => void) | undefined;
  onEdit?: ((accountId: string, next: Switches) => void) | undefined; onSave?: ((account: SocialAccount) => void) | undefined;
  onConfirm?: ((accountId: string | null) => void) | undefined; onDisconnect?: ((account: SocialAccount) => void) | undefined;
  onTryAgain?: (() => void) | undefined;
}>;

const when = (locale: string, iso: string) => { try { return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso)); } catch { return iso; } };
const current = (a: SocialAccount): Switches => ({ publishEnabled: a.publishEnabled, inboxEnabled: a.inboxEnabled, adsEnabled: a.adsEnabled });
const same = (x: Switches, y: Switches) => x.publishEnabled === y.publishEnabled && x.inboxEnabled === y.inboxEnabled && x.adsEnabled === y.adsEnabled;
const SWITCHES = [['publishEnabled', 'sw_publish'], ['inboxEnabled', 'sw_inbox'], ['adsEnabled', 'sw_ads']] as const;

function AccountCard({ a, t, p }: { a: SocialAccount; t: T; p: SocialViewProps }): React.ReactElement {
  const live = a.status === 'CONNECTED', draft = p.edits[a.accountId] ?? current(a), changed = !same(draft, current(a));
  return <li className={styles.step} data-account={a.accountId} data-status={a.status} data-platform={a.platform}>
    <div className={styles.stepMain}>
      <strong>{a.displayName}</strong>
      <div className={styles.chips}><span className={styles.chip}>{t(`p_${a.platform}`)}</span><span className={styles.chip} data-state={a.status}>{t(`st_${a.status}`)}</span></div>
      <span className={styles.meta}>{live ? t('since', { time: when(p.locale, a.connectedAt) }) : t('ended', { time: when(p.locale, a.disconnectedAt ?? a.updatedAt) })}</span>
      {live && <fieldset className={styles.fieldset} disabled={p.locked || !p.canManage}>
        <div className={styles.grid}>{SWITCHES.map(([field, label]) => <label key={field} className={styles.check}>
          <input type="checkbox" checked={draft[field]} onChange={(e) => p.onEdit?.(a.accountId, { ...draft, [field]: e.target.checked })} />{t(label)}</label>)}</div>
      </fieldset>}
    </div>
    {live && p.canManage && <div className={styles.row}>
      {p.confirming === a.accountId
        ? <><p className={styles.warnText}>{t('confirmDisconnect')}</p>
          <button type="button" className={styles.primary} disabled={p.locked} onClick={() => p.onDisconnect?.(a)}>{t('yesDisconnect')}</button>
          <button type="button" className={styles.secondary} disabled={p.locked} onClick={() => p.onConfirm?.(null)}>{t('cancel')}</button></>
        : <><button type="button" className={styles.primary} disabled={p.locked || !changed} onClick={() => p.onSave?.(a)}>{p.locked && changed ? t('saving') : t('save')}</button>
          <button type="button" className={styles.secondary} disabled={p.locked} onClick={() => p.onConfirm?.(a.accountId)}>{t('disconnect')}</button></>}
    </div>}
  </li>;
}

/** Pure view: what is shown is either the server's verified list or this person's unsaved switch edits. */
export function SocialView(p: SocialViewProps): React.ReactElement {
  const t: T = (key, vars) => socialText(p.language, key, vars);
  const head = <div className={styles.head}><div><h1>{t('title')}</h1><p className={styles.intro}>{t('intro')}</p></div>
    {p.list.state === 'READY' && <button type="button" className={styles.secondary} disabled={p.locked} onClick={p.onRefresh}>{t('refresh')}</button>}</div>;
  if (p.waiting) return <section className={styles.page}>{head}<p className={styles.meta} role="status">{t('waiting')}</p></section>;
  if (p.concealed) return <section className={styles.page}>{head}<p className={styles.notice}>{t('concealed')}</p></section>;
  if (!p.hasSchool) return <section className={styles.page}>{head}<p className={styles.notice}>{t('noSchool')}</p></section>;
  if (p.list.state !== 'READY') return <section className={styles.page}>{head}
    {p.list.state === 'LOADING' ? <p className={styles.meta} role="status">{t('loading')}</p>
      : <div className={styles.notice} role="alert"><p>{t(p.list.state === 'DENIED' ? 'denied' : 'unavailable')}</p>
        {p.list.state === 'UNAVAILABLE' && <button type="button" className={styles.secondary} onClick={p.onRefresh}>{t('refresh')}</button>}</div>}
  </section>;
  const o = p.outcome, l = p.list.list;
  const removal = o?.kind === 'DONE' && o.removal ? t(`removal_${o.removal}`) : '';
  return <section className={styles.page}>
    {head}
    {o && o.kind !== 'SENDING' && <div className={`${styles.notice} ${o.kind === 'DONE' && o.removal !== 'NOT_REMOVED' ? '' : styles.warn}`} role={o.kind === 'DONE' ? 'status' : 'alert'} data-social-outcome={o.kind}>
      <p>{o.kind === 'DONE' ? t(o.action === 'disconnect' ? 'done_disconnect' : 'done_change') : t(`e_${o.kind}`)}{removal ? ' ' + removal : ''}</p>
      {p.canRetry && <button type="button" className={styles.primary} onClick={p.onTryAgain}>{t('tryAgain')}</button>}</div>}
    {p.canManage && <div className={styles.card} data-social-connect>
      <h2>{t('connectTitle')}</h2>
      {l.connectEnabled ? <><p className={styles.meta}>{t('connectHelp')}</p>
        <div className={styles.row}>{SOCIAL_PLATFORMS.map((platform) => <button key={platform} type="button" className={styles.primary} disabled={p.locked}
          onClick={() => p.onConnect?.(platform)}>{p.locked && o?.action === 'connect' ? t('connecting') : t(`connect_${platform}`)}</button>)}</div></>
        : <p className={styles.notice} data-social-not-enabled>{t('notEnabled')}</p>}
    </div>}
    <div className={styles.card} data-social-list>
      <h2>{t('listTitle')}</h2><p className={styles.meta}>{t('switchHelp')}</p>
      {l.accounts.length === 0 ? <p className={styles.meta}>{t('none')}</p>
        : <ol className={styles.steps}>{l.accounts.map((a) => <AccountCard key={a.accountId} a={a} t={t} p={p} />)}</ol>}
    </div>
  </section>;
}

export type ReturnState = { state: 'WORKING' | 'MISSING' } | { state: 'FAILED'; kind: SocialErrorKind } | { state: 'DONE'; result: SocialConnectResult };

export function SocialReturnView({ language, state, waiting }: { language: string; state: ReturnState; waiting: boolean }): React.ReactElement {
  const t: T = (key, vars) => socialText(language, key, vars);
  const back = <a className={styles.secondary} href="/staff/marketing/social">{t('back')}</a>;
  let body: React.ReactNode;
  if (waiting || state.state === 'WORKING') body = <p className={styles.meta} role="status">{t('returnWorking')}</p>;
  else if (state.state === 'MISSING') body = <p className={styles.notice} role="alert">{t('returnMissing')}</p>;
  else if (state.state === 'FAILED') body = <p className={`${styles.notice} ${styles.warn}`} role="alert" data-social-outcome={state.kind}>{t(`e_${state.kind}`)}</p>;
  else if (state.state === 'DONE') body = <div className={styles.notice} role="status" data-social-outcome="DONE">
    <p>{state.result.connected > 0 ? t('returnDone', { count: String(state.result.connected) }) : t('returnNone')}</p>
    {state.result.conflicts > 0 && <p className={styles.warnText}>{t('returnConflict', { count: String(state.result.conflicts) })}</p>}</div>;
  return <section className={styles.page}><div className={styles.head}><div><h1>{t('returnTitle')}</h1></div></div>{body}<div className={styles.row}>{back}</div></section>;
}
