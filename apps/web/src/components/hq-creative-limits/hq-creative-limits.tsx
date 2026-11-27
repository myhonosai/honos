'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { CreativeJobProvider, CreativeProviderLimitStatus } from '@hon/contracts';
import { useLocale } from '../localization/provider';
import { MarketingError } from '../hq-marketing/http';
import { useConcealment, useMarketingCommand } from '../hq-marketing/model';
import { creditsApi } from '../hq-creative-credits/http';
import { limitsApi, type LimitsApi, type LimitsReceipt } from './http';
import { providerInputFrom, schoolInputFrom, type ProviderDraft, type SchoolDraft } from './model';
import { CreativeLimitsView, type LimitsOutcome, type LimitsState } from './view';

/** Only the school names are taken from the wallet list; a failed read leaves ids on screen and changes nothing else. */
export type SchoolNamesApi = Readonly<{ names: (signal: AbortSignal, owned: () => boolean) => Promise<ReadonlyMap<string, string>> }>;
export const schoolNamesApi: SchoolNamesApi = {
  names: async (signal, owned) => new Map((await creditsApi.wallets(signal, owned)).wallets.map(w => [w.schoolId.toLowerCase(), w.schoolName])),
};

/**
 * HQ creative spend limits (C1, 0354). Leaving the tab or a session end hides everything and drops a kept change; "Show
 * again" reads fresh. Every command answer is followed by a fresh read. The database decides who may read or change.
 */
export function HqCreativeLimits({ api = limitsApi, names = schoolNamesApi }: { api?: LimitsApi; names?: SchoolNamesApi }): React.ReactElement {
  const { preferences, formattingLocale } = useLocale();
  const [state, setState] = useState<LimitsState>({ state: 'LOADING' });
  const [schools, setSchools] = useState<ReadonlyMap<string, string>>(new Map());
  const [refresh, setRefresh] = useState(0);
  const [editing, setEditing] = useState<CreativeJobProvider | null>(null);
  const generation = useRef(0), mounted = useRef(false), dropRef = useRef<() => void>(() => {});
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; }; }, []);
  const { concealed, privacy, reveal } = useConcealment(() => { generation.current++; dropRef.current(); setEditing(null); setSchools(new Map()); setState({ state: 'LOADING' }); });
  const after = useCallback((outcome: LimitsOutcome) => {
    if (outcome?.kind !== 'UNKNOWN') setEditing(null);
    setRefresh(n => n + 1);
  }, []);
  const command = useMarketingCommand<LimitsReceipt>(privacy, after);
  dropRef.current = command.drop;

  useEffect(() => {
    if (concealed) return;
    const current = ++generation.current, shown = privacy.current;
    const owned = () => mounted.current && current === generation.current && shown === privacy.current;
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    setState(prior => prior.state === 'READY' ? prior : { state: 'LOADING' });
    api.read(signal, owned).then(view => { if (owned()) setState({ state: 'READY', view }); },
      error => { if (!owned() || abort.signal.aborted) return; setState({ state: error instanceof MarketingError && error.kind === 'DENIED' ? 'DENIED' : 'UNAVAILABLE' }); });
    names.names(signal, owned).then(m => { if (owned()) setSchools(m); }, () => {});
    return () => { abort.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, names, refresh, concealed]);

  const { start, local } = command;
  const view = state.state === 'READY' ? state.view : null;
  const onProvider = useCallback((p: CreativeProviderLimitStatus, d: ProviderDraft) => {
    const input = providerInputFrom(d, p);
    if (!input) { local(); return; }
    start((key, signal, owned) => api.setProvider(input, key, signal, owned));
  }, [api, start, local]);
  const onSchool = useCallback((d: SchoolDraft) => {
    const input = view ? schoolInputFrom(d, view) : null;
    if (!input) { local(); return; }
    start((key, signal, owned) => api.setSchool(input, key, signal, owned));
  }, [api, start, local, view]);
  const onEdit = useCallback((p: CreativeJobProvider | null) => { if (!command.locked) { setEditing(p); command.setOutcome(null); } }, [command]);

  return <CreativeLimitsView language={preferences.language} formattingLocale={formattingLocale} concealed={concealed} state={state} schools={schools}
    outcome={command.outcome} locked={command.locked} canRetry={command.canRetry} editing={editing} onRefresh={() => setRefresh(n => n + 1)} onReveal={reveal}
    onEdit={onEdit} onProvider={onProvider} onSchool={onSchool} onTryAgain={command.tryAgain}/>;
}
