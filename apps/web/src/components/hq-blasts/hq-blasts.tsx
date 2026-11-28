'use client';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { HqBlastAudiencePreview, HqBlastDetail, HqBlastOptions, HqBlastReceipt, HqBlastSummary } from '@hon/contracts';
import { useLocale } from '../localization/provider';
import { CommsError } from '../hq-communications/http';
import { useCommsCommand, useConcealment, type CommsOutcome } from '../hq-communications/model';
import { hqBlastApi, type HqBlastApi } from './http';
import { hqBlastDraftOf, hqBlastSameAsSaved, hqBlastSaveInput, hqBlastSendAt, insertHqBlastTag, newHqBlastDraft, togglePick, type HqBlastDraft,
  type HqBlastFilterForm, type PickedSchool } from './format';
import { HqBlastsView, type ListRead, type Read, type Screen, type SearchResult, type SendAsk } from './view';

/**
 * HQ > Texts and email > Blasts (HB2, 0712). Like a school's Marketing > Blasts: write one text or email, choose which schools'
 * owners get it with filters and picks, check the count and a sample, then send now or schedule. The draft lives in memory
 * until saved. A session end hides everything and drops any kept command; leaving the tab hides nothing (owner, 2026-11-26).
 * The database decides who may read or send (the HQ owner only) and who is reached.
 */
