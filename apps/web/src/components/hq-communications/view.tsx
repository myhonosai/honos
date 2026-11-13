import React, { useState } from 'react';
import { HQ_MESSAGE_CHANNELS, HQ_SENDER_A2P_STATES, hqMessageMaxLength, hqTextPieces, normalizeHqPhone, type HqCommunicationSender, type HqCommunicationsView, type HqMessage,
  type HqMessageChannel, type HqMessageCreateInput, type HqMessageDetail, type HqMessagePurpose, type HqSenderSetInput } from '@hon/contracts';
import { commsCodeKey, commsText, type CommsKey } from './copy';
import type { CommsOutcome } from './model';
import { Facts, formatTime } from '../hq-support/parts';
import styles from '../hq-access/hq-access.module.css';

type T = (key: CommsKey, vars?: Record<string, string>) => string;
const translator = (language: string): T => (key, vars) => commsText(language, key, vars);
const statusTone = (s: HqMessage['status']) => s === 'DRAFT' ? 'waiting' : s === 'CANCELLED' ? 'blocked' : 'ready';

/** Where the compose form points: ids from the page link. The server confirms the school and the owners on save. */
export type ComposeTarget = Readonly<{ organizationId: string; schoolId: string; supportCaseId: string | null }>;
export type ComposeDraft = Readonly<{ purpose: string; channel: string; content: string }>;
export type SenderDraft = Readonly<{ channel: HqMessageChannel; emailFrom: string; emailDisplayName: string; smsServiceSid: string; smsReplyNumber: string; a2pState: string; mms: boolean }>;

/** The person's message as a closed request, or null when it is not one. Content is trimmed, never shortened. */
export function createInputFrom(draft: ComposeDraft, target: ComposeTarget | null, purposes: readonly HqMessagePurpose[]): HqMessageCreateInput | null {
  if (!target || !(purposes as readonly string[]).includes(draft.purpose) || !(HQ_MESSAGE_CHANNELS as readonly string[]).includes(draft.channel)) return null;
  const channel = draft.channel as HqMessageChannel, content = draft.content.trim();
  if (content.length < 1 || content.length > hqMessageMaxLength(channel)) return null;
  return { organizationId: target.organizationId, schoolId: target.schoolId, purpose: draft.purpose as HqMessagePurpose, channel, content, supportCaseId: target.supportCaseId };
}
/** The sender form as a closed request, or null. Texts need the owner's MMS Converter confirmation. */
export function senderInputFrom(d: SenderDraft): HqSenderSetInput | null {
  if (d.channel === 'EMAIL') {
    const emailFrom = d.emailFrom.trim().toLowerCase(), emailDisplayName = d.emailDisplayName.trim();
    if (!emailFrom || !emailDisplayName) return null;
    return { channel: 'EMAIL', emailFrom, emailDisplayName, smsServiceSid: null, smsReplyNumber: null, a2pState: null, mmsConverterConfirmed: null };
  }
  const sid = d.smsServiceSid.trim(), reply = normalizeHqPhone(d.smsReplyNumber.trim());
  if (!/^MG[0-9a-fA-F]{32}$/.test(sid) || reply === null || !d.mms || !(HQ_SENDER_A2P_STATES as readonly string[]).includes(d.a2pState)) return null;
  return { channel: 'SMS', emailFrom: null, emailDisplayName: null, smsServiceSid: `MG${sid.slice(2).toLowerCase()}`, smsReplyNumber: reply, a2pState: d.a2pState as HqSenderSetInput['a2pState'],
    mmsConverterConfirmed: true };
}

