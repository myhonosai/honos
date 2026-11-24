'use client';
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { MembershipAgreementLinkChannel, MembershipAgreementLinkSendResult, MembershipAgreementSendRead } from '@hon/contracts';
import { agreementLinkText, type AgreementLinkKey } from './copy';
import { LinkError, agreementLinkApi, keepLinkForRetry, newLinkToken, signingLinkUrl, type AgreementLinkApi, type LinkErrorKind, type LinkSend } from './http';
import styles from '../people/people.module.css';

/**
 * 0499 "Membership agreement" card on a student's person card: choose a guardian of the family and email and/or text, then
 * make a one-time link. Only channels the guardian agreed to and has an address for can be picked; the server checks the
 * same again. Delivery is up to the school's live email and text setup. The link is shown here once so staff can copy it.
 */
export type SendRead = Readonly<{ state: 'LOADING' | 'DENIED' | 'UNAVAILABLE' }> | Readonly<{ state: 'READY'; read: MembershipAgreementSendRead }>;
export type SendOutcome = null | Readonly<{ kind: 'SENDING' }> | Readonly<{ kind: 'SENT'; result: MembershipAgreementLinkSendResult; url: string }>
  | Readonly<{ kind: Exclude<LinkErrorKind, 'SESSION'> }>;
export type SendPanelViewProps = Readonly<{
  language: string; read: SendRead; recipient: string; channels: readonly MembershipAgreementLinkChannel[]; outcome: SendOutcome; canRetry: boolean; copied: boolean;
  onRecipient?: ((personId: string) => void) | undefined; onChannel?: ((channel: MembershipAgreementLinkChannel, on: boolean) => void) | undefined;
  onSend?: (() => void) | undefined; onRetry?: (() => void) | undefined; onReload?: (() => void) | undefined; onCopy?: (() => void) | undefined;
}>;
const CHANNELS: readonly MembershipAgreementLinkChannel[] = ['EMAIL', 'SMS'];
const reachOf = (g: MembershipAgreementSendRead['guardians'][number], c: MembershipAgreementLinkChannel) => c === 'EMAIL' ? g.email : g.text;
/** Why a channel cannot be picked for this guardian, or null when it can. */
export function channelBlock(g: MembershipAgreementSendRead['guardians'][number], c: MembershipAgreementLinkChannel): AgreementLinkKey | null {
  const r = reachOf(g, c);
  return !r.address ? (`noAddress_${c}` as AgreementLinkKey) : !r.consent ? (`noConsent_${c}` as AgreementLinkKey) : null;
}
const ERROR: Record<Exclude<LinkErrorKind, 'SESSION'>, AgreementLinkKey> = { DENIED: 'e_DENIED', INVALID: 'e_INVALID', NOT_PUBLISHED: 'e_NOT_PUBLISHED', NOTHING: 'e_NOTHING',
  RECIPIENT: 'e_RECIPIENT', BUSY: 'e_BUSY', ORIGIN: 'e_ORIGIN', UNKNOWN: 'e_UNKNOWN' };

