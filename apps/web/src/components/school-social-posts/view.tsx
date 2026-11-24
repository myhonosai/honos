import React from 'react';
import { SOCIAL_POST_ACCOUNTS_MAX, SOCIAL_POST_TEXT_MAX, type SocialAccount, type SocialPost, type SocialPostList, type SocialPostTarget } from '@hon/contracts';
import styles from '../school-social/social.module.css';
import { postsText, type PostsKey } from './copy';
import type { PostsErrorKind } from './http';

type T = (key: PostsKey, vars?: Record<string, string>) => string;
export type PostsReadState = { state: 'LOADING' | 'DENIED' | 'UNAVAILABLE' } | { state: 'READY'; accounts: readonly SocialAccount[]; posts: SocialPostList };
export type PostForm = Readonly<{ editing: SocialPost | null; text: string; link: string; accountIds: readonly string[] }>;
export type ApproveForm = Readonly<{ postId: string; mode: 'NOW' | 'LATER'; at: string }>;
export type PostsAction = 'create' | 'edit' | 'approve' | 'cancel' | 'resolve';
export type PostsOutcome = null | Readonly<{ kind: 'SENDING' | 'DONE' | 'BAD_TIME' | PostsErrorKind; action: PostsAction }>;
export const EMPTY_FORM: PostForm = { editing: null, text: '', link: '', accountIds: [] };
export const GOOGLE_TEXT_MAX = 1500;

/** Accounts a post can go to: a connected Facebook Page or Google Business Profile with its Posting switch on. */
export const canTakePosts = (a: SocialAccount) => a.status === 'CONNECTED' && a.publishEnabled && (a.platform === 'FACEBOOK' || a.platform === 'GOOGLE_BUSINESS');
/** Accounts shown in the chooser: every connected account that posts at all (Google Ads accounts only run ads). */
const shown = (a: SocialAccount) => a.status === 'CONNECTED' && a.platform !== 'GOOGLE_ADS';
/** Text limit for the chosen accounts: 1,500 once a Google Business Profile is chosen. */
export function textLimit(accounts: readonly SocialAccount[], ids: readonly string[]): number {
  return accounts.some(a => ids.includes(a.accountId) && a.platform === 'GOOGLE_BUSINESS') ? GOOGLE_TEXT_MAX : SOCIAL_POST_TEXT_MAX;
}
/** An approved post can still be cancelled only while every target is waiting. */
export const cancellable = (p: SocialPost) => p.status === 'DRAFT' || (p.status === 'APPROVED' && p.targets.every(t => t.status === 'PENDING'));

export type PostsViewProps = Readonly<{
  language: string; locale: string; waiting: boolean; concealed: boolean; hasSchool: boolean;
  read: PostsReadState; form: PostForm; approving: ApproveForm | null; confirming: string | null; outcome: PostsOutcome; locked: boolean; canRetry: boolean;
  onRefresh?: (() => void) | undefined; onForm?: ((next: PostForm) => void) | undefined; onSave?: (() => void) | undefined;
  onEdit?: ((post: SocialPost | null) => void) | undefined; onApproving?: ((next: ApproveForm | null) => void) | undefined;
  onApprove?: ((post: SocialPost) => void) | undefined; onConfirm?: ((postId: string | null) => void) | undefined;
  onCancel?: ((post: SocialPost) => void) | undefined; onResolve?: ((post: SocialPost, target: SocialPostTarget, outcome: 'PUBLISHED' | 'NOT_PUBLISHED') => void) | undefined;
  onTryAgain?: (() => void) | undefined;
}>;

const when = (locale: string, iso: string) => { try { return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso)); } catch { return iso; } };

