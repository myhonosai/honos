'use client';

import React, { useEffect, useRef, useState } from 'react';
import { HonCore, useHqModern } from './shell';
import { HqIcon } from './icon';
import styles from './hq-modern.module.css';

export function HonComposer({ context, compact = false }: { context: string; compact?: boolean }): React.ReactElement {
  const { draft, setDraft } = useHqModern();
  return <div className={styles.composer}>
    <label className={styles.srOnly} htmlFor={compact ? 'hon-panel-draft' : 'hon-dashboard-draft'}>Unsent message draft for HON</label>
    <div className={styles.composerInput} data-page-context={context}>
      <textarea id={compact ? 'hon-panel-draft' : 'hon-dashboard-draft'} maxLength={2000} rows={compact ? 3 : 1} placeholder="Message HON…" value={draft} onChange={(event) => setDraft(event.target.value)} aria-describedby={compact ? 'hon-panel-status' : 'hon-dashboard-status'}/>
      <button type="button" disabled aria-label="Send unavailable: HQ conversation service is not connected"><HqIcon name="arrow"/></button>
    </div>
    <div className={styles.composerFooter}><button type="button" disabled className={styles.voice}><HqIcon name="mic"/>Talk to HON</button><small>Microphone off</small>{draft && <button type="button" className={styles.textButton} onClick={() => setDraft('')}>Clear draft</button>}</div>
    <p id={compact ? 'hon-panel-status' : 'hon-dashboard-status'} className={styles.finePrint}>Conversation unavailable. This draft stays on this page and is not sent or saved.</p>
  </div>;
}

export function HonAssistant({ context, onMinimize }: { context: string; onMinimize: () => void }): React.ReactElement {
  const panel = useRef<HTMLElement>(null);
  const [mobile, setMobile] = useState(false);
  useEffect(() => { panel.current?.querySelector<HTMLButtonElement>('button')?.focus(); }, []);
  useEffect(() => {
    const query = window.matchMedia('(max-width: 800px)');
    const update = () => setMobile(query.matches);
    update(); query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    if (!mobile) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const root = panel.current?.closest('[data-view]');
    const targets = root?.querySelectorAll<HTMLElement>('#hq-main, header, nav, footer, section[aria-label="HQ appearance"]');
    const changed = [...(targets ?? [])].filter((element) => !panel.current?.contains(element) && !element.inert);
    changed.forEach((element) => { element.inert = true; });
    return () => { document.body.style.overflow = previous; changed.forEach((element) => { element.inert = false; }); };
  }, [mobile]);
  return <aside id="hon-assistant" ref={panel} className={styles.assistantPanel} role={mobile ? 'dialog' : 'complementary'} aria-modal={mobile ? true : undefined} aria-label="HON assistant" onKeyDown={(event) => {
    if (event.key === 'Escape') { event.preventDefault(); onMinimize(); }
    if (mobile && event.key === 'Tab') {
      const controls = panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), textarea, a[href]');
      if (!controls?.length) return;
      const first = controls[0]!; const last = controls[controls.length - 1]!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  }}>
    <header><HonCore small/><div><h2>HON</h2><p>Executive AI Coordinator</p></div><button type="button" aria-label="Minimize HON assistant" onClick={onMinimize}><HqIcon name="minimize"/></button></header>
    <div className={styles.assistantBody}><p className={styles.contextPill}>Current page: {context}</p><h3>How can HON help here?</h3><p>HQ conversation is not connected yet. Your company tools remain available.</p><p className={styles.finePrint}>Page context is a navigation label, not permission to access records or perform actions.</p></div>
    <HonComposer context={context} compact/>
    <footer><HqIcon name="shield" size={18}/><span>Consequential actions require the appropriate authorization and approval.</span></footer>
  </aside>;
}
