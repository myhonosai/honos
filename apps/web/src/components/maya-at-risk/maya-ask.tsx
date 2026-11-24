'use client';
import React, { useEffect, useRef, useState } from 'react';
import { HON_CONVERSATION_API, HonConversationError, prepareConversation, prepareTurn, type HonConversationApi, type HonSchool, type PreparedHonCommand } from '../hon-command/hon-conversation-http';

/** The question staff send for one student; the student's name never leaves the browser (Maya's facts carry no name). */
export const MAYA_ASK_QUESTION = 'Why is this student at risk, and what could I say to check in with them?';
const PLACEHOLDER = /\[First name\]/g;

export type MayaAskState =
  | { state: 'IDLE' }
  | { state: 'ASKING' }
  | { state: 'ANSWERED'; text: string }
  | { state: 'NOT_ANSWERED'; reason: string | null }
  | { state: 'FAILED'; retry: { conversation: PreparedHonCommand | null; conversationId: string | null; turn: PreparedHonCommand | null } | null; denied: boolean };

/** Fills Maya's [First name] placeholder in this browser only, for the human who already sees the student's name. */
export function personalize(text: string, givenName: string): string { return text.replace(PLACEHOLDER, givenName); }

/**
 * 0284: ask Maya about one at-risk student. One new Ask HON conversation and one turn { agentKey: 'maya', membershipId }.
 * Maya answers in text; nothing is sent or changed. Staff copy the suggested message and send it themselves.
 */
export function MayaAsk({ school, membershipId, givenName, api = HON_CONVERSATION_API }:
  { school: HonSchool; membershipId: string; givenName: string; api?: HonConversationApi }): React.ReactElement {
  const [ask, setAsk] = useState<MayaAskState>({ state: 'IDLE' });
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  const owned = () => mounted.current;

  const run = async (retry: Extract<MayaAskState, { state: 'FAILED' }>['retry']) => {
    setAsk({ state: 'ASKING' });
    let conversation = retry?.conversation ?? null, conversationId = retry?.conversationId ?? null, turn = retry?.turn ?? null;
    try {
      if (!conversationId) {
        conversation ??= prepareConversation(school, 'Maya: student check-in');
        conversationId = (await api.create(conversation, owned)).id;
      }
      turn ??= prepareTurn(school, conversationId, { text: MAYA_ASK_QUESTION, delegation: { agentKey: 'maya', membershipId } });
      const receipt = await api.sendTurn(turn, owned);
      if (!owned()) return;
      setAsk(receipt.status === 'COMPLETED' && receipt.reply ? { state: 'ANSWERED', text: receipt.reply } : { state: 'NOT_ANSWERED', reason: receipt.reason });
    } catch (error) {
      if (!owned()) return;
      const kind = error instanceof HonConversationError ? error.kind : 'UNKNOWN';
      setAsk({ state: 'FAILED', denied: kind === 'FORBIDDEN', retry: kind === 'UNKNOWN' ? { conversation, conversationId, turn } : null });
    }
  };

  if (ask.state === 'IDLE') return <button type="button" data-testid="maya-ask" onClick={() => { void run(null); }}>Ask Maya to explain and suggest a check-in</button>;
  if (ask.state === 'ASKING') return <p role="status">Maya is reading this student’s records…</p>;
  if (ask.state === 'NOT_ANSWERED') return <p role="status" data-testid="maya-ask-blocked">Maya could not answer right now{ask.reason ? ` (${ask.reason})` : ''}. Nothing was sent or changed.</p>;
  if (ask.state === 'FAILED') return <p role="status" data-testid="maya-ask-failed">
    {ask.denied ? 'You need the retention review permission and the AI team at this school to ask Maya.' : 'Maya did not answer. Nothing was sent.'}{' '}
    {ask.denied ? null : <button type="button" onClick={() => { void run(ask.retry); }}>Try again</button>}</p>;
  const text = personalize(ask.text, givenName);
  return <div data-testid="maya-answer">
    <p><strong>Maya</strong> (a suggestion only; nothing was sent):</p>
    <p style={{ whiteSpace: 'pre-wrap' }}>{text}</p>
    <button type="button" onClick={() => { void navigator.clipboard?.writeText(text).catch(() => undefined); }}>Copy</button>
  </div>;
}
