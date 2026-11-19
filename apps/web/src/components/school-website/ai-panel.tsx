'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { applyWebsiteAiEdits, type SchoolWebsite, type WebsiteAiEditView } from '@hon/contracts';
import { SiteView } from '../school-site/site-view';
import { isWebsiteAiKey, websiteAiText, type WebsiteAiKey } from './ai-copy';
import { WebsiteAiError, websiteAiApi, type WebsiteAiApi, type WebsiteAiCommand, type WebsiteAiErrorKind } from './ai-http';
import type { WebsiteScope } from './http';
import styles from './website.module.css';

const MAX = 1000;
type Pending = Readonly<{ key: string; command: WebsiteAiCommand; id: string | null; input: unknown }>;
type Note = null | Readonly<{ kind: 'error'; error: WebsiteAiErrorKind }> | Readonly<{ kind: 'applied' | 'dismissed' }>;

export type WebsiteAiPanelProps = Readonly<{
  scope: WebsiteScope; site: SchoolWebsite; dirty: boolean; busy: boolean; language: string; device: 'desktop' | 'mobile'; schoolName: string;
  api?: WebsiteAiApi; onApplied(site: SchoolWebsite): void; onBusy(busy: boolean): void;
}>;

/**
 * WB5 "Ask Marcus": the owner describes a change, Marcus suggests closed edits to the saved draft, the owner previews
 * them and applies (one ordinary draft save) or dismisses. A request whose outcome is unknown keeps its key in memory so
 * Try again replays exactly the same request; it is dropped when this panel unmounts (privacy, school change, sign-out).
 */
export function WebsiteAiPanel(p: WebsiteAiPanelProps): React.ReactElement {
  const api = p.api ?? websiteAiApi;
  const t = (key: WebsiteAiKey, vars?: Record<string, string>) => websiteAiText(p.language, key, vars);
  const [text, setText] = useState(''), [current, setCurrent] = useState<WebsiteAiEditView | null>(null), [showPreview, setShowPreview] = useState(false);
  const [sending, setSending] = useState<WebsiteAiCommand | null>(null), [note, setNote] = useState<Note>(null), [kept, setKept] = useState(false);
  const mounted = useRef(true), pending = useRef<Pending | null>(null), inFlight = useRef(false);
  const { onApplied, onBusy } = p;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; pending.current = null; }; }, []);
  useEffect(() => { onBusy(sending !== null || kept); }, [sending, kept, onBusy]);
  useEffect(() => () => onBusy(false), [onBusy]);

  // The newest open suggestion of mine survives a reload.
  useEffect(() => {
    const abort = new AbortController();
    api.list(p.scope, AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]), () => mounted.current).then(
      (list) => { if (mounted.current) setCurrent((c) => c ?? list.find((x) => x.mine && x.status === 'RESULT_RECORDED') ?? null); }, () => undefined);
    return () => abort.abort();
  }, [api, p.scope]);

  const send = useCallback(async () => {
    const r = pending.current;
    if (!r || inFlight.current) return;
    inFlight.current = true; setSending(r.command); setNote(null);
    const owned = () => mounted.current && pending.current?.key === r.key;
    let keep = false;
    try {
      if (r.command === 'request') {
        const view = await api.request(p.scope, r.input, r.key, AbortSignal.timeout(90000), owned);
        if (owned()) { setCurrent(view); setShowPreview(false); if (view.status === 'RESULT_RECORDED' || view.status === 'RESULT_REJECTED') setText(''); }
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
      if (owned()) { setNote({ kind: 'error', error: kind }); if (kind === 'GONE') setCurrent(null); }
    } finally { inFlight.current = false; }
    if (pending.current?.key === r.key) pending.current = keep ? r : null;
    if (mounted.current) { setSending(null); setKept(!!pending.current); }
  }, [api, p.scope, onApplied]);

  const start = (command: WebsiteAiCommand, id: string | null, input: unknown) => {
    if (pending.current || inFlight.current || p.busy) return;
    pending.current = { key: globalThis.crypto.randomUUID(), command, id, input };
    void send();
  };

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

  return <section className={styles.card} aria-labelledby="site-ai" data-website-ai="">
    <h2 id="site-ai">{t('title')}</h2>
    <p className={styles.meta}>{t('help')}</p>
    <p className={styles.meta}>{t('limits')}</p>
    <label className={styles.field}>{t('label')}
      <textarea rows={3} maxLength={MAX} value={text} disabled={locked} placeholder={t('placeholder')} onChange={(e) => setText(e.target.value)} /></label>
    <p className={styles.meta}>{t('left', { n: String(MAX - text.length) })}</p>
    {p.dirty && <p className={styles.warnText}>{t('saveFirst')}</p>}
    <div className={styles.row}>
      <button type="button" className={styles.primary} disabled={locked || p.dirty || !request}
        onClick={() => start('request', null, { expectedRevision: p.site.draftRevision, request })}>{sending === 'request' ? t('asking') : t('ask')}</button></div>
    {sending === 'request' && <p className={styles.meta} role="status">{t('asking')}</p>}
    {current && <div className={styles.form} data-suggestion={current.id} data-status={current.status}>
      {current.status === 'RESULT_RECORDED' ? <>
        <h3>{t('suggestion')}</h3>
        {current.summary && <p>{current.summary}</p>}
        {edits.length === 0 ? <p className={styles.meta}>{t('noChanges')}</p> : <>
          <p className={styles.meta}>{t('changes', { n: String(edits.length) })}</p>
          <ul className={styles.list}>{edits.map((e, i) => <li key={i}>{describe(e as unknown as Record<string, unknown>)}</li>)}</ul>
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
    </div>}
    {note && <div className={note.kind === 'error' ? `${styles.notice} ${styles.warn}` : styles.notice} role={note.kind === 'error' ? 'alert' : 'status'}>
      <p>{note.kind === 'error' ? t(`e_${note.error}` as WebsiteAiKey) : t(note.kind)}</p>
      {note.kind === 'error' && kept && <button type="button" className={styles.secondary} disabled={sending !== null} onClick={() => { void send(); }}>{t('tryAgain')}</button>}
    </div>}
  </section>;
}
