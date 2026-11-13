'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { HqMessageReceipt } from '@hon/contracts';
import { useLocale } from '../localization/provider';
import { CommsError, commsApi, commsId, type CommsApi } from './http';
import { useCommsCommand, useConcealment, type CommsOutcome } from './model';
import { commsText } from './copy';
import { HqMessageView, type CommsMessageState } from './view';

/**
 * One HQ message: content, facts, per-owner delivery (never an address), Send to the owners and Cancel. Each command
 * carries the version that was read; any answer is followed by a fresh read. The server decides, every time.
 */
export function HqMessage({ messageId, api = commsApi }: { messageId: string; api?: CommsApi }): React.ReactElement {
  const { preferences, formattingLocale } = useLocale();
  const language = preferences.language;
  const valid = commsId(messageId) !== null;
  const [state, setState] = useState<CommsMessageState>(valid ? { state: 'LOADING' } : { state: 'INVALID' });
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0), mounted = useRef(false), dropRef = useRef<() => void>(() => {});
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; }; }, []);
  const { concealed, privacy, reveal } = useConcealment(() => {
    generation.current++; dropRef.current(); setBusy(false); setState(valid ? { state: 'LOADING' } : { state: 'INVALID' });
  });
  const after = useCallback((_: CommsOutcome<HqMessageReceipt>) => setRefresh(n => n + 1), []);
  const command = useCommsCommand<HqMessageReceipt>(privacy, after);
  dropRef.current = command.drop;

  useEffect(() => {
    if (concealed || !valid) return;
    const current = ++generation.current, shown = privacy.current, owned = () => mounted.current && current === generation.current && shown === privacy.current;
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    setBusy(true);
    api.read(messageId, signal, owned).then(
      view => { if (owned()) setState({ state: 'READY', view }); },
      error => {
        if (!owned() || abort.signal.aborted) return;
        const kind = error instanceof CommsError ? error.kind : 'UNKNOWN';
        if (kind === 'DENIED') dropRef.current();
        setState({ state: kind === 'DENIED' ? 'DENIED' : kind === 'GONE' ? 'GONE' : kind === 'INVALID' ? 'INVALID' : 'UNAVAILABLE' });
      }).finally(() => { if (owned()) setBusy(false); });
    return () => { abort.abort(); };
  }, [api, messageId, valid, refresh, concealed, privacy]);

  const view = state.state === 'READY' ? state.view : null;
  const { start } = command;
  const onQueue = useCallback(() => {
    if (!view || view.message.status !== 'DRAFT') return;
    const id = view.message.messageId, input = { expectedVersion: view.message.version };
    start((key, signal, owned) => api.queue(id, input, key, signal, owned));
  }, [api, view, start]);
  const onCancel = useCallback(() => {
    if (!view) return;
    const id = view.message.messageId, input = { expectedVersion: view.message.version };
    start((key, signal, owned) => api.cancel(id, input, key, signal, owned));
  }, [api, view, start]);
  const onRefresh = useCallback(() => setRefresh(n => n + 1), []);
  const receipt = command.outcome?.kind === 'DONE' ? command.outcome.receipt : null;
  const doneText = !receipt ? '' : receipt.operation === 'QUEUE' ? commsText(language, 'queuedOk', { n: String(receipt.message.recipientCount) }) : commsText(language, 'cancelledOk');

  return <HqMessageView language={language} formattingLocale={formattingLocale} concealed={concealed} state={state} busy={busy} outcome={command.outcome}
    doneText={doneText} locked={command.locked} canRetry={command.canRetry} onRefresh={onRefresh} onReveal={reveal} onQueue={onQueue} onCancel={onCancel}
    onTryAgain={command.tryAgain}/>;
}