function Composer({ p, t, accounts }: { p: PostsViewProps; t: T; accounts: readonly SocialAccount[] }): React.ReactElement {
  const f = p.form, max = textLimit(accounts, f.accountIds), list = accounts.filter(shown);
  const toggle = (id: string, on: boolean) => p.onForm?.({ ...f, accountIds: on ? [...f.accountIds, id] : f.accountIds.filter(x => x !== id) });
  const ready = f.text.trim().length > 0 && f.text.length <= max && f.accountIds.length >= 1 && f.accountIds.length <= SOCIAL_POST_ACCOUNTS_MAX;
  return <div className={styles.card} data-posts-composer={f.editing ? 'edit' : 'new'}>
    <h2>{t(f.editing ? 'editTitle' : 'writeTitle')}</h2>
    <label className={styles.field}><span>{t('text')}</span>
      <textarea value={f.text} rows={6} maxLength={SOCIAL_POST_TEXT_MAX} disabled={p.locked} onChange={(e) => p.onForm?.({ ...f, text: e.target.value })} />
      <span className={`${styles.meta} ${f.text.length > max ? styles.warnText : ''}`} data-posts-count>{t('textHelp', { count: String(f.text.length), max: String(max) })}</span></label>
    <label className={styles.field}><span>{t('link')}</span>
      <input type="url" inputMode="url" value={f.link} maxLength={2000} placeholder="https://" disabled={p.locked} onChange={(e) => p.onForm?.({ ...f, link: e.target.value })} /></label>
    <fieldset className={styles.fieldset}><legend>{t('accounts')}</legend><p className={styles.meta}>{t('accountsHelp')}</p>
      {list.map((a) => {
        const usable = canTakePosts(a), checked = f.accountIds.includes(a.accountId);
        const full = !checked && f.accountIds.length >= SOCIAL_POST_ACCOUNTS_MAX;
        return <label key={a.accountId} className={styles.check} data-posts-account={a.accountId} data-usable={usable ? 'yes' : 'no'}>
          <input type="checkbox" checked={checked} disabled={p.locked || !usable || full} onChange={(e) => toggle(a.accountId, e.target.checked)} />
          {a.displayName}{' '}<span className={styles.meta}>({a.platform === 'FACEBOOK' ? 'Facebook' : a.platform === 'INSTAGRAM' ? 'Instagram' : 'Google Business Profile'})</span>
          {a.platform === 'INSTAGRAM' ? <span className={styles.meta}> {t('instagramNote')}</span> : !a.publishEnabled ? <span className={styles.meta}> {t('publishingOffFor')}</span> : null}
        </label>;
      })}
      {max === GOOGLE_TEXT_MAX && <p className={styles.meta}>{t('googleNote')}</p>}
    </fieldset>
    <div className={styles.row}>
      <button type="button" className={styles.primary} disabled={p.locked || !ready} onClick={p.onSave}>{p.locked && p.outcome?.kind === 'SENDING' && (p.outcome.action === 'create' || p.outcome.action === 'edit') ? t('saving') : t(f.editing ? 'saveEdit' : 'saveDraft')}</button>
      {f.editing && <button type="button" className={styles.secondary} disabled={p.locked} onClick={() => p.onEdit?.(null)}>{t('stopEdit')}</button>}
    </div>
  </div>;
}

function TargetLine({ post, target, t, p }: { post: SocialPost; target: SocialPostTarget; t: T; p: PostsViewProps }): React.ReactElement {
  return <li data-posts-target={target.targetId} data-status={target.status}>
    <strong>{target.displayName}</strong>: {t(`t_${target.status}`)}
    {target.failureCode && <span className={styles.meta}> {t(`f_${target.failureCode}`)}</span>}
    {target.skipReason && <span className={styles.meta}> {t(`s_${target.skipReason}`)}</span>}
    {target.resolvedByPerson && <span className={styles.meta}> {t('resolved')}</span>}
    {target.status === 'UNKNOWN' && <div className={styles.row}><p className={styles.warnText}>{t('unknownHelp')}</p>
      <button type="button" className={styles.secondary} disabled={p.locked} onClick={() => p.onResolve?.(post, target, 'PUBLISHED')}>{t('wasPosted')}</button>
      <button type="button" className={styles.secondary} disabled={p.locked} onClick={() => p.onResolve?.(post, target, 'NOT_PUBLISHED')}>{t('notPosted')}</button></div>}
  </li>;
}

