'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useLocale } from '../localization/provider';
import { useSchoolShell } from '../school-shell/context';
import { concealShellPrivateNow, onShellPrivacyEvent } from '../school-shell/privacy';
import { HON_SCHOOL_CONTEXT_CHANGED_EVENT, HON_SESSION_INVALIDATED_EVENT } from '../session-invalidation';
import { MayaError, mayaApi, type MayaApi } from './http';
import { MayaAtRiskView, type MayaListState } from './view';
import { MayaAsk } from './maya-ask';
import type { HonConversationApi } from '../hon-command/hon-conversation-http';

/**
 * Maya, students at risk (M1, 0259). Reads the verified school's at-risk list; blur, a hidden tab, a school change or a
 * session end hide it at once and retire every read. Nothing here sends a message or changes a record.
 */
export function MayaAtRisk({ api = mayaApi, honApi }: { api?: MayaApi; honApi?: HonConversationApi }): React.ReactElement {
  const { preferences } = useLocale();
  const shell = useSchoolShell();
  const selection = shell.phase === 'READY' ? shell.selection : null;
  const orgId = selection?.organizationId ?? null, schoolId = selection?.schoolId ?? null;
  const [list, setList] = useState<MayaListState>({ state: 'LOADING' });
  const [refresh, setRefresh] = useState(0);
  const gen = useRef(0), privacy = useRef(0), mounted = useRef(false), moreAbort = useRef<AbortController | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; privacy.current++; gen.current++; moreAbort.current?.abort(); }; }, []);

  useEffect(() => onShellPrivacyEvent(() => {
    concealShellPrivateNow(); gen.current++; privacy.current++; moreAbort.current?.abort(); moreAbort.current = null;
    setList({ state: 'LOADING' });
  }, [HON_SESSION_INVALIDATED_EVENT, HON_SCHOOL_CONTEXT_CHANGED_EVENT]), []);

  useEffect(() => {
    moreAbort.current?.abort(); moreAbort.current = null;
    const current = ++gen.current, shown = privacy.current;
    setList({ state: 'LOADING' });
    if (!orgId || !schoolId) return;
    const owned = () => mounted.current && current === gen.current && shown === privacy.current;
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    api.atRisk({ organizationId: orgId, schoolId }, null, signal, owned).then(
      (read) => { if (owned()) setList({ state: 'READY', read, items: read.items, nextAfter: read.nextAfter, more: 'IDLE' }); },
      (error) => { if (owned() && !abort.signal.aborted) setList({ state: error instanceof MayaError && error.kind === 'DENIED' ? 'DENIED' : 'UNAVAILABLE' }); });
    return () => { abort.abort(); };
  }, [api, orgId, schoolId, refresh]);

  const onMore = useCallback(() => {
    if (list.state !== 'READY' || !list.nextAfter || list.more === 'LOADING' || !orgId || !schoolId) return;
    const prior = list, current = gen.current, shown = privacy.current;
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    moreAbort.current?.abort(); moreAbort.current = abort;
    const owned = () => mounted.current && current === gen.current && shown === privacy.current && moreAbort.current === abort;
    setList({ ...prior, more: 'LOADING' });
    api.atRisk({ organizationId: orgId, schoolId }, prior.nextAfter, signal, owned).then(
      (read) => {
        if (!owned()) return;
        moreAbort.current = null;
        // Records can change between pages; a repeated student means the order moved, so read the list again.
        const seen = new Set(prior.items.map((i) => i.membershipId));
        if (read.items.some((i) => seen.has(i.membershipId))) { setRefresh((n) => n + 1); return; }
        setList({ state: 'READY', read, items: [...prior.items, ...read.items], nextAfter: read.nextAfter, more: 'IDLE' });
      },
      () => { if (owned() && !abort.signal.aborted) { moreAbort.current = null; setList({ ...prior, more: 'FAILED' }); } });
  }, [api, list, orgId, schoolId]);

  return <MayaAtRiskView language={preferences.language} waiting={shell.phase === 'IDLE' || shell.phase === 'LOADING'} concealed={shell.phase === 'CONCEALED'} hasSchool={Boolean(orgId && schoolId)}
    list={list} onRefresh={() => setRefresh((n) => n + 1)} onMore={onMore}
    renderAsk={orgId && schoolId ? (s) => <MayaAsk key={`${refresh}:${s.membershipId}`} school={{ organizationId: orgId, schoolId }} membershipId={s.membershipId} givenName={s.givenName}
      {...(honApi ? { api: honApi } : {})} /> : undefined} />;
}