export function CommsOutcomeView<R>({ language, outcome, done, canRetry, onTryAgain, children }: { language: string; outcome: CommsOutcome<R>; done: string;
  canRetry: boolean; onTryAgain: () => void; children?: React.ReactNode }): React.ReactElement | null {
  if (!outcome) return null;
  const t = translator(language);
  if (outcome.kind === 'SENDING') return <p className={styles.outcome} role="status" data-comms-outcome="sending">{t('sending')}</p>;
  if (outcome.kind === 'DONE') return <div className={styles.outcome} data-tone="ok" role="status" data-comms-outcome="done"><p>{done}</p>{children}</div>;
  if (outcome.kind === 'UNKNOWN') return <div className={styles.outcome} data-tone="waiting" role="alert" data-comms-outcome="unknown"><p>{t('unknown')}</p>
    {canRetry && <button type="button" className={styles.secondary} onClick={onTryAgain}>{t('tryAgain')}</button>}</div>;
  const key: CommsKey = outcome.kind === 'CHANGED' ? 'changed' : outcome.kind === 'KEY_REUSED' ? 'keyReused' : outcome.kind === 'DENIED' ? 'deniedCommand'
    : outcome.kind === 'INVALID' ? 'invalidCommand' : outcome.kind === 'GONE' ? 'goneCommand' : outcome.kind === 'LOCAL_INVALID' ? 'localInvalid'
    : commsCodeKey('r_', outcome.code);
  return <p className={styles.outcome} data-tone="blocked" role="alert" data-comms-outcome={outcome.kind.toLowerCase()}>{t(key)}</p>;
}

/** The live counter under the message box: characters, encoding and text pieces; long texts go as one MMS. */
export function PieceCounter({ language, channel, content }: { language: string; channel: HqMessageChannel; content: string }): React.ReactElement {
  const t = translator(language), max = hqMessageMaxLength(channel), clean = content.trim(), over = clean.length - max;
  if (channel === 'EMAIL') return <p className={styles.meta} aria-live="polite" data-comms-counter="email">
    {over > 0 ? t('tooLong', { n: String(over) }) : `${clean.length} / ${max}`}</p>;
  const p = hqTextPieces(clean);
  return <p className={styles.meta} aria-live="polite" data-comms-counter="sms" data-pieces={p.pieces} data-mms={p.asMms}>
    {over > 0 ? t('tooLong', { n: String(over) }) : t(p.asMms ? 'piecesMms' : 'pieces', { chars: String(p.characters), encoding: p.encoding, pieces: String(p.pieces) })}</p>;
}

function ComposeForm({ language, purposes, target, locked, onCompose }: { language: string; purposes: readonly HqMessagePurpose[]; target: ComposeTarget;
  locked: boolean; onCompose: (d: ComposeDraft) => void }): React.ReactElement {
  const t = translator(language);
  const [channel, setChannel] = useState<HqMessageChannel>('EMAIL');
  const [content, setContent] = useState('');
  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const f = new FormData(event.currentTarget);
    onCompose({ purpose: String(f.get('purpose') ?? ''), channel, content });
  };
  return <form className={styles.form} onSubmit={submit} aria-labelledby="hq-comms-compose" data-comms-form="compose">
    <h2 id="hq-comms-compose">{t('compose')}</h2>
    <p className={styles.meta}>{t('composeFor')}{target.supportCaseId ? ` ${t('supportCase')}` : ''}</p>
    <fieldset className={styles.fields} disabled={locked}>
      <div className={styles.pair}>
        <div><label htmlFor="hq-comms-purpose">{t('purpose')}</label>
          <select id="hq-comms-purpose" name="purpose" defaultValue={target.supportCaseId && purposes.includes('SUPPORT') ? 'SUPPORT' : purposes[0]}>
            {purposes.map(p => <option key={p} value={p}>{t(p)}</option>)}</select></div>
        <div><label htmlFor="hq-comms-channel">{t('channel')}</label>
          <select id="hq-comms-channel" name="channel" value={channel} onChange={e => setChannel(e.currentTarget.value === 'SMS' ? 'SMS' : 'EMAIL')}>
            {HQ_MESSAGE_CHANNELS.map(c => <option key={c} value={c}>{t(c)}</option>)}</select></div>
      </div>
      <label htmlFor="hq-comms-content">{t('content')}</label>
      <textarea id="hq-comms-content" name="content" required rows={6} value={content} onChange={e => setContent(e.currentTarget.value)} aria-describedby="hq-comms-content-help hq-comms-counter"/>
      <p id="hq-comms-content-help" className={styles.meta}>{t(channel === 'SMS' ? 'contentHelpSms' : 'contentHelpEmail', { max: String(hqMessageMaxLength(channel)) })}</p>
      <div id="hq-comms-counter"><PieceCounter language={language} channel={channel} content={content}/></div>
    </fieldset>
    <div className={styles.actions}><button type="submit" className={styles.primary} disabled={locked}>{t('saveDraft')}</button></div>
  </form>;
}

