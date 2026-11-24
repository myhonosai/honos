'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useLocale } from '../localization/provider';
import { useSchoolShell } from '../school-shell/context';
import { concealShellPrivateNow, onShellPrivacyEvent } from '../school-shell/privacy';
import { HON_SCHOOL_CONTEXT_CHANGED_EVENT, HON_SESSION_INVALIDATED_EVENT } from '../session-invalidation';
import { SupportError, keepForRetry, pageHintFrom, supportApi, type SupportApi, type SupportScope } from './http';
import { EMPTY_DRAFT, SupportView, type ListState, type SupportAction, type SupportDraft, type SupportOutcome } from './view';

/** A command whose outcome is not known: the exact request and key, in memory only, so Try again replays it. */
type Pending = Readonly<{ key: string; action: SupportAction; scope: SupportScope; requestId: string | null; body: unknown }>;
type Lock = 'NONE' | 'SENDING' | 'KEPT';

/**
 * Ask HON for help (0335). Blur, a hidden tab, page hide, a school change or a session end hide the page at once, retire
 * every read and drop the drafts and any kept command. Every command answer is followed by a fresh read.
 */
export function SchoolSupport({ api = supportApi }: { api?: SupportApi }): React.ReactElement {
  const locale = useLocale();
  const shell = useSchoolShell();
  const selection = shell.phase === 'READY' ? shell.selection : null;
  const orgId = selection?.organizationId ?? null, schoolId = selection?.schoolId ?? null;
  const [list, setList] = useState<ListState>({ state: 'LOADING' });
  const [draft, setDraft] = useState<SupportDraft>(EMPTY_DRAFT);
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [replyText, setReplyText] = useState('');
  const [outcome, setOutcome] = useState<SupportOutcome>(null);
  const [lock, setLock] = useState<Lock>('NONE');
  const [refresh, setRefresh] = useState(0);
  const [pageHint, setPageHint] = useState<string | null>(null);
  const gen = useRef(0), privacy = useRef(0), mounted = useRef(false), sending = useRef(false), pending = useRef<Pending | null>(null);
  useEffect(() => { mounted.current = true; setPageHint(pageHintFrom(window.location.hash)); return () => { mounted.current = false; privacy.current++; gen.current++; pending.current = null; }; }, []);

  useEffect(() => onShellPrivacyEvent(() => {
    concealShellPrivateNow(); gen.current++; privacy.current++; pending.current = null;
    setLock(sending.current ? 'SENDING' : 'NONE'); setOutcome(null); setDraft(EMPTY_DRAFT); setReplyTo(null); setReplyText(''); setList({ state: 'LOADING' });
  }, [HON_SESSION_INVALIDATED_EVENT, HON_SCHOOL_CONTEXT_CHANGED_EVENT]), []);

  useEffect(() => {
    const current = ++gen.current, shown = privacy.current;
    setList({ state: 'LOADING' });
    if (!orgId || !schoolId) return;
    const owned = () => mounted.current && current === gen.current && shown === privacy.current;
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    api.list({ organizationId: orgId, schoolId }, signal, owned).then(
      (read) => { if (owned()) setList({ state: 'READY', list: read }); },
      (error) => { if (owned() && !abort.signal.aborted) setList({ state: error instanceof SupportError && error.kind === 'DENIED' ? 'DENIED' : 'UNAVAILABLE' }); });
    return () => { abort.abort(); };
  }, [api, orgId, schoolId, refresh]);

  const send = useCallback(async () => {
    const request = pending.current;
    if (!request || sending.current) return;
    sending.current = true; const shown = privacy.current;
    setLock('SENDING'); setOutcome({ kind: 'SENDING', action: request.action });
    let next: SupportOutcome, keep = false;
    try {
      const owned = () => mounted.current && shown === privacy.current && pending.current?.key === request.key;
      const signal = AbortSignal.timeout(30000);
      if (request.action === 'submit') await api.submit(request.scope, request.body as never, request.key, signal, owned);
      else await api.message(request.scope, request.requestId ?? '', request.body as never, request.key, signal, owned);
      next = { kind: 'DONE', action: request.action };
    } catch (error) {
      keep = keepForRetry(error);
      next = { kind: error instanceof SupportError && error.kind !== 'SESSION' ? error.kind : 'UNKNOWN', action: request.action };
    } finally { sending.current = false; }
    if (pending.current?.key === request.key) pending.current = keep ? request : null;
    setLock(pending.current ? 'KEPT' : 'NONE');
    if (shown !== privacy.current || !mounted.current) return;
    setOutcome(next);
    if (next.kind === 'DONE') { if (request.action === 'submit') setDraft(EMPTY_DRAFT); else { setReplyTo(null); setReplyText(''); } }
    else if (next.kind === 'CLOSED' || next.kind === 'GONE') { setReplyTo(null); setReplyText(''); }
    setRefresh((n) => n + 1);
  }, [api]);

  const start = useCallback((action: SupportAction, requestId: string | null, body: unknown) => {
    if (lock !== 'NONE' || pending.current || sending.current || !orgId || !schoolId) return;
    pending.current = { key: globalThis.crypto.randomUUID(), action, scope: { organizationId: orgId, schoolId }, requestId, body };
    void send();
  }, [lock, orgId, schoolId, send]);

  const onSubmit = useCallback(() => {
    if (!draft.topic) return;
    start('submit', null, { topic: draft.topic, subject: draft.subject, message: draft.message, pageHint });
  }, [draft, pageHint, start]);
  const onReply = useCallback(() => { if (replyTo) start('message', replyTo, { message: replyText }); }, [replyTo, replyText, start]);
  const onDraft = useCallback((next: SupportDraft) => { if (lock === 'NONE') { setDraft(next); setOutcome(null); } }, [lock]);
  const onReplyTo = useCallback((id: string | null) => { if (lock === 'NONE') { setReplyTo(id); setReplyText(''); setOutcome(null); } }, [lock]);
  const onReplyText = useCallback((text: string) => { if (lock === 'NONE') setReplyText(text); }, [lock]);

  // Keyed by the shell phase: a concealed node is replaced, never un-hidden in place.
  return <div key={shell.phase} data-shell-private="">
    <SupportView language={locale.preferences.language} locale={locale.formattingLocale} waiting={shell.phase === 'IDLE' || shell.phase === 'LOADING'}
      concealed={shell.phase === 'CONCEALED'} hasSchool={!!schoolId} pageHint={pageHint} list={list} draft={draft} replyTo={replyTo} replyText={replyText}
      outcome={outcome} locked={lock !== 'NONE'} canRetry={lock === 'KEPT'}
      onRefresh={() => setRefresh((n) => n + 1)} onDraft={onDraft} onSubmit={onSubmit} onReplyTo={onReplyTo} onReplyText={onReplyText} onReply={onReply}
      onTryAgain={() => { void send(); }} />
  </div>;
}
