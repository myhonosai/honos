'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { SocialPost, SocialPostTarget } from '@hon/contracts';
import { useLocale } from '../localization/provider';
import { useSchoolShell } from '../school-shell/context';
import { concealShellPrivateNow, onShellPrivacyEvent } from '../school-shell/privacy';
import { HON_SCHOOL_CONTEXT_CHANGED_EVENT, HON_SESSION_INVALIDATED_EVENT } from '../session-invalidation';
import { SocialError, socialApi, type SocialApi } from '../school-social/http';
import { PostsError, keepPostsForRetry, postsApi, publishAtFrom, type PostsApi, type PostsScope } from './http';
import { EMPTY_FORM, PostsView, type ApproveForm, type PostForm, type PostsAction, type PostsOutcome, type PostsReadState } from './view';

/** One write whose outcome is not known yet: the exact request and key, in memory only, so Try again replays it. */
type Pending = Readonly<{ key: string; action: PostsAction; scope: PostsScope; send: (api: PostsApi, key: string, signal: AbortSignal, owned: () => boolean) => Promise<SocialPost> }>;
type Lock = 'NONE' | 'SENDING' | 'KEPT';
const systemNow = () => new Date();

/**
 * Marketing > Facebook & Instagram > Posts (0348). Reads the school's accounts (0347) and its posts; every write is one
 * human command with its own key, and the server decides permission and whether publishing is on. Blur, a school change
 * or a session end hide the page, retire every read and drop the form and any kept request.
 */