function SenderCard({ language, channel, sender, owner, locked, onSet, onRetire }: { language: string; channel: HqMessageChannel; sender: HqCommunicationSender | null;
  owner: boolean; locked: boolean; onSet: (d: SenderDraft) => void; onRetire: (s: HqCommunicationSender) => void }): React.ReactElement {
  const t = translator(language);
  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const f = new FormData(event.currentTarget), v = (k: string) => String(f.get(k) ?? '');
    onSet({ channel, emailFrom: v('emailFrom'), emailDisplayName: v('emailDisplayName'), smsServiceSid: v('smsServiceSid'), smsReplyNumber: v('smsReplyNumber'), a2pState: v('a2pState'), mms: f.get('mms') === 'yes' });
  };
  const id = `hq-comms-sender-${channel.toLowerCase()}`;
  return <article className={styles.card} aria-labelledby={id} data-comms-sender={channel}>
    <div className={styles.cardHead}><h3 id={id}>{t(channel)}</h3>
      <span className={styles.status} data-tone={sender ? 'ready' : 'waiting'}>{sender ? '✓' : '—'}</span></div>
    <p className={styles.meta}>{!sender ? t('senderNone') : channel === 'EMAIL'
      ? t('senderEmail', { name: sender.emailDisplayName ?? '', email: sender.emailFrom ?? '' })
      : t('senderSms', { sid: sender.smsServiceSid ?? '', number: sender.smsReplyNumber ?? '', a2p: t(sender.a2pState ?? 'NOT_REGISTERED') })}</p>
    {owner && sender && <div className={styles.actions}><button type="button" className={styles.danger} disabled={locked} onClick={() => onRetire(sender)}>{t('retire')}</button></div>}
    {owner && !sender && <form className={styles.form} onSubmit={submit} data-comms-form={`sender-${channel}`}>
      <fieldset className={styles.fields} disabled={locked}>{channel === 'EMAIL' ? <>
        <label htmlFor={`${id}-from`}>{t('emailFrom')}</label><input id={`${id}-from`} name="emailFrom" type="email" required autoComplete="off"/>
        <label htmlFor={`${id}-name`}>{t('emailDisplayName')}</label><input id={`${id}-name`} name="emailDisplayName" required maxLength={120} autoComplete="off"/>
      </> : <>
        <label htmlFor={`${id}-sid`}>{t('smsServiceSid')}</label>
        <input id={`${id}-sid`} name="smsServiceSid" required pattern="MG[0-9a-fA-F]{32}" autoComplete="off" aria-describedby={`${id}-sid-help`}/>
        <p id={`${id}-sid-help`} className={styles.meta}>{t('smsSidHelp')}</p>
        <label htmlFor={`${id}-reply`}>{t('smsReplyNumber')}</label>
        <input id={`${id}-reply`} name="smsReplyNumber" type="tel" required autoComplete="off" aria-describedby={`${id}-reply-help`}/>
        <p id={`${id}-reply-help`} className={styles.meta}>{t('smsReplyHelp')}</p>
        <label htmlFor={`${id}-a2p`}>{t('a2pState')}</label>
        <select id={`${id}-a2p`} name="a2pState" defaultValue="NOT_REGISTERED">{HQ_SENDER_A2P_STATES.map(s => <option key={s} value={s}>{t(s)}</option>)}</select>
        <label><input type="checkbox" name="mms" value="yes" required/> {t('mmsConfirm')}</label>
      </>}</fieldset>
      <div className={styles.actions}><button type="submit" className={styles.primary} disabled={locked}>{t('setSender')}</button></div>
    </form>}
  </article>;
}

