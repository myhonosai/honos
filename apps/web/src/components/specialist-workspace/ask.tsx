'use client';
import React, { useEffect, useRef, useState } from 'react';
import { HON_REPLY_LIMITS } from '@hon/contracts';
import { HON_CONVERSATION_API, HonConversationError, prepareConversation, prepareTurn, type HonConversationApi, type HonSchool, type PreparedHonCommand } from '../hon-command/hon-conversation-http';
import { workspaceText, type WorkspaceKey } from './copy';
import type { SpecialistKey } from './model';
import styles from '../membership-changes/membership-changes.module.css';

export type SpecialistAskState =
  | { state: 'IDLE' }
  | { state: 'ASKING' }
  | { state: 'ANSWERED'; text: string }
  | { state: 'NOT_ANSWERED'; reason: string | null }
  | { state: 'FAILED'; retry: { conversation: PreparedHonCommand | null; conversationId: string | null; turn: PreparedHonCommand | null } | null; denied: boolean };

const STARTERS: Readonly<Record<SpecialistKey, readonly WorkspaceKey[]>> = {
  alex: ['alexQ1', 'alexQ2', 'alexQ3'], jordan: ['jordanQ1', 'jordanQ2', 'jordanQ3'],
  claire: ['claireQ1', 'claireQ2', 'claireQ3'], lena: ['lenaQ1', 'lenaQ2', 'lenaQ3'],
};
export const specialistStarters = (agent: SpecialistKey, language: string): string[] => STARTERS[agent].map(key => workspaceText(language, key));

/**
 * Ask one analysis specialist (0260 / K2) from that specialist's workspace: one new Ask HON conversation and one turn
 * { text, delegation: { agentKey } }. The answer is shown only when COMPLETED. Nothing is sent or changed. An unknown
 * outcome keeps the exact prepared request so "Try again" never creates a second turn or a second provider call.
 */
export function SpecialistAsk({ agent, name, language, school, api = HON_CONVERSATION_API }:
  { agent: SpecialistKey; name: string; language: string; school: HonSchool; api?: HonConversationApi }): React.ReactElement {
  const t = (key: WorkspaceKey, values: Record<string, string | number> = {}) => workspaceText(language, key, { name, ...values });
  const [question, setQuestion] = useState('');
  const [ask, setAsk] = useState<SpecialistAskState>({ state: 'IDLE' });
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const owned = () => mounted.current;

  const run = async (text: string, retry: Extract<SpecialistAskState, { state: 'FAILED' }>['retry']) => {
    setAsk({ state: 'ASKING' });
    let conversation = retry?.conversation ?? null, conversationId = retry?.conversationId ?? null, turn = retry?.turn ?? null;
    try {
      if (!conversationId) {
        conversation ??= prepareConversation(school, `${name}: workspace question`);
        conversationId = (await api.create(conversation, owned)).id;
      }
      turn ??= prepareTurn(school, conversationId, { text, delegation: { agentKey: agent } });
      const receipt = await api.sendTurn(turn, owned);
      if (!owned()) return;
      setAsk(receipt.status === 'COMPLETED' && receipt.reply ? { state: 'ANSWERED', text: receipt.reply } : { state: 'NOT_ANSWERED', reason: receipt.reason });
    } catch (error) {
      if (!owned()) return;
      const kind = error instanceof HonConversationError ? error.kind : 'UNKNOWN';
      setAsk({ state: 'FAILED', denied: kind === 'FORBIDDEN', retry: kind === 'UNKNOWN' ? { conversation, conversationId, turn } : null });
    }
  };
  const trimmed = question.trim();
  const sendable = trimmed.length > 0 && [...trimmed].length <= HON_REPLY_LIMITS.questionCharacters;

  if (ask.state === 'ASKING') return <p className={styles.meta} role="status">{t('asking')}</p>;
  if (ask.state === 'ANSWERED') return <div className={styles.notice} data-testid="specialist-answer">
    <p><strong>{t('answerHead')}</strong></p>
    <p style={{ whiteSpace: 'pre-wrap' }}>{ask.text}</p>
    <div className={styles.row}>
      <button type="button" className={styles.secondary} onClick={() => { void navigator.clipboard?.writeText(ask.text).catch(() => undefined); }}>{t('copy')}</button>
      <button type="button" className={styles.secondary} onClick={() => { setQuestion(''); setAsk({ state: 'IDLE' }); }}>{t('askAnother')}</button>
    </div>
  </div>;
  if (ask.state === 'NOT_ANSWERED') return <div className={styles.notice} role="status" data-testid="specialist-ask-blocked">
    <p>{t('notAnswered', { reason: ask.reason ? ` (${ask.reason})` : '' })}</p>
    <button type="button" className={styles.secondary} onClick={() => setAsk({ state: 'IDLE' })}>{t('askAnother')}</button>
  </div>;
  if (ask.state === 'FAILED') return <div className={styles.notice} role="status" data-testid="specialist-ask-failed">
    <p>{ask.denied ? t('askDenied') : t('failed')}</p>
    {ask.denied ? null : <button type="button" className={styles.secondary} onClick={() => { void run(trimmed, ask.retry); }}>{t('retry')}</button>}
  </div>;
  return <form className={styles.actions} onSubmit={(event) => { event.preventDefault(); if (sendable) void run(trimmed, null); }}>
    <label className={styles.field}>{t('askLabel')}
      <textarea rows={3} maxLength={HON_REPLY_LIMITS.questionCharacters} placeholder={t('askPlaceholder')} value={question}
        onChange={(event) => setQuestion(event.target.value)} data-testid="specialist-question" />
    </label>
    <p className={styles.meta}>{t('askTry')}</p>
    <div className={styles.row}>
      {specialistStarters(agent, language).map(starter => <button key={starter} type="button" className={styles.secondary} data-testid="specialist-starter"
        onClick={() => setQuestion(starter)}>{starter}</button>)}
    </div>
    <button type="submit" className={styles.primary} disabled={!sendable} data-testid="specialist-send">{t('askSend')}</button>
  </form>;
}