export function HqBlasts({ api = hqBlastApi }: { api?: HqBlastApi }): React.ReactElement {
  const { preferences, formattingLocale, t: lt } = useLocale();
  const language = preferences.language, timeZone = preferences.timeZone;
  const [list, setList] = useState<ListRead>({ state: 'LOADING' });
  const [refresh, setRefresh] = useState(0);
  const [screen, setScreen] = useState<Screen>({ mode: 'LIST' });
  const [draft, setDraft] = useState<HqBlastDraft | null>(null);
  const [saved, setSaved] = useState<HqBlastDraft | null>(null);
  const [preview, setPreview] = useState<Read<HqBlastAudiencePreview>>(null);
  const [previewTick, setPreviewTick] = useState(0);
  const [options, setOptions] = useState<Read<HqBlastOptions>>(null);
  const [search, setSearch] = useState('');
  const [searchRead, setSearchRead] = useState<Read<readonly SearchResult[]>>(null);
  const [detail, setDetail] = useState<Read<HqBlastDetail>>(null);
  const [detailTick, setDetailTick] = useState(0);
  const [when, setWhen] = useState<'NOW' | 'LATER'>('NOW');
  const [local, setLocal] = useState('');
  const [ask, setAsk] = useState<SendAsk>(null);
  const names = useRef(new Map<string, string>());
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const forget = useCallback(() => {
    setScreen({ mode: 'LIST' }); setDraft(null); setSaved(null); setPreview(null); setOptions(null); setSearch(''); setSearchRead(null); setDetail(null);
    setAsk(null); setWhen('NOW'); setLocal(''); setList({ state: 'LOADING' }); names.current = new Map();
  }, []);
  const { concealed, privacy, reveal } = useConcealment(() => { command.drop(); forget(); });
  const owns = (p: number) => () => mounted.current && p === privacy.current;

  const after = useCallback((outcome: CommsOutcome<HqBlastReceipt>) => {
    setAsk(null);
    setRefresh(n => n + 1);
    if (outcome?.kind !== 'DONE') return;
    const r = outcome.receipt;
    if (r.operation === 'SAVE') {
      const next = hqBlastDraftOf(r.blast, names.current);
      setDraft(next); setSaved(next); setPreview(null); setPreviewTick(n => n + 1);
    } else { setDraft(null); setSaved(null); setPreview(null); setScreen({ mode: 'DETAIL', blastId: r.blast.blastId }); setDetailTick(n => n + 1); }
  }, []);
  const command = useCommsCommand<HqBlastReceipt>(privacy, after);

  // The list: every blast, newest first, with today's count against the daily limit.
  useEffect(() => {
    if (concealed) return;
    const owned = owns(privacy.current), abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    api.list(signal, owned).then(l => { if (owned()) setList({ state: 'READY', list: l }); },
      e => { if (owned() && !abort.signal.aborted) setList(e instanceof CommsError && e.kind === 'DENIED' ? { state: 'DENIED' } : { state: 'UNAVAILABLE' }); });
    return () => abort.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, refresh, concealed]);

  // Filter lists, read once a draft is open.
  const editing = screen.mode === 'EDIT';
  useEffect(() => {
    if (concealed || !editing || options !== null) return;
    const owned = owns(privacy.current);
    setOptions({ state: 'LOADING' });
    api.options(null, AbortSignal.timeout(15000), owned).then(o => { if (owned()) setOptions({ state: 'READY', value: o }); }, () => { if (owned()) setOptions({ state: 'FAILED' }); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, editing, options, concealed]);

  // School search by name, a moment after typing stops.
  useEffect(() => {
    const q = search.trim();
    if (concealed || !editing || q.length < 2) { setSearchRead(null); return; }
    const owned = owns(privacy.current), abort = new AbortController();
    const timer = setTimeout(() => {
      setSearchRead({ state: 'LOADING' });
      api.options(q.slice(0, 80), AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]), owned).then(o => {
        if (!owned() || abort.signal.aborted) return;
        for (const x of o.schools) names.current.set(x.schoolId.toLowerCase(), x.schoolDisplayName);
        setSearchRead({ state: 'READY', value: o.schools });
      }, () => { if (owned() && !abort.signal.aborted) setSearchRead({ state: 'FAILED' }); });
    }, 300);
    return () => { clearTimeout(timer); abort.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, search, editing, concealed]);

  // Who gets the saved draft: read again after every save.
  const savedId = saved?.blastId ?? null;
  useEffect(() => {
    if (concealed || !editing || !savedId) return;
    const owned = owns(privacy.current), abort = new AbortController();
    setPreview({ state: 'LOADING' });
    api.audience(savedId, AbortSignal.any([abort.signal, AbortSignal.timeout(20000)]), owned).then(v => {
      if (!owned() || abort.signal.aborted) return;
      for (const x of v.schools) names.current.set(x.schoolId.toLowerCase(), x.schoolDisplayName);
      setPreview({ state: 'READY', value: v });
    }, () => { if (owned() && !abort.signal.aborted) setPreview({ state: 'FAILED' }); });
    return () => abort.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, savedId, previewTick, editing, concealed]);

  // One handed-over blast: results per school and per delivery.
  const detailId = screen.mode === 'DETAIL' ? screen.blastId : null;
  useEffect(() => {
    if (concealed || !detailId) return;
    const owned = owns(privacy.current), abort = new AbortController();
    setDetail(d => d?.state === 'READY' && d.value.blast.blastId === detailId ? d : { state: 'LOADING' });
    api.read(detailId, AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]), owned).then(v => { if (owned() && !abort.signal.aborted) setDetail({ state: 'READY', value: v }); },
      () => { if (owned() && !abort.signal.aborted) setDetail({ state: 'FAILED' }); });
    return () => abort.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, detailId, detailTick, refresh, concealed]);

  const sendAt = useMemo(() => hqBlastSendAt(local), [local]);
  const dirty = !!draft && !hqBlastSameAsSaved(draft, saved);
  const formatTime = useCallback((iso: string) => new Intl.DateTimeFormat(formattingLocale, { dateStyle: 'medium', timeStyle: 'short', ...(timeZone ? { timeZone } : {}) })
    .format(new Date(iso)), [formattingLocale, timeZone]);
  const featureLabel = useCallback((f: string) => { const x = lt(`planBuilder.f.${f}` as never); return x && !x.startsWith('planBuilder.') ? x : f; }, [lt]);

  const edit = (next: HqBlastDraft) => { setDraft(next); setAsk(null); };
  return <HqBlastsView language={language} formatTime={formatTime} featureLabel={featureLabel} concealed={concealed} list={list} screen={screen}
    draft={draft} dirty={dirty} preview={preview} options={options} search={search} searchRead={searchRead} detail={detail}
    when={when} local={local} sendAt={sendAt} ask={ask} outcome={command.outcome} locked={command.locked} canRetry={command.canRetry}
    onRefresh={() => { setRefresh(n => n + 1); if (savedId) setPreviewTick(n => n + 1); }}
    onReveal={() => { reveal(); setRefresh(n => n + 1); }}
    onNew={() => { command.drop(); const d = newHqBlastDraft(); setDraft(d); setSaved(null); setPreview(null); setAsk(null); setScreen({ mode: 'EDIT' }); }}
    onOpen={(x: HqBlastSummary) => {
      command.drop(); setAsk(null);
      if (x.status === 'DRAFT') { const d = hqBlastDraftOf(x, names.current); setDraft(d); setSaved(d); setScreen({ mode: 'EDIT' }); setPreviewTick(n => n + 1); }
      else { setDetail(null); setScreen({ mode: 'DETAIL', blastId: x.blastId }); }
    }}
    onBack={() => { if (command.locked) return; command.drop(); setScreen({ mode: 'LIST' }); setDraft(null); setSaved(null); setPreview(null); setDetail(null); setAsk(null); setSearch(''); }}
    onDraft={edit}
    onFilters={(patch: Partial<HqBlastFilterForm>) => draft && edit({ ...draft, filters: { ...draft.filters, ...patch } })}
    onTag={(field, tag) => draft && edit({ ...draft, [field]: insertHqBlastTag(draft[field], tag).text })}
    onSearch={setSearch}
    onPick={(school: PickedSchool, as) => {
      if (!draft) return;
      if (school.name) names.current.set(school.schoolId.toLowerCase(), school.name);
      const other = as === 'picked' ? 'leftOut' : 'picked', id = school.schoolId.toLowerCase();
      edit({ ...draft, [as]: togglePick(draft[as], school), [other]: draft[other].filter(x => x.schoolId.toLowerCase() !== id) });
    }}
    onSave={() => {
      if (!draft) return;
      const input = hqBlastSaveInput(draft);
      if (!input) { command.local(); return; }
      command.start((key, signal, owned) => api.save(input, key, signal, owned));
    }}
    onPreviewRetry={() => setPreviewTick(n => n + 1)}
    onWhen={w => { setWhen(w); setAsk(null); }} onLocal={v => { setLocal(v); setAsk(null); }} onAsk={setAsk}
    onConfirm={() => {
      if (ask?.kind === 'SEND' && saved?.blastId && !dirty) {
        const input = { blastId: saved.blastId, expectedVersion: saved.version, sendAt: ask.sendAt };
        command.start((key, signal, owned) => api.send(input, key, signal, owned));
      } else if (ask?.kind === 'CANCEL' && detail?.state === 'READY') {
        const input = { blastId: detail.value.blast.blastId, expectedVersion: detail.value.blast.version };
        command.start((key, signal, owned) => api.cancel(input, key, signal, owned));
      }
    }}
    onTryAgain={command.tryAgain} onDismiss={() => command.drop()} onDetailRetry={() => setDetailTick(n => n + 1)}/>;
}