export type CommsListState = { state: 'LOADING' } | { state: 'DENIED' } | { state: 'UNAVAILABLE' }
  | { state: 'READY'; view: HqCommunicationsView; messages: readonly HqMessage[]; loadingMore: boolean; moreFailed: boolean };
export type CommsListViewProps = Readonly<{ language: string; formattingLocale: string; concealed: boolean; state: CommsListState; target: ComposeTarget | null;
  outcome: CommsOutcome<unknown>; doneText: string; doneMessageId: string | null; locked: boolean; canRetry: boolean; formKey: number;
  onMore: () => void; onRefresh: () => void; onReveal: () => void; onCompose: (d: ComposeDraft) => void; onSetSender: (d: SenderDraft) => void;
  onRetireSender: (s: HqCommunicationSender) => void; onTryAgain: () => void }>;

function MessageFacts({ t, m, formattingLocale }: { t: T; m: HqMessage; formattingLocale: string }): React.ReactElement {
  const s = m.deliverySummary;
  return <Facts rows={[[t('organization'), m.organizationDisplayName], [t('school'), m.schoolDisplayName], [t('purpose'), t(m.purpose)], [t('channel'), t(m.channel)],
    [t('recipients'), String(m.recipientCount)], [t('createdBy'), m.createdBy.displayName], [t('created'), `${formatTime(formattingLocale, m.createdAt)} UTC`],
    ...(m.queuedAt ? [[t('queued'), `${formatTime(formattingLocale, m.queuedAt)} UTC`] as [string, string]] : []),
    ...(m.cancelledAt ? [[t('cancelled'), `${formatTime(formattingLocale, m.cancelledAt)} UTC`] as [string, string]] : []),
    ...(m.status !== 'DRAFT' ? [[t('delivery'), t('deliverySummary', { accepted: String(s.accepted), delivered: String(s.delivered), pending: String(s.pending),
      suppressed: String(s.suppressed), failed: String(s.failed), unknown: String(s.unknown) })] as [string, string]] : [])]}/>;
}

function Head({ t, title, back, concealed, busy, onRefresh }: { t: T; title: string; back: boolean; concealed: boolean; busy: boolean; onRefresh: () => void }): React.ReactElement {
  return <header className={styles.head}>
    <div>{back && <p className={styles.meta}><a href="/hq/communications">{t('back')}</a></p>}<h1>{title}</h1><p className={styles.intro}>{t('intro')}</p></div>
    {!concealed && <button type="button" className={styles.secondary} disabled={busy} onClick={onRefresh}>{t('refresh')}</button>}
  </header>;
}

