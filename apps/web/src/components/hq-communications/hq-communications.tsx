'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { HqCommunicationSender, HqMessageReceipt, HqSenderReceipt } from '@hon/contracts';
import { useLocale } from '../localization/provider';
import { CommsError, commsApi, type CommsApi, type CommsReceipt } from './http';
import { useCommsCommand, useConcealment, type CommsOutcome } from './model';
import { commsText } from './copy';
import { HqCommunicationsListView, createInputFrom, senderInputFrom, type CommsListState, type ComposeDraft, type ComposeTarget, type SenderDraft } from './view';

const isMessageReceipt = (r: CommsReceipt): r is HqMessageReceipt => 'message' in r;

/**
 * HQ texts and email (HQ-COMM): senders, the compose form for the school the person came from, and the message list.
 * Leaving the tab or a session end hides everything and drops any draft or kept command. Every command answer is
 * followed by a fresh read. The server decides who may read or write, by purpose, every time.
 */
export function HqCommunications({ target, api = commsApi }: { target: ComposeTarget | null; api?: CommsApi }): React.ReactElement {
  const { preferences, formattingLocale } = useLocale();
  const language = preferences.language;
  const [state, setState] = useState<CommsListState>({ state: 'LOADING' });
  const [refresh, setRefresh] = useState(0);
  const [formKey, setFormKey] = useState(0);
  const generation = useRef(0), mounted = useRef(false), dropRef = useRef<() => void>(() => {});
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; }; }, []);
  const { concealed, privacy, reveal } = useConcealment(() => { generation.current++; dropRef.current(); setFormKey(n => n + 1); setState({ state: 'LOADING' }); });
  const after = useCallback((outcome: CommsOutcome<CommsReceipt>) => {
    if (outcome?.kind === 'DONE' && isMessageReceipt(outcome.receipt)) setFormKey(n => n + 1);
    setRefresh(n => n + 1);
  }, []);
  const command = useCommsCommand<CommsReceipt>(privacy, after);
  dropRef.current = command.drop;
  const ownsRead = (current: number, shown: number) => () => mounted.current && current === generation.current && shown === privacy.current;
  const denied = useCallback(() => { generation.current++; dropRef.current(); setState({ state: 'DENIED' }); }, []);
  const schoolId = target?.schoolId ?? null;

  useEffect(() => {
    if (concealed) return;
    const current = ++generation.current, owned = ownsRead(current, privacy.current);
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    setState(prior => prior.state === 'READY' ? prior : { state: 'LOADING' });
    api.list({ schoolId, cursor: null }, signal, owned).then(
      view => { if (owned()) setState({ state: 'READY', view, messages: view.messages, loadingMore: false, moreFailed: false }); },
      error => {
        if (!owned() || abort.signal.aborted) return;
        if (error instanceof CommsError && error.kind === 'DENIED') denied(); else setState({ state: 'UNAVAILABLE' });
      });
    return () => { abort.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, schoolId, refresh, concealed, denied]);

  const onMore = useCallback(() => {
    if (state.state !== 'READY' || !state.view.nextCursor || state.loadingMore) return;
    const owned = ownsRead(generation.current, privacy.current), cursor = state.view.nextCursor;
    setState({ ...state, loadingMore: true, moreFailed: false });
    api.list({ schoolId, cursor }, AbortSignal.timeout(15000), owned).then(
      view => { if (owned()) setState(prior => prior.state !== 'READY' ? prior : { state: 'READY', view,
        messages: [...prior.messages, ...view.messages.filter(m => !prior.messages.some(p => p.messageId === m.messageId))], loadingMore: false, moreFailed: false }); },
      error => {
        if (!owned()) return;
        if (error instanceof CommsError && error.kind === 'DENIED') denied();
        else setState(prior => prior.state !== 'READY' ? prior : { ...prior, loadingMore: false, moreFailed: true });
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, schoolId, state, denied]);

  const { start, local } = command;
  const purposes = state.state === 'READY' ? state.view.viewer.purposes : [];
  const onCompose = useCallback((draft: ComposeDraft) => {
    const input = createInputFrom(draft, target, purposes);
    if (!input) { local(); return; }
    start((key, signal, owned) => api.create(input, key, signal, owned));
  }, [api, target, purposes, start, local]);
  const onSetSender = useCallback((draft: SenderDraft) => {
    const input = senderInputFrom(draft);
    if (!input) { local(); return; }
    start((key, signal, owned) => api.setSender(input, key, signal, owned));
  }, [api, start, local]);
  const onRetireSender = useCallback((sender: HqCommunicationSender) => {
    start((key, signal, owned) => api.retireSender(sender.senderId, key, signal, owned));
  }, [api, start]);
  const onRefresh = useCallback(() => setRefresh(n => n + 1), []);

  const outcome = command.outcome, receipt = outcome?.kind === 'DONE' ? outcome.receipt : null;
  const doneText = !receipt ? '' : isMessageReceipt(receipt) ? commsText(language, 'drafted')
    : commsText(language, (receipt as HqSenderReceipt).operation === 'SENDER_SET' ? 'senderSet' : 'senderRetired');
  return <HqCommunicationsListView language={language} formattingLocale={formattingLocale} concealed={concealed} state={state} target={target}
    outcome={outcome} doneText={doneText} doneMessageId={receipt && isMessageReceipt(receipt) ? receipt.message.messageId : null}
    locked={command.locked} canRetry={command.canRetry} formKey={formKey} onMore={onMore} onRefresh={onRefresh} onReveal={reveal}
    onCompose={onCompose} onSetSender={onSetSender} onRetireSender={onRetireSender} onTryAgain={command.tryAgain}/>;
}
