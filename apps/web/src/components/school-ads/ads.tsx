'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useLocale } from '../localization/provider';
import { useSchoolShell } from '../school-shell/context';
import { concealShellPrivateNow, onShellPrivacyEvent } from '../school-shell/privacy';
import { HON_SCHOOL_CONTEXT_CHANGED_EVENT, HON_SESSION_INVALIDATED_EVENT } from '../session-invalidation';
import { SocialError, socialApi, type SocialApi } from '../school-social/http';
import { AdsView, type AdsListState, type AdsOutcome } from './view';

/**
 * Marketing > Ads. Reads the school's real social connections (0347) and starts the existing Facebook connect hand-off;
 * the social API decides every permission and whether connecting is on. Blur, a school change or a session end hide the
 * page at once and retire every read.
 */
export function SchoolAds({ api = socialApi, navigate = (url: string) => window.location.assign(url) }: { api?: SocialApi; navigate?: (url: string) => void }): React.ReactElement {
  const locale = useLocale();
  const shell = useSchoolShell();
  const selection = shell.phase === 'READY' ? shell.selection : null;
  const orgId = selection?.organizationId ?? null, schoolId = selection?.schoolId ?? null;
  const [list, setList] = useState<AdsListState>({ state: 'LOADING' });
  const [connecting, setConnecting] = useState(false);
  const [outcome, setOutcome] = useState<AdsOutcome>(null);
  const [refresh, setRefresh] = useState(0);
  const gen = useRef(0), privacy = useRef(0), mounted = useRef(false), sending = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; privacy.current++; gen.current++; }; }, []);

  useEffect(() => onShellPrivacyEvent(() => {
    concealShellPrivateNow(); gen.current++; privacy.current++;
    setOutcome(null); setList({ state: 'LOADING' });
  }, [HON_SESSION_INVALIDATED_EVENT, HON_SCHOOL_CONTEXT_CHANGED_EVENT]), []);

  useEffect(() => {
    const current = ++gen.current, shown = privacy.current;
    setList({ state: 'LOADING' });
    if (!orgId || !schoolId) return;
    const owned = () => mounted.current && current === gen.current && shown === privacy.current;
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    api.list({ organizationId: orgId, schoolId }, signal, owned).then(
      (read) => { if (owned()) setList({ state: 'READY', list: read }); },
      (error) => { if (owned() && !abort.signal.aborted) setList({ state: error instanceof SocialError && error.kind === 'DENIED' ? 'DENIED' : 'UNAVAILABLE' }); });
    return () => { abort.abort(); };
  }, [api, orgId, schoolId, refresh]);

  const onConnectMeta = useCallback(async () => {
    if (sending.current || !orgId || !schoolId) return;
    sending.current = true; const shown = privacy.current;
    setConnecting(true); setOutcome(null);
    try {
      // A new attempt each time: a lost answer only leaves an unused link that expires by itself.
      const r = await api.connect({ organizationId: orgId, schoolId }, 'FACEBOOK', globalThis.crypto.randomUUID(), AbortSignal.timeout(30000),
        () => mounted.current && shown === privacy.current);
      if (shown === privacy.current && mounted.current) navigate(r.authUrl);
    } catch (error) {
      if (shown === privacy.current && mounted.current) {
        const kind = error instanceof SocialError ? error.kind : 'UNKNOWN';
        setOutcome(kind === 'DENIED' || kind === 'NOT_ENABLED' || kind === 'LIMIT' || kind === 'PROVIDER' || kind === 'INVALID' ? kind : 'UNKNOWN');
        setConnecting(false);
      }
    } finally { sending.current = false; }
  }, [api, navigate, orgId, schoolId]);

  return <div key={shell.phase} data-shell-private="">
    <AdsView language={locale.preferences.language} waiting={shell.phase === 'IDLE' || shell.phase === 'LOADING'} concealed={shell.phase === 'CONCEALED'}
      hasSchool={!!schoolId} list={list} connecting={connecting} outcome={outcome}
      onRefresh={() => setRefresh((n) => n + 1)} onConnectMeta={() => { void onConnectMeta(); }} />
  </div>;
}
