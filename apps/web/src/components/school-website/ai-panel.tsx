'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { applyWebsiteAiEdits, type SchoolWebsite, type WebsiteAiEditView, type WebsiteAiPrice } from '@hon/contracts';
import { SiteView } from '../school-site/site-view';
import { isWebsiteAiKey, websiteAiText, type WebsiteAiKey } from './ai-copy';
import { WebsiteAiError, websiteAiApi, type WebsiteAiApi, type WebsiteAiCommand, type WebsiteAiErrorKind } from './ai-http';
import type { WebsiteScope } from './http';
import styles from './website.module.css';

const MAX = 1000, SHOWN_TURNS = 12;
type Pending = Readonly<{ key: string; command: WebsiteAiCommand; id: string | null; input: unknown }>;
type Note = null | Readonly<{ kind: 'error'; error: WebsiteAiErrorKind }> | Readonly<{ kind: 'applied' | 'dismissed' }>;

export type WebsiteAiPanelProps = Readonly<{
  scope: WebsiteScope; site: SchoolWebsite; dirty: boolean; busy: boolean; language: string; device: 'desktop' | 'mobile'; schoolName: string;
  api?: WebsiteAiApi; onApplied(site: SchoolWebsite): void; onBusy(busy: boolean): void;
  /** Build from a prompt: the owner's description from the start form, sent once as the first message after the site is created. */
  firstRequest?: string | null; onFirstRequestTaken?(): void;
}>;

/**
 * WB5 "Ask Marcus", as a conversation. The owner writes to Marcus (the first message can be the description that builds
 * the site), Marcus answers each message with closed edits to the saved draft, the owner previews them and applies (one
 * ordinary draft save) or skips them. Earlier messages and answers stay listed. A request whose outcome is unknown keeps
 * its key in memory so Try again replays exactly the same request; it is dropped when this panel unmounts.
 */