export function SendPanelView(p: SendPanelViewProps): React.ReactElement {
  const t = (key: AgreementLinkKey, vars?: Record<string, string>) => agreementLinkText(p.language, key, vars);
  const base = useId();
  const day = (iso: string) => new Intl.DateTimeFormat(p.language, { dateStyle: 'medium' }).format(new Date(iso));
  const shell = (body: React.ReactNode) => <article className={styles.card} aria-labelledby={`${base}-title`} data-testid="agreement-link">
    <h2 id={`${base}-title`}>{t('cardTitle')}</h2><p className={styles.meta}>{t('cardIntro')}</p>{body}</article>;
  if (p.read.state === 'LOADING') return shell(<p className={styles.meta} role="status">{t('loading')}</p>);
  if (p.read.state === 'DENIED') return shell(<p className={styles.meta} role="note" data-kind="DENIED">{t('denied')}</p>);
  const rs = p.read;
  if (rs.state !== 'READY') return shell(<div className={styles.meta} role="status"><p>{t('unavailable')}</p>
    {p.onReload ? <button type="button" className={styles.secondary} onClick={p.onReload}>{t('reload')}</button> : null}</div>);
  const r = rs.read, busy = p.outcome?.kind === 'SENDING', o = p.outcome;
  const latest = r.latestLink ? <p className={styles.meta} data-kind={`LATEST_${r.latestLink.state}`}>{t(`latest_${r.latestLink.state}` as AgreementLinkKey,
    { date: day(r.latestLink.state === 'OPEN' ? r.latestLink.createdAt : r.latestLink.state === 'EXPIRED' ? r.latestLink.expiresAt : r.latestLink.closedAt ?? r.latestLink.createdAt) })}</p> : null;
  const sent = o?.kind === 'SENT' ? <div className={styles.outcome} data-tone="ok" role="status" data-testid="agreement-link-sent">
    <p>{t('result', { name: r.guardians.find(g => g.personId === o.result.link.recipientPersonId)?.givenName ?? '' })}</p>
    <ul>{o.result.deliveries.map(d => <li key={d.channel} data-outcome={d.outcome}>{t(d.channel)}: {t(d.outcome)}</li>)}</ul>
    <p className={styles.meta}>{t('linkHelp')}</p>
    <input readOnly value={o.url} aria-label={t('copy')} onFocus={e => e.currentTarget.select()} data-testid="agreement-link-url"/>
    {p.onCopy ? <button type="button" className={styles.secondary} onClick={p.onCopy}>{p.copied ? t('copied') : t('copy')}</button> : null}
  </div> : null;
  const problem = o && o.kind !== 'SENDING' && o.kind !== 'SENT' ? <div className={styles.outcome} data-tone={o.kind === 'UNKNOWN' || o.kind === 'BUSY' ? 'waiting' : 'blocked'} role="status"
    data-testid="agreement-link-problem"><p>{t(ERROR[o.kind])}</p>
    {p.canRetry && p.onRetry ? <button type="button" className={styles.primary} onClick={p.onRetry}>{t('tryAgain')}</button> : null}</div> : null;
  if (!r.current) return shell(<p className={styles.meta} role="note" data-kind="NOT_PUBLISHED">{t('notPublished')}</p>);
  if (!r.familyId) return shell(<p className={styles.meta} role="note" data-kind="NO_FAMILY">{t('noFamily')}</p>);
  if (!r.children.length) return shell(<>{sent}<p className={styles.meta} role="note" data-kind="ALL_SIGNED">{t('allSigned')}</p>{latest}</>);
  if (!r.guardians.length) return shell(<p className={styles.meta} role="note" data-kind="NO_GUARDIAN">{t('noGuardian')}</p>);
  const chosen = r.guardians.find(g => g.personId === p.recipient) ?? null;
  return shell(<>
    <p data-testid="agreement-link-covers">{t('covers', { names: r.children.map(c => c.givenName).join(', ') })}</p>
    {latest}
    <fieldset className={styles.form} disabled={busy || p.canRetry}>
      <legend>{t('sendTo')}</legend>
      {r.guardians.map(g => <label key={g.personId} className={styles.check}>
        <input type="radio" name={`${base}-to`} value={g.personId} checked={p.recipient === g.personId} onChange={() => p.onRecipient?.(g.personId)}/>
        <span>{g.givenName} {g.familyName}</span></label>)}
    </fieldset>
    {chosen ? <fieldset className={styles.form} disabled={busy || p.canRetry}>
      <legend>{t('by')}</legend>
      {CHANNELS.map(c => { const block = channelBlock(chosen, c); return <label key={c} className={styles.check}>
        <input type="checkbox" checked={!block && p.channels.includes(c)} disabled={block !== null} data-testid={`agreement-link-${c}`}
          onChange={e => p.onChannel?.(c, e.target.checked)}/>
        <span>{t(c)}{block ? ` (${t(block)})` : ''}</span></label>; })}
    </fieldset> : null}
    <div className={styles.actions}>
      <button type="button" className={styles.primary} data-testid="agreement-link-send" disabled={busy || p.canRetry || !chosen} onClick={p.onSend}>
        {busy ? t('sending') : p.channels.length ? t('send') : t('sendCopyOnly')}</button>
    </div>
    {sent}{problem}
  </>);
}