/** Presentation only. Every fact comes from the verified server answer. */
export function HqCommunicationsListView(props: CommsListViewProps): React.ReactElement {
  const { language, formattingLocale, concealed, state } = props;
  const t = translator(language);
  const head = <Head t={t} title={t('title')} back={false} concealed={concealed} busy={state.state === 'LOADING'} onRefresh={props.onRefresh}/>;
  if (concealed) return <section className={styles.access} data-hq-comms="concealed">{head}
    <div className={styles.notice} role="status"><p>{t('concealed')}</p><button type="button" className={styles.secondary} onClick={props.onReveal}>{t('reveal')}</button></div></section>;
  if (state.state !== 'READY') return <section className={styles.access} data-hq-comms={state.state.toLowerCase()} aria-busy={state.state === 'LOADING'}>{head}
    <p className={styles.notice} role="status">{t(state.state === 'LOADING' ? 'loading' : state.state === 'DENIED' ? 'denied' : 'unavailable')}</p></section>;
  const v = state.view, owner = v.viewer.canManageSenders;
  return <section className={styles.access} data-hq-comms="ready">{head}
    <p className={styles.meta}>{v.viewer.purposes.length ? t('viewer', { name: v.viewer.displayName, purposes: v.viewer.purposes.map(p => t(p)).join(', ') })
      : t('viewerNone', { name: v.viewer.displayName })}</p>
    <CommsOutcomeView language={language} outcome={props.outcome} done={props.doneText} canRetry={props.canRetry} onTryAgain={props.onTryAgain}>
      {props.doneMessageId && <a className={styles.secondary} href={`/hq/communications/${props.doneMessageId}`}>{t('reviewSend')}</a>}</CommsOutcomeView>
    {props.target && v.viewer.purposes.length > 0 ? <ComposeForm key={props.formKey} language={language} purposes={v.viewer.purposes} target={props.target}
      locked={props.locked} onCompose={props.onCompose}/> : <p className={styles.notice}>{t('composeHint')}</p>}
    <h2>{t('senders')}</h2>
    {!owner && <p className={styles.meta}>{t('senderOwnerOnly')}</p>}
    <div className={styles.list}>{HQ_MESSAGE_CHANNELS.map(c => <SenderCard key={c} language={language} channel={c} sender={v.senders[c]} owner={owner}
      locked={props.locked} onSet={props.onSetSender} onRetire={props.onRetireSender}/>)}</div>
    <h2>{t('title')}</h2>
    {state.messages.length === 0 ? <p className={styles.notice}>{t('none')}</p> : <ul className={styles.list} aria-label={t('title')}>
      {state.messages.map(m => <li key={m.messageId} className={styles.card} data-comms-message={m.messageId}>
        <div className={styles.cardHead}><h3><a href={`/hq/communications/${m.messageId}`}>{`${m.schoolDisplayName} · ${t(m.purpose)} · ${t(m.channel)}`}</a></h3>
          <span className={styles.status} data-tone={statusTone(m.status)}>{t(m.status)}</span></div>
        <p className={styles.meta}>{m.content.length > 160 ? `${m.content.slice(0, 160)}…` : m.content}</p>
        <MessageFacts t={t} m={m} formattingLocale={formattingLocale}/>
      </li>)}</ul>}
    {state.moreFailed && <p className={styles.meta} role="alert">{t('moreFailed')}</p>}
    {v.nextCursor && <div className={styles.actions}><button type="button" className={styles.secondary} disabled={state.loadingMore} onClick={props.onMore}>{t('more')}</button></div>}
    <p className={styles.meta}>{t('asOf', { time: formatTime(formattingLocale, v.asOf) })}</p>
  </section>;
}

export type CommsMessageState = { state: 'LOADING' } | { state: 'DENIED' } | { state: 'UNAVAILABLE' } | { state: 'GONE' } | { state: 'INVALID' }
  | { state: 'READY'; view: HqMessageDetail };
export type CommsMessageViewProps = Readonly<{ language: string; formattingLocale: string; concealed: boolean; state: CommsMessageState; busy: boolean;
  outcome: CommsOutcome<unknown>; doneText: string; locked: boolean; canRetry: boolean; onRefresh: () => void; onReveal: () => void; onQueue: () => void;
  onCancel: () => void; onTryAgain: () => void }>;

/** Whether the screen offers Cancel. The database still decides: it refuses once any delivery reached the provider. */
export function canOfferCancel(d: HqMessageDetail): boolean {
  return d.message.status === 'DRAFT' || (d.message.status === 'QUEUED' && d.deliveries.every(x => x.status === 'PENDING' || x.status === 'SUPPRESSED')
    && d.deliveries.some(x => x.status === 'PENDING'));
}