function PostCard({ post, t, p }: { post: SocialPost; t: T; p: PostsViewProps }): React.ReactElement {
  const a = p.approving?.postId === post.postId ? p.approving : null;
  return <li className={styles.step} data-post={post.postId} data-status={post.status}>
    <div className={styles.stepMain}>
      <p><span className={styles.chip}>{t(`st_${post.status}`)}</span>{' '}
        <span className={styles.meta}>{post.publishAt ? t('goesOut', { time: when(p.locale, post.publishAt) }) : t('created', { time: when(p.locale, post.createdAt) })}</span></p>
      <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{post.text}</p>
      {post.linkUrl && <p className={styles.meta} style={{ overflowWrap: 'anywhere' }}>{post.linkUrl}</p>}
      {post.targets.length > 0 && <ul className={styles.list}>{post.targets.map((target) => <TargetLine key={target.targetId} post={post} target={target} t={t} p={p} />)}</ul>}
    </div>
    {post.status === 'DRAFT' && !a && p.confirming !== post.postId && <div className={styles.row}>
      <button type="button" className={styles.secondary} disabled={p.locked} onClick={() => p.onEdit?.(post)}>{t('edit')}</button>
      <button type="button" className={styles.primary} disabled={p.locked} onClick={() => p.onApproving?.({ postId: post.postId, mode: 'NOW', at: '' })}>{t('approveTitle')}</button>
    </div>}
    {a && <div className={styles.form} data-posts-approve={post.postId}>
      <div className={styles.row} role="radiogroup">
        {(['NOW', 'LATER'] as const).map((mode) => <label key={mode} className={styles.check}>
          <input type="radio" name={`when-${post.postId}`} checked={a.mode === mode} disabled={p.locked} onChange={() => p.onApproving?.({ ...a, mode })} />{t(mode === 'NOW' ? 'approveNow' : 'approveLater')}</label>)}
      </div>
      {a.mode === 'LATER' && <label className={styles.field}><span>{t('approveAt')}</span>
        <input type="datetime-local" value={a.at} disabled={p.locked} onChange={(e) => p.onApproving?.({ ...a, at: e.target.value })} /></label>}
      <div className={styles.row}>
        <button type="button" className={styles.primary} disabled={p.locked || (a.mode === 'LATER' && !a.at)} onClick={() => p.onApprove?.(post)}>{p.locked && p.outcome?.action === 'approve' && p.outcome.kind === 'SENDING' ? t('approving') : t('approve')}</button>
        <button type="button" className={styles.secondary} disabled={p.locked} onClick={() => p.onApproving?.(null)}>{t('keep')}</button>
      </div>
    </div>}
    {cancellable(post) && !a && <div className={styles.row}>
      {p.confirming === post.postId
        ? <><p className={styles.warnText}>{t('confirmCancel')}</p>
          <button type="button" className={styles.primary} disabled={p.locked} onClick={() => p.onCancel?.(post)}>{t('yesCancel')}</button>
          <button type="button" className={styles.secondary} disabled={p.locked} onClick={() => p.onConfirm?.(null)}>{t('keep')}</button></>
        : <button type="button" className={styles.secondary} disabled={p.locked} onClick={() => p.onConfirm?.(post.postId)}>{t('cancelPost')}</button>}
    </div>}
  </li>;
}

/** Pure view: what is shown is the server's verified accounts and posts, or this person's unsaved form. */
export function PostsView(p: PostsViewProps): React.ReactElement {
  const t: T = (key, vars) => postsText(p.language, key, vars);
  const head = <div className={styles.head}><div><h1>{t('title')}</h1><p className={styles.intro}>{t('intro')}</p></div>
    {p.read.state === 'READY' && <button type="button" className={styles.secondary} disabled={p.locked} onClick={p.onRefresh}>{t('refresh')}</button>}</div>;
  if (p.waiting) return <section className={styles.page}>{head}<p className={styles.meta} role="status">{t('waiting')}</p></section>;
  if (p.concealed) return <section className={styles.page}>{head}<p className={styles.notice}>{t('concealed')}</p></section>;
  if (!p.hasSchool) return <section className={styles.page}>{head}<p className={styles.notice}>{t('noSchool')}</p></section>;
  if (p.read.state !== 'READY') return <section className={styles.page}>{head}
    {p.read.state === 'LOADING' ? <p className={styles.meta} role="status">{t('loading')}</p>
      : <div className={styles.notice} role="alert"><p>{t(p.read.state === 'DENIED' ? 'denied' : 'unavailable')}</p>
        {p.read.state === 'UNAVAILABLE' && <button type="button" className={styles.secondary} onClick={p.onRefresh}>{t('refresh')}</button>}</div>}
  </section>;
  const o = p.outcome, { accounts, posts } = p.read;
  const usable = accounts.some(canTakePosts);
  return <section className={styles.page}>
    {head}
    {!posts.publishEnabled && <p className={`${styles.notice} ${styles.warn}`} data-posts-publish-off>{t('publishOff')}</p>}
    {o && o.kind !== 'SENDING' && <div className={`${styles.notice} ${o.kind === 'DONE' ? '' : styles.warn}`} role={o.kind === 'DONE' ? 'status' : 'alert'} data-posts-outcome={o.kind}>
      <p>{o.kind === 'DONE' ? t(`done_${o.action}`) : o.kind === 'BAD_TIME' ? t('badTime') : t(`e_${o.kind}`)}</p>
      {p.canRetry && <button type="button" className={styles.primary} onClick={p.onTryAgain}>{t('tryAgain')}</button>}</div>}
    {usable || p.form.editing ? <Composer p={p} t={t} accounts={accounts} />
      : <div className={styles.notice} data-posts-no-accounts><p>{t('noAccounts')}</p><a className={styles.secondary} href="/staff/marketing/social">{t('toAccounts')}</a></div>}
    <div className={styles.card} data-posts-list>
      <h2>{t('listTitle')}</h2><p className={styles.meta}>{t('listHelp')}</p>
      {posts.posts.length === 0 ? <p className={styles.meta}>{t('none')}</p>
        : <ol className={styles.steps}>{[...posts.posts].reverse().map((post) => <PostCard key={post.postId} post={post} t={t} p={p} />)}</ol>}
    </div>
  </section>;
}
