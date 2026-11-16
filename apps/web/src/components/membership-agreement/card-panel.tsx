'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { MembershipAgreementCard, MembershipAgreementRequest } from '@hon/contracts';
import { agreementText, type AgreementKey } from './copy';
import {
  AgreementError, newSigningToken, prepareAgreementSend, readAgreementCard, sendAgreementLink, signingUrl, type AgreementRequest, type SchoolScope,
} from './http';
import styles from '../people/people.module.css';

/**
 * The agreement for one membership on the contact card (0410). Staff pick who signs and make a signing link to share with the
 * family; the family signs on their own phone. While the school requires a signature, the start review waits for it (the server
 * refuses the start either way). Nothing here charges or sends a message.
 */
export type AgreementCardState = Readonly<{ kind: 'LOADING' | 'UNAVAILABLE' | 'DENIED' }> | Readonly<{ kind: 'READY'; card: MembershipAgreementCard }>;
export type FreshLink = Readonly<{ requestId: string; url: string }>;

/** True while the start must wait for a signature. */
export function agreementBlocksStart(card: MembershipAgreementCard): boolean {
  return card.membershipState === 'DRAFT' && card.agreementVersion !== null && card.signatureRequired && !card.signed;
}
export function canSendAgreement(card: MembershipAgreementCard): boolean {
  return card.membershipState === 'DRAFT' && card.agreementVersion !== null && !card.signed && card.signers.length > 0;
}
/** The signer offered first: the one the open link went to, else the first allowed signer. */
export function defaultSigner(card: MembershipAgreementCard): string {
  const open = card.requests.find(r => r.state === 'OPEN');
  return open && card.signers.some(s => s.personId === open.signerPersonId) ? open.signerPersonId : card.signers[0]?.personId ?? '';
}
export function agreementProblem(error: unknown): AgreementKey[] {
  if (!(error instanceof AgreementError)) return ['p_UNKNOWN'];
  if (error.problem === 'BLOCKED') return error.blockers.length ? error.blockers.map(b => `b_${b}` as AgreementKey) : ['p_BLOCKED'];
  return [`p_${error.problem}` as AgreementKey];
}
const day = (language: string, value: string) => new Date(value).toLocaleDateString(language, { dateStyle: 'medium' });

export type AgreementPanelViewProps = Readonly<{
  language: string; state: AgreementCardState; signer: string; fresh: FreshLink | null; notices: readonly AgreementKey[]; busy: boolean; canRetry: boolean; copied: boolean;
  onSigner?: ((personId: string) => void) | undefined; onSend?: (() => void) | undefined; onRetry?: (() => void) | undefined; onReload?: (() => void) | undefined;
  onCopy?: (() => void) | undefined;
}>;

/** Pure view: where the agreement stands, who signs, and one button that makes the link. */
export function AgreementPanelView(p: AgreementPanelViewProps): React.ReactElement | null {
  const t = (key: AgreementKey, vars?: Record<string, string | number>) => agreementText(p.language, key, vars);
  const shell = (body: React.ReactNode) => <section className={styles.subsection} data-testid="membership-agreement" aria-labelledby="membership-agreement-title">
    <h4 id="membership-agreement-title">{t('cardTitle')}</h4>{body}</section>;
  const s = p.state, kind = s.kind;
  if (kind === 'LOADING') return shell(<p className={styles.meta} role="status">{t('loading')}</p>);
  if (kind === 'DENIED') return shell(<p className={styles.meta} role="note" data-kind="DENIED">{t('denied')}</p>);
  if (kind === 'UNAVAILABLE' || s.kind !== 'READY') return shell(<div className={styles.notice} role="status" data-kind="UNAVAILABLE"><p>{t('unavailable')}</p>
    {p.onReload ? <button type="button" className={styles.secondary} onClick={p.onReload}>{t('tryAgain')}</button> : null}</div>);
  const c = s.card;
  if (c.agreementVersion === null) return shell(<p className={styles.meta} role="note" data-kind="NO_AGREEMENT">{t('noAgreement')}</p>);
  const name = (personId: string) => { const x = c.signers.find(y => y.personId === personId); return x ? `${x.givenName} ${x.familyName}` : ''; };
  const latest: MembershipAgreementRequest | undefined = c.requests[0];
  const signature = c.requests.find(r => r.signature)?.signature ?? null;
  const notices = p.notices.length ? <div className={styles.notice} role="status" data-testid="membership-agreement-problem">
    {p.notices.map(k => <p key={k}>{t(k)}</p>)}
    {p.canRetry && p.onRetry ? <button type="button" className={styles.primary} onClick={p.onRetry} disabled={p.busy}>{t('tryAgain')}</button> : null}</div> : null;
  const freshShown = p.fresh && latest?.requestId === p.fresh.requestId && latest.state === 'OPEN' ? p.fresh : null;
  return shell(<>
    {signature ? <p data-kind="SIGNED" role="status">{t('signed', { name: signature.signedName, relationship: t(`r_${signature.relationship}`), date: day(p.language, signature.signedAt) })}</p>
      : <p className={styles.meta} data-kind={agreementBlocksStart(c) ? 'REQUIRED' : 'OPTIONAL'}>{c.signatureRequired ? t('required') : t('optional')}</p>}
    {!signature && latest?.state === 'OPEN' ? <p className={styles.meta} data-kind="WAITING">{t('waiting', { name: name(latest.signerPersonId), date: day(p.language, latest.expiresAt) })}</p> : null}
    {!signature && latest?.state === 'EXPIRED' ? <p className={styles.meta} data-kind="EXPIRED">{t('expired', { date: day(p.language, latest.expiresAt) })}</p> : null}
    {freshShown ? <div className={styles.notice} data-testid="membership-agreement-link">
      <p>{t('linkReady', { name: name(latest!.signerPersonId) })}</p>
      <input readOnly value={freshShown.url} aria-label={t('copy')} onFocus={e => e.currentTarget.select()}/>
      {p.onCopy ? <button type="button" className={styles.secondary} onClick={p.onCopy}>{p.copied ? t('copied') : t('copy')}</button> : null}
    </div> : !signature && latest?.state === 'OPEN' ? <p className={styles.meta} role="note">{t('linkHidden')}</p> : null}
    {canSendAgreement(c) ? <div className={styles.row}>
      <label>{t('signer')}<select value={p.signer} disabled={p.busy} data-testid="membership-agreement-signer" onChange={e => p.onSigner?.(e.target.value)}>
        {c.signers.map(x => <option key={x.personId} value={x.personId}>{x.givenName} {x.familyName} ({x.relation === 'SELF' ? t('signerSelf') : t('signerGuardian')})</option>)}
      </select></label>
      <button type="button" className={latest?.state === 'OPEN' ? styles.secondary : styles.primary} data-testid="membership-agreement-send"
        disabled={p.busy || !p.signer} onClick={p.onSend}>{p.busy ? t('sending') : latest?.state === 'OPEN' ? t('sendAgain') : t('send')}</button>
    </div> : null}
    {notices}
  </>);
}