export type SendPanelDeps = Readonly<{ api?: AgreementLinkApi; token?: () => string; origin?: () => string; copy?: (text: string) => Promise<void>; requestKey?: () => string }>;
/** Controller for one student at the selected school. A request whose outcome is unknown is kept (with its token) so Try again resends it exactly. */
export function AgreementLinkPanel({ language, schoolId, personId, api = agreementLinkApi, token = () => newLinkToken(), origin = () => globalThis.location.origin,
  copy = text => globalThis.navigator.clipboard.writeText(text), requestKey = () => globalThis.crypto.randomUUID() }: { language: string; schoolId: string; personId: string } & SendPanelDeps): React.ReactElement {
  const [read, setRead] = useState<SendRead>({ state: 'LOADING' });
  const [recipient, setRecipient] = useState(''), [channels, setChannels] = useState<readonly MembershipAgreementLinkChannel[]>([]);
  const [outcome, setOutcome] = useState<SendOutcome>(null), [reads, setReads] = useState(0), [copied, setCopied] = useState(false);
  const kept = useRef<LinkSend | null>(null), mounted = useRef(true), [canRetry, setCanRetry] = useState(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; kept.current = null; }; }, []);
  useEffect(() => {
    const abort = new AbortController();
    api.read(schoolId, personId, abort.signal, () => mounted.current).then(value => {
      if (abort.signal.aborted) return;
      setRead({ state: 'READY', read: value });
      setRecipient(prior => value.guardians.some(g => g.personId === prior) ? prior : value.guardians[0]?.personId ?? '');
    }, error => { if (!abort.signal.aborted) setRead({ state: error instanceof LinkError && (error.kind === 'DENIED' || error.kind === 'SESSION') ? 'DENIED' : 'UNAVAILABLE' }); });
    return () => abort.abort();
  }, [api, schoolId, personId, reads]);
  // The channels on offer follow the chosen guardian: every one they can receive is ticked.
  useEffect(() => {
    if (read.state !== 'READY') return;
    const g = read.read.guardians.find(x => x.personId === recipient);
    setChannels(g ? CHANNELS.filter(c => channelBlock(g, c) === null) : []);
  }, [read, recipient]);
  const run = useCallback(async (request: LinkSend) => {
    setOutcome({ kind: 'SENDING' }); setCopied(false);
    try {
      const result = await api.send(request, new AbortController().signal, () => mounted.current);
      kept.current = null; if (!mounted.current) return;
      setCanRetry(false); setOutcome({ kind: 'SENT', result, url: signingLinkUrl(origin(), request.input.token) }); setReads(n => n + 1);
    } catch (error) {
      kept.current = keepLinkForRetry(error) ? request : null; if (!mounted.current) return;
      setCanRetry(kept.current !== null);
      const kind = error instanceof LinkError ? error.kind : 'UNKNOWN';
      if (kind === 'SESSION') { setOutcome(null); return; }
      setOutcome({ kind });
      if (kind !== 'UNKNOWN' && kind !== 'BUSY') setReads(n => n + 1);
    }
  }, [api, origin]);
  const onSend = useCallback(() => {
    if (kept.current || outcome?.kind === 'SENDING' || !recipient) return;
    let request: LinkSend;
    try { request = api.prepare(schoolId, personId, recipient, channels, token(), requestKey()); } catch { setOutcome({ kind: 'INVALID' }); return; }
    void run(request);
  }, [api, schoolId, personId, recipient, channels, token, requestKey, outcome, run]);
  const onRetry = useCallback(() => { if (kept.current && outcome?.kind !== 'SENDING') void run(kept.current); }, [outcome, run]);
  const onCopy = useCallback(() => {
    if (outcome?.kind !== 'SENT') return;
    copy(outcome.url).then(() => { if (mounted.current) setCopied(true); }, () => { /* The field stays selectable. */ });
  }, [copy, outcome]);
  return <SendPanelView language={language} read={read} recipient={recipient} channels={channels} outcome={outcome} canRetry={canRetry} copied={copied}
    onRecipient={id => { if (!kept.current) { setRecipient(id); setOutcome(null); } }}
    onChannel={(c, on) => { if (!kept.current) setChannels(prior => on ? [...new Set([...prior, c])] : prior.filter(x => x !== c)); }}
    onSend={onSend} onRetry={onRetry} onReload={() => setReads(n => n + 1)} onCopy={onCopy}/>;
}