export function SchoolSocialPosts({ accounts = socialApi, api = postsApi, now = systemNow }: { accounts?: SocialApi; api?: PostsApi; now?: () => Date }): React.ReactElement {
  const locale = useLocale();
  const shell = useSchoolShell();
  const selection = shell.phase === 'READY' ? shell.selection : null;
  const orgId = selection?.organizationId ?? null, schoolId = selection?.schoolId ?? null;
  const [read, setRead] = useState<PostsReadState>({ state: 'LOADING' });
  const [form, setForm] = useState<PostForm>(EMPTY_FORM);
  const [approving, setApproving] = useState<ApproveForm | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<PostsOutcome>(null);
  const [lock, setLock] = useState<Lock>('NONE');
  const [refresh, setRefresh] = useState(0);
  const gen = useRef(0), privacy = useRef(0), mounted = useRef(false), sending = useRef(false), pending = useRef<Pending | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; privacy.current++; gen.current++; pending.current = null; }; }, []);

  useEffect(() => onShellPrivacyEvent(() => {
    concealShellPrivateNow(); gen.current++; privacy.current++; pending.current = null;
    setLock(sending.current ? 'SENDING' : 'NONE'); setOutcome(null); setForm(EMPTY_FORM); setApproving(null); setConfirming(null); setRead({ state: 'LOADING' });
  }, [HON_SESSION_INVALIDATED_EVENT, HON_SCHOOL_CONTEXT_CHANGED_EVENT]), []);

  useEffect(() => {
    const current = ++gen.current, shown = privacy.current;
    setRead({ state: 'LOADING' });
    if (!orgId || !schoolId) return;
    const scope = { organizationId: orgId, schoolId };
    const owned = () => mounted.current && current === gen.current && shown === privacy.current;
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    Promise.all([accounts.list(scope, signal, owned), api.list(scope, now(), signal, owned)]).then(
      ([list, posts]) => { if (owned()) setRead({ state: 'READY', accounts: list.accounts, posts }); },
      (error) => {
        if (!owned() || abort.signal.aborted) return;
        const denied = (error instanceof SocialError && error.kind === 'DENIED') || (error instanceof PostsError && error.kind === 'DENIED');
        setRead({ state: denied ? 'DENIED' : 'UNAVAILABLE' });
      });
    return () => { abort.abort(); };
  }, [accounts, api, now, orgId, schoolId, refresh]);

  const send = useCallback(async () => {
    const request = pending.current;
    if (!request || sending.current) return;
    sending.current = true; const shown = privacy.current;
    setLock('SENDING'); setOutcome({ kind: 'SENDING', action: request.action });
    let next: PostsOutcome, keep = false;
    try {
      await request.send(api, request.key, AbortSignal.timeout(30000), () => mounted.current && shown === privacy.current && pending.current?.key === request.key);
      next = { kind: 'DONE', action: request.action };
    } catch (error) {
      keep = keepPostsForRetry(error);
      next = { kind: error instanceof PostsError && error.kind !== 'SESSION' ? error.kind : 'UNKNOWN', action: request.action };
    } finally { sending.current = false; }
    if (pending.current?.key === request.key) pending.current = keep ? request : null;
    setLock(pending.current ? 'KEPT' : 'NONE');
    if (shown !== privacy.current || !mounted.current) return;
    setOutcome(next); setConfirming(null);
    if (next.kind === 'DONE' && (request.action === 'create' || request.action === 'edit')) setForm(EMPTY_FORM);
    if (next.kind === 'DONE' && request.action === 'approve') setApproving(null);
    if (next.kind === 'STALE' || next.kind === 'STATE' || next.kind === 'GONE') { setApproving(null); if (request.action === 'edit') setForm(EMPTY_FORM); }
    setRefresh((n) => n + 1);
  }, [api]);

  const start = useCallback((action: PostsAction, run: Pending['send']) => {
    if (lock !== 'NONE' || pending.current || sending.current || !orgId || !schoolId) return;
    pending.current = { key: globalThis.crypto.randomUUID(), action, scope: { organizationId: orgId, schoolId }, send: run };
    void send();
  }, [lock, orgId, schoolId, send]);

  const scope = (): PostsScope | null => orgId && schoolId ? { organizationId: orgId, schoolId } : null;

  const onSave = () => {
    const s = scope(), f = form; if (!s) return;
    const link = f.link.trim();
    const body = { text: f.text, accountIds: [...f.accountIds], ...(link ? { linkUrl: link } : {}) };
    const editing = f.editing;
    if (editing) start('edit', (a, key, signal, owned) => a.edit(s, editing.postId, { ...body, expectedVersion: editing.version }, key, signal, owned));
    else start('create', (a, key, signal, owned) => a.create(s, body, key, signal, owned));
  };
  const onApprove = (post: SocialPost) => {
    const s = scope(), a = approving; if (!s || !a || a.postId !== post.postId) return;
    let publishAt: string | null = null;
    if (a.mode === 'LATER') { publishAt = publishAtFrom(a.at, now()); if (!publishAt) { setOutcome({ kind: 'BAD_TIME', action: 'approve' }); return; } }
    const input = { expectedVersion: post.version, ...(publishAt ? { publishAt } : {}) };
    start('approve', (x, key, signal, owned) => x.approve(s, post.postId, input, key, signal, owned));
  };
  const onCancel = (post: SocialPost) => { const s = scope(); if (s) start('cancel', (a, key, signal, owned) => a.cancel(s, post.postId, post.version, key, signal, owned)); };
  const onResolve = (_post: SocialPost, target: SocialPostTarget, result: 'PUBLISHED' | 'NOT_PUBLISHED') => {
    const s = scope(); if (s) start('resolve', (a, key, signal, owned) => a.resolve(s, target.targetId, { expectedVersion: target.version, outcome: result }, key, signal, owned));
  };
  const idle = lock === 'NONE';

  return <div key={shell.phase} data-shell-private="">
    <PostsView language={locale.preferences.language} locale={locale.formattingLocale} waiting={shell.phase === 'IDLE' || shell.phase === 'LOADING'}
      concealed={shell.phase === 'CONCEALED'} hasSchool={!!schoolId} read={read} form={form} approving={approving} confirming={confirming} outcome={outcome}
      locked={!idle} canRetry={lock === 'KEPT'}
      onRefresh={() => setRefresh((n) => n + 1)}
      onForm={(next) => { if (idle) { setForm(next); setOutcome(null); } }} onSave={onSave}
      onEdit={(post) => { if (idle) { setForm(post ? { editing: post, text: post.text, link: post.linkUrl ?? '', accountIds: post.accountIds } : EMPTY_FORM); setApproving(null); setOutcome(null); } }}
      onApproving={(next) => { if (idle) { setApproving(next); setConfirming(null); setOutcome(null); } }} onApprove={onApprove}
      onConfirm={(id) => { if (idle) { setConfirming(id); setApproving(null); setOutcome(null); } }} onCancel={onCancel} onResolve={onResolve}
      onTryAgain={() => { void send(); }} />
  </div>;
}