export function WebsiteAiPanel(p: WebsiteAiPanelProps): React.ReactElement {
  const api = p.api ?? websiteAiApi;
  const t = (key: WebsiteAiKey, vars?: Record<string, string>) => websiteAiText(p.language, key, vars);
  const [text, setText] = useState(''), [current, setCurrent] = useState<WebsiteAiEditView | null>(null), [showPreview, setShowPreview] = useState(false);
  const [history, setHistory] = useState<readonly WebsiteAiEditView[]>([]), [reload, setReload] = useState(0);
  const [sending, setSending] = useState<WebsiteAiCommand | null>(null), [note, setNote] = useState<Note>(null), [kept, setKept] = useState(false);
  const [building, setBuilding] = useState(false);
  const [price, setPrice] = useState<WebsiteAiPrice | null>(null);
  // A message Marcus never received (refused before anything was sent) still shows in the conversation, with why.
  const [unsent, setUnsent] = useState<null | Readonly<{ request: string; error: WebsiteAiErrorKind }>>(null);
  const mounted = useRef(true), pending = useRef<Pending | null>(null), inFlight = useRef(false), firstTaken = useRef(false);
  const { onApplied, onBusy, onFirstRequestTaken } = p;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; pending.current = null; }; }, []);
  useEffect(() => { onBusy(sending !== null || kept); }, [sending, kept, onBusy]);
  useEffect(() => () => onBusy(false), [onBusy]);

  // The conversation so far (my own messages, oldest first); the newest open suggestion of mine survives a reload.
  useEffect(() => {
    const abort = new AbortController();
    api.list(p.scope, AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]), () => mounted.current).then((list) => {
      if (!mounted.current) return;
      const mine = list.filter((x) => x.mine).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      setHistory(mine.slice(-SHOWN_TURNS));
      setCurrent((c) => c ?? [...mine].reverse().find((x) => x.status === 'RESULT_RECORDED') ?? null);
    }, () => undefined);
    return () => abort.abort();
  }, [api, p.scope, reload]);

  // 0690: what the next message costs, refreshed after each one. Unknown stays unshown (the server still decides).
  useEffect(() => {
    const abort = new AbortController();
    api.price(p.scope, AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]), () => mounted.current)
      .then((x) => { if (mounted.current) setPrice(x); }, () => { if (mounted.current) setPrice(null); });
    return () => abort.abort();
  }, [api, p.scope, reload]);

  const send = useCallback(async () => {
    const r = pending.current;
    if (!r || inFlight.current) return;
    inFlight.current = true; setSending(r.command); setNote(null); setUnsent(null);
    const owned = () => mounted.current && pending.current?.key === r.key;
    let keep = false;
    try {
      if (r.command === 'request') {
        const view = await api.request(p.scope, r.input, r.key, AbortSignal.timeout(90000), owned);
        if (owned()) { setCurrent(view); setShowPreview(view.status === 'RESULT_RECORDED' && (view.edits?.length ?? 0) > 0); if (view.status === 'RESULT_RECORDED' || view.status === 'RESULT_REJECTED') setText(''); }
      } else if (r.command === 'apply') {
        const out = await api.apply(p.scope, r.id!, r.input, r.key, AbortSignal.timeout(30000), owned);
        if (owned()) { setCurrent(null); setShowPreview(false); setNote({ kind: 'applied' }); onApplied(out.website); }
      } else {
        await api.dismiss(p.scope, r.id!, r.key, AbortSignal.timeout(30000), owned);
        if (owned()) { setCurrent(null); setShowPreview(false); setNote({ kind: 'dismissed' }); }
      }
    } catch (error) {
      const kind: WebsiteAiErrorKind = error instanceof WebsiteAiError ? error.kind : 'UNKNOWN';
      keep = kind === 'UNKNOWN';
      if (owned()) {
        const asked = r.command === 'request' && !keep ? (r.input as { request?: unknown }).request : null;
        if (typeof asked === 'string') { setUnsent({ request: asked, error: kind }); setText((x) => x || asked); } else setNote({ kind: 'error', error: kind });
        if (kind === 'GONE') setCurrent(null);
      }
    } finally { inFlight.current = false; }
    if (pending.current?.key === r.key) pending.current = keep ? r : null;
    if (mounted.current) { setSending(null); setKept(!!pending.current); if (!pending.current) { setBuilding(false); setReload((n) => n + 1); } }
  }, [api, p.scope, onApplied]);

  const start = useCallback((command: WebsiteAiCommand, id: string | null, input: unknown): boolean => {
    if (pending.current || inFlight.current || p.busy) return false;
    pending.current = { key: globalThis.crypto.randomUUID(), command, id, input };
    void send();
    return true;
  }, [p.busy, send]);

  // Build from a prompt: the start form's description becomes the first message, sent once, on the saved new draft.
  const firstRequest = p.firstRequest?.trim().slice(0, MAX) ?? '';
  useEffect(() => {
    if (!firstRequest || firstTaken.current || p.dirty || p.busy || current) return;
    if (start('request', null, { expectedRevision: p.site.draftRevision, request: firstRequest })) { firstTaken.current = true; setBuilding(true); onFirstRequestTaken?.(); }
  }, [firstRequest, p.dirty, p.busy, p.site.draftRevision, current, start, onFirstRequestTaken]);

  const request = text.trim();
  const locked = sending !== null || kept || p.busy;
  const edits = current?.status === 'RESULT_RECORDED' ? current.edits ?? [] : [];
  let previewDoc = null;
  if (showPreview && current && edits.length) { try { previewDoc = applyWebsiteAiEdits(p.site.draft, edits).document; } catch { previewDoc = null; } }
  const describe = (e: Record<string, unknown>) => {
    const op = typeof e.op === 'string' && isWebsiteAiKey(`op_${e.op}`) ? t(`op_${e.op}` as WebsiteAiKey) : String(e.op ?? '');
    const page = typeof e.page === 'string' ? e.page : typeof e.slug === 'string' ? e.slug : '';
    const page2 = page ? ` ${t('onPage', { page })}` : '';
    const detail = typeof e.value === 'string' ? `: “${e.value.slice(0, 80)}”` : typeof e.title === 'string' ? `: “${e.title.slice(0, 80)}”` : '';
    return `${op}${page2}${detail}`;
  };
  const statusLine = (v: WebsiteAiEditView) => {
    if (v.status === 'BLOCKED') { const r = v.reason && isWebsiteAiKey(`r_${v.reason}`) ? t(`r_${v.reason}` as WebsiteAiKey) : t('r_other'); return `${t('s_BLOCKED')} ${r}`; }
    if (isWebsiteAiKey(`s_${v.status}`)) return t(`s_${v.status}` as WebsiteAiKey);
    return '';
  };
  // Earlier turns: what the owner wrote and how Marcus's answer ended. The open suggestion is shown below them.
  const earlier = history.filter((x) => x.id !== current?.id);

  return <section className={styles.card} aria-labelledby="site-ai" data-website-ai="">
    <h2 id="site-ai">{t('title')}</h2>
    <p className={styles.meta}>{t('help')}</p>
    <p className={styles.meta}>{t('limits')}</p>
    <ol className={styles.chat} aria-label={t('conversation')} data-turns={earlier.length + (current ? 1 : 0)}>
      {earlier.length === 0 && !current && !sending && !unsent && <li className={styles.meta}>{t('empty')}</li>}
      {earlier.map((x) => <li key={x.id} data-turn={x.id} data-status={x.status}>
        <p className={styles.bubbleMe}><span className={styles.srOnly}>{t('you')}: </span>{x.request}</p>
        <p className={styles.bubbleMarcus}><strong>{t('marcus')}</strong> {x.summary ? `${x.summary} ` : ''}<span className={styles.meta}>{statusLine(x)}</span></p>
      </li>)}
      {current && <li data-turn={current.id} data-status={current.status}>
        <p className={styles.bubbleMe}><span className={styles.srOnly}>{t('you')}: </span>{current.request}</p>
        <div className={styles.bubbleMarcus} data-suggestion={current.id} data-status={current.status}>
          <strong>{t('marcus')}</strong>
          {current.status === 'RESULT_RECORDED' ? <>
            {current.summary && <p>{current.summary}</p>}
            {edits.length === 0 ? <p className={styles.meta}>{t('noChanges')}</p> : <>
              <p className={styles.meta}>{t('changes', { n: String(edits.length) })}</p>
              <details><summary>{t('showChanges')}</summary>
                <ul className={styles.list}>{edits.map((e, i) => <li key={i}>{describe(e as unknown as Record<string, unknown>)}</li>)}</ul></details>
              <div className={styles.row}><button type="button" className={styles.secondary} onClick={() => setShowPreview((v) => !v)}>{showPreview ? t('hidePreview') : t('preview')}</button></div>
            </>}
            {previewDoc && <><p className={styles.meta}>{t('previewNote')}</p>
              <div className={styles.frame} data-device={p.device}><SiteView schoolName={p.schoolName} document={previewDoc} pageSlug="home" base={`/sites/${p.site.publicSlug}`} mode="preview" /></div></>}
            <div className={styles.row}>
              {edits.length > 0 && <button type="button" className={styles.primary} disabled={locked || p.dirty}
                onClick={() => start('apply', current.id, { expectedRevision: p.site.draftRevision })}>{sending === 'apply' ? t('applying') : t('apply')}</button>}
              <button type="button" className={styles.secondary} disabled={locked} onClick={() => start('dismiss', current.id, null)}>{sending === 'dismiss' ? t('dismissing') : t('dismiss')}</button>
            </div>
          </> : current.status === 'RESULT_REJECTED' ? <>
            <p>{t('rejected')}</p>
            <ul className={styles.list}>{current.problems.map((x, i) => <li key={i}>{x}</li>)}</ul>
            <div className={styles.row}><button type="button" className={styles.secondary} disabled={locked} onClick={() => start('dismiss', current.id, null)}>{sending === 'dismiss' ? t('dismissing') : t('dismiss')}</button></div>
          </> : <p role="status">{statusLine(current)}</p>}
        </div>
      </li>}
      {unsent && <li data-turn="unsent">
        <p className={styles.bubbleMe}><span className={styles.srOnly}>{t('you')}: </span>{unsent.request}</p>
        <p className={styles.bubbleMarcus} role="alert"><strong>{t('marcus')}</strong> {t(`e_${unsent.error}` as WebsiteAiKey)}</p></li>}
      {sending === 'request' && <li><p className={styles.bubbleMarcus} role="status"><strong>{t('marcus')}</strong> {building ? t('building') : t('asking')}</p></li>}
    </ol>
    {note && <div className={note.kind === 'error' ? `${styles.notice} ${styles.warn}` : styles.notice} role={note.kind === 'error' ? 'alert' : 'status'}>
      <p>{note.kind === 'error' ? t(`e_${note.error}` as WebsiteAiKey) : t(note.kind)}</p>
      {note.kind === 'error' && kept && <button type="button" className={styles.secondary} disabled={sending !== null} onClick={() => { void send(); }}>{t('tryAgain')}</button>}
    </div>}
    <form className={styles.compose} onSubmit={(e) => { e.preventDefault(); if (request && !locked && !p.dirty) start('request', null, { expectedRevision: p.site.draftRevision, request }); }}>
      <label className={styles.field}>{t('label')}
        <textarea rows={3} maxLength={MAX} value={text} disabled={locked} placeholder={t('placeholder')} onChange={(e) => setText(e.target.value)} /></label>
      <p className={styles.meta}>{t('left', { n: String(MAX - text.length) })}</p>
      {price && <p className={styles.meta} data-website-ai-price={price.paidWith}>{price.paidWith === 'CREATIVE_CREDITS'
        ? t('costCreative', { n: String(price.creditsPerEdit), left: String(price.availableCredits) }) : t('costIncluded')}</p>}
      {p.dirty && <p className={styles.warnText}>{t('saveFirst')}</p>}
      <div className={styles.row}>
        <button type="submit" className={styles.primary} disabled={locked || p.dirty || !request}>{sending === 'request' ? t('asking') : t('ask')}</button></div>
    </form>
  </section>;
}
