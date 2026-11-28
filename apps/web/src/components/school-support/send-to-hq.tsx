'use client';
import React, { useEffect, useRef, useState } from 'react';
import { SUPPORT_MESSAGE_MAX, SUPPORT_SUBJECT_MAX, SUPPORT_TOPICS, supportTextOk, type SupportTopic } from '@hon/contracts';
import { useSchoolShell } from '../school-shell/context';
import { SupportError, keepForRetry, pageHintFrom, supportApi, type SupportApi, type SupportErrorKind } from './http';
import { supportText } from './copy';

/** Hidden characters the server refuses; tab and line breaks are kept. */
const HIDDEN = /[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const clean = (v: string) => v.replace(HIDDEN, '').trim();

/** The subject HQ sees first: the person's own question, cut to a short line. */
export function handoffSubject(question: string | null): string {
  const q = clean((question ?? '').replace(/\s+/g, ' '));
  const short = q.length > 80 ? `${q.slice(0, 79).trimEnd()}…` : q;
  return short.length >= 3 ? short : 'Help with an answer from HON';
}

/** The message HQ sees: the question and HON's answer, so nobody has to explain it twice. Never more than the server takes. */
export function handoffMessage(question: string | null, answer: string | null): string {
  const q = clean(question ?? ''), a = clean(answer ?? '');
  const text = [q ? `My question to HON:\n${q}` : '', a ? `HON answered:\n${a}` : '', 'I still need help from HON HQ.'].filter(Boolean).join('\n\n');
  return text.length > SUPPORT_MESSAGE_MAX ? `${text.slice(0, SUPPORT_MESSAGE_MAX - 1).trimEnd()}…` : text;
}

type Phase = 'CLOSED' | 'OPEN' | 'SENDING' | 'DONE' | SupportErrorKind;

/**
 * "Send to HQ" under a finished HON answer (owner 2026-11-28: HON answers what it can and relays the rest to HQ). It
 * opens a short form already filled with the question and HON's answer. Only the person's own press sends it, as an
 * ordinary 0335 support request; HON never opens a case by itself. The server decides who may ask (school owners by
 * default). An unknown outcome is sent again only with the same key.
 */
export type SendToHqClasses = Readonly<{ box?: string | undefined; button?: string | undefined; meta?: string | undefined }>;
export function SendToHq({ question, answer, api = supportApi, classes = {} }: { question: string | null; answer: string | null; api?: SupportApi; classes?: SendToHqClasses }): React.ReactElement | null {
  const shell = useSchoolShell();
  const selection = shell.phase === 'READY' ? shell.selection : null;
  const [phase, setPhase] = useState<Phase>('CLOSED');
  const [topic, setTopic] = useState<SupportTopic>('OTHER');
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const kept = useRef<{ key: string; body: { topic: SupportTopic; subject: string; message: string; pageHint: string | null } } | null>(null);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; kept.current = null; }, []);
  const language = typeof document !== 'undefined' ? (document.documentElement.lang || 'en').slice(0, 2).toLowerCase() : 'en';
  const t = (key: Parameters<typeof supportText>[1]) => supportText(language, key);
  if (!selection) return null;
  const scope = { organizationId: selection.organizationId, schoolId: selection.schoolId };

  const open = () => { setSubject(handoffSubject(question)); setMessage(handoffMessage(question, answer)); setTopic('OTHER'); kept.current = null; setPhase('OPEN'); };
  const ready = supportTextOk(subject, 3, SUPPORT_SUBJECT_MAX) && supportTextOk(message, 1, SUPPORT_MESSAGE_MAX);
  const send = async () => {
    if (!kept.current) {
      const hint = typeof window !== 'undefined' ? pageHintFrom(window.location.pathname) : null;
      kept.current = { key: globalThis.crypto.randomUUID(), body: { topic, subject, message, pageHint: hint } };
    }
    const request = kept.current;
    setPhase('SENDING');
    try {
      await api.submit(scope, request.body, request.key, AbortSignal.timeout(30000), () => mounted.current);
      kept.current = null;
      if (mounted.current) setPhase('DONE');
    } catch (error) {
      if (!keepForRetry(error)) kept.current = null;
      if (mounted.current) setPhase(error instanceof SupportError && error.kind !== 'SESSION' ? error.kind : 'UNKNOWN');
    }
  };

  if (phase === 'CLOSED') return <div className={classes.box} data-send-to-hq="">
    <button type="button" className={classes.button} onClick={open}>{t('sendToHq')}</button>
    <span className={classes.meta}>{t('sendToHqHint')}</span>
  </div>;
  if (phase === 'DONE') return <p className={classes.meta} role="status" data-send-to-hq="DONE">{t('sentToHq')} <a href="/staff/help">{t('helpLink')}</a>.</p>;
  const busy = phase === 'SENDING';
  const editable = phase === 'OPEN' || (phase !== 'SENDING' && kept.current === null);
  return <form className={classes.box} data-send-to-hq={phase} onSubmit={(e) => { e.preventDefault(); if (ready && !busy) void send(); }}>
    <label>{t('topic')}{' '}
      <select value={topic} disabled={!editable || busy} onChange={(e) => setTopic(e.target.value as SupportTopic)}>
        {SUPPORT_TOPICS.map((k) => <option key={k} value={k}>{t(`t_${k}`)}</option>)}</select></label>
    <label>{t('subject')}<input maxLength={SUPPORT_SUBJECT_MAX} value={subject} disabled={!editable || busy} onChange={(e) => setSubject(e.target.value)} /></label>
    <label>{t('messageToHq')}<textarea rows={5} maxLength={SUPPORT_MESSAGE_MAX} value={message} disabled={!editable || busy} onChange={(e) => setMessage(e.target.value)} /></label>
    <span className={classes.meta}>{t('privacy')}</span>
    {phase !== 'OPEN' && phase !== 'SENDING' ? <p role="alert">{t(`e_${phase}`)}</p> : null}
    <div>
      <button type="submit" className={classes.button} disabled={busy || !ready || phase === 'DENIED' || phase === 'LIMIT'}>{busy ? t('sending') : kept.current && phase === 'UNKNOWN' ? t('tryAgain') : t('sendToHq')}</button>
      <button type="button" className={classes.button} disabled={busy} onClick={() => { kept.current = null; setPhase('CLOSED'); }}>{t('cancel')}</button>
    </div>
  </form>;
}