export function HqMessageView(props: CommsMessageViewProps): React.ReactElement {
  const { language, formattingLocale, concealed, state } = props;
  const t = translator(language);
  const head = <Head t={t} title={t('messageTitle')} back concealed={concealed} busy={props.busy} onRefresh={props.onRefresh}/>;
  if (concealed) return <section className={styles.access} data-hq-comms="concealed">{head}
    <div className={styles.notice} role="status"><p>{t('concealed')}</p><button type="button" className={styles.secondary} onClick={props.onReveal}>{t('reveal')}</button></div></section>;
  if (state.state !== 'READY') return <section className={styles.access} data-hq-comms={state.state.toLowerCase()} aria-busy={state.state === 'LOADING'}>{head}
    <p className={styles.notice} role="status">{t(state.state === 'LOADING' ? 'loadingMessage' : state.state === 'DENIED' ? 'denied' : state.state === 'GONE' ? 'gone'
      : state.state === 'INVALID' ? 'invalid' : 'unavailable')}</p></section>;
  const { message: m, deliveries } = state.view;
  return <section className={styles.access} data-hq-comms="ready" data-comms-status={m.status}>{head}
    <div className={styles.cardHead}><h2>{`${m.schoolDisplayName} · ${t(m.purpose)} · ${t(m.channel)}`}</h2>
      <span className={styles.status} data-tone={statusTone(m.status)}>{t(m.status)}</span></div>
    <MessageFacts t={t} m={m} formattingLocale={formattingLocale}/>
    <article className={styles.card} aria-label={t('content')}><p style={{ whiteSpace: 'pre-wrap' }}>{m.content}</p>
      {m.channel === 'SMS' && <PieceCounter language={language} channel="SMS" content={m.content}/>}</article>
    <CommsOutcomeView language={language} outcome={props.outcome} done={props.doneText} canRetry={props.canRetry} onTryAgain={props.onTryAgain}/>
    <div className={styles.actions}>
      {m.status === 'DRAFT' && <button type="button" className={styles.primary} disabled={props.locked} onClick={props.onQueue} aria-describedby="hq-comms-queue-help">{t('queue')}</button>}
      {canOfferCancel(state.view) && <button type="button" className={styles.danger} disabled={props.locked} onClick={props.onCancel} aria-describedby="hq-comms-cancel-help">{t('cancel')}</button>}
    </div>
    {m.status === 'DRAFT' && <p id="hq-comms-queue-help" className={styles.meta}>{t('queueHelp')}</p>}
    {canOfferCancel(state.view) && <p id="hq-comms-cancel-help" className={styles.meta}>{t('cancelHelp')}</p>}
    <h2>{t('deliveries')}</h2>
    {deliveries.length === 0 ? <p className={styles.notice}>{t('noDeliveries')}</p> : <div role="region" aria-label={t('deliveries')} tabIndex={0} style={{ overflowX: 'auto' }}>
      <table><thead><tr><th scope="col">{t('recipient')}</th><th scope="col">{t('status')}</th><th scope="col">{t('attempt')}</th><th scope="col">{t('sentAs')}</th><th scope="col">{t('updated')}</th></tr></thead>
        <tbody>{deliveries.map(d => <tr key={d.deliveryId} data-comms-delivery={d.status}>
          <td>{d.recipient.displayName}</td>
          <td>{t(commsCodeKey('d_', d.status))}{d.holdReason ? ` · ${t(commsCodeKey('h_', d.holdReason))}` : ''}{d.failureCode ? ` · ${t(commsCodeKey('f_', d.failureCode))}` : ''}</td>
          <td>{d.attempt}</td><td>{d.sentAs ?? '—'}{d.segments ? ` · ${d.segments}` : ''}</td><td>{`${formatTime(formattingLocale, d.updatedAt)} UTC`}</td>
        </tr>)}</tbody></table></div>}
    <p className={styles.meta}>{t('asOf', { time: formatTime(formattingLocale, state.view.asOf) })}</p>
  </section>;
}