export type AgreementPanelApi = Readonly<{ card: typeof readAgreementCard; send: typeof sendAgreementLink; token: () => string; origin: () => string;
  copy: (text: string) => Promise<void> }>;
const defaultApi: AgreementPanelApi = { card: readAgreementCard, send: sendAgreementLink, token: () => newSigningToken(), origin: () => globalThis.location.origin,
  copy: text => globalThis.navigator.clipboard.writeText(text) };

/**
 * The agreement panel for one membership. A link whose outcome is unknown is kept in memory only (with its token), so Try again
 * resends the identical request; the server never makes two. The link itself is shown only in this session, right after it was
 * made, because the server keeps only its hash.
 */
export function AgreementPanel({ language, scope, membershipId, onBlocking, api = defaultApi }: { language: string; scope: SchoolScope; membershipId: string;
  onBlocking?: ((blocks: boolean) => void) | undefined; api?: AgreementPanelApi }): React.ReactElement | null {
  const [state, setState] = useState<AgreementCardState>({ kind: 'LOADING' });
  const [signer, setSigner] = useState(''), [fresh, setFresh] = useState<FreshLink | null>(null);
  const [notices, setNotices] = useState<readonly AgreementKey[]>([]), [busy, setBusy] = useState(false), [copied, setCopied] = useState(false);
  const [reads, setReads] = useState(0);
  const kept = useRef<AgreementRequest | null>(null), mounted = useRef(true);
  const { organizationId, schoolId } = scope;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; kept.current = null; }; }, []);
  useEffect(() => {
    const abort = new AbortController();
    api.card({ organizationId, schoolId }, membershipId, abort.signal).then(card => {
      if (abort.signal.aborted) return;
      setState({ kind: 'READY', card });
      setSigner(prior => card.signers.some(s => s.personId === prior) ? prior : defaultSigner(card));
    }, error => {
      if (abort.signal.aborted) return;
      setState({ kind: error instanceof AgreementError && (error.problem === 'DENIED' || error.problem === 'SESSION') ? 'DENIED' : 'UNAVAILABLE' });
    });
    return () => { abort.abort(); };
  }, [api, organizationId, schoolId, membershipId, reads]);
  // Only a read that says a signature is still missing holds the start; anything else leaves the server to decide.
  const blocks = state.kind === 'READY' && agreementBlocksStart(state.card);
  useEffect(() => { onBlocking?.(blocks); }, [blocks, onBlocking]);

  const send = useCallback(async (request: AgreementRequest) => {
    setBusy(true); setNotices([]); setCopied(false);
    try {
      const receipt = await api.send(request);
      kept.current = null;
      if (!mounted.current) return;
      setFresh({ requestId: receipt.requestId, url: signingUrl(api.origin(), request.token!) });
      setReads(n => n + 1);
    } catch (error) {
      const keys = agreementProblem(error);
      kept.current = keys[0] === 'p_UNKNOWN' ? request : null;
      if (!mounted.current) return;
      setNotices(keys);
      if (keys[0] !== 'p_UNKNOWN') setReads(n => n + 1);
    } finally { if (mounted.current) setBusy(false); }
  }, [api]);
  const onSend = useCallback(() => {
    if (busy || kept.current || state.kind !== 'READY' || !signer) return;
    let request: AgreementRequest;
    try { request = prepareAgreementSend({ organizationId, schoolId }, membershipId, signer, api.token(), globalThis.crypto.randomUUID()); }
    catch { setNotices(['p_REFUSED']); return; }
    void send(request);
  }, [busy, state, signer, organizationId, schoolId, membershipId, api, send]);
  const onRetry = useCallback(() => { if (kept.current && !busy) void send(kept.current); }, [busy, send]);
  const onSigner = useCallback((id: string) => { if (!kept.current) { setSigner(id); setNotices([]); } }, []);
  const onCopy = useCallback(() => {
    if (!fresh) return;
    api.copy(fresh.url).then(() => { if (mounted.current) setCopied(true); }, () => { /* The field stays selectable. */ });
  }, [api, fresh]);
  return <AgreementPanelView language={language} state={state} signer={signer} fresh={fresh} notices={notices} busy={busy} canRetry={kept.current !== null}
    copied={copied} onSigner={onSigner} onSend={onSend} onRetry={onRetry} onReload={() => setReads(n => n + 1)} onCopy={onCopy}/>;
}
