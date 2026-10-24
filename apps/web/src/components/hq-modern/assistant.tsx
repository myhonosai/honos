'use client';

import { useLocale } from '../localization/provider';
import React, { useEffect, useRef, useState } from 'react';
import { HonCore, useHqModern } from './shell';
import { HqIcon } from './icon';
import styles from './hq-modern.module.css';

export function HonComposer({ context, compact = false }: { context: string; compact?: boolean }): React.ReactElement {
  const { t,text,number,money,date,formattingLocale } = useLocale();
  const { draft, setDraft } = useHqModern();
  return <div className={styles.composer}>
    <label className={styles.srOnly} htmlFor={compact ? 'hon-panel-draft' : 'hon-dashboard-draft'}>{t("Unsent message draft for HON")}</label>
    <div className={styles.composerInput} data-page-context={context}>
      <textarea id={compact ? 'hon-panel-draft' : 'hon-dashboard-draft'} maxLength={2000} rows={compact ? 3 : 1} placeholder={t("Message HON…")} value={draft} onChange={(event) => setDraft(event.target.value)} aria-describedby={compact ? 'hon-panel-status' : 'hon-dashboard-status'}/>
      <button type="button" disabled aria-label={t("Send unavailable: HQ conversation service is not connected")}><HqIcon name="arrow"/></button>
    </div>
    <div className={styles.composerFooter}><button type="button" disabled className={styles.voice}><HqIcon name="mic"/>{t("Talk to HON")}</button><small>{t("Microphone off")}</small>{draft && <button type="button" className={styles.textButton} onClick={() => setDraft('')}>{t("Clear draft")}</button>}</div>
    <p id={compact ? 'hon-panel-status' : 'hon-dashboard-status'} className={styles.finePrint}>{t("Conversation unavailable. This draft stays on this page and is not sent or saved.")}</p>
  </div>;
}

export function HonAssistant({ context, onMinimize }: { context: string; onMinimize: () => void }): React.ReactElement {
  const { t,text,number,money,date,formattingLocale } = useLocale();
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
    const targets = root?.querySelectorAll<HTMLElement>('#hq-main, header, nav, footer, section[data-hq-appearance]');
    const utility = document.querySelector<HTMLElement>('[data-locale-utility]');
    const changed = [...(targets ?? []), ...(utility ? [utility] : [])].filter((element) => !panel.current?.contains(element) && !element.inert);
    changed.forEach((element) => { element.inert = true; });
    return () => { document.body.style.overflow = previous; changed.forEach((element) => { element.inert = false; }); };
  }, [mobile]);
  return <aside id="hon-assistant" ref={panel} className={styles.assistantPanel} role={mobile ? 'dialog' : 'complementary'} aria-modal={mobile ? true : undefined} aria-label={t("HON assistant")} onKeyDown={(event) => {
    if (event.key === 'Escape') { event.preventDefault(); onMinimize(); }
    if (mobile && event.key === 'Tab') {
      const controls = panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), textarea, a[href]');
      if (!controls?.length) return;
      const first = controls[0]!; const last = controls[controls.length - 1]!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  }}>
    <header><HonCore small/><div><h2>{t("HON")}</h2><p>{t("Executive AI Coordinator")}</p></div><button type="button" aria-label={t("Minimize HON assistant")} onClick={onMinimize}><HqIcon name="minimize"/></button></header>
    <div className={styles.assistantBody}><p className={styles.contextPill}>{t("Current page: {page}",{page:text(context)})}</p><h3>{t("How can HON help here?")}</h3><p>{t("HQ conversation is not connected yet. Your company tools remain available.")}</p><p className={styles.finePrint}>{t("Page context is a navigation label, not permission to access records or perform actions.")}</p></div>
    <HonComposer context={context} compact/>
    <footer><HqIcon name="shield" size={18}/><span>{t("Consequential actions require the appropriate authorization and approval.")}</span></footer>
  </aside>;
}
