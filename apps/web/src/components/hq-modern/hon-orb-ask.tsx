'use client';

import React, { useEffect, useId, useRef, useState } from 'react';
import { useLocale } from '../localization/provider';
import { HqHonPanel } from '../hq-hon/hq-hon-panel';
import { useHqModern } from './shell';
import { HqIcon } from './icon';
import { useOrbChatEscape } from '../hon-command/orb-chat-escape';
import styles from './hq-modern.module.css';

/**
 * The HON card on the HQ dashboard (owner 2026-11-27: "this should be working from here, not sent to workspace").
 * "Ask HON anything" opens the real HQ Ask HON right under the card; the microphone opens it and starts listening;
 * expand still opens the full HON assistant. The chat is not modal: the dashboard stays usable around it.
 */
export function HqHonOrbAsk(): React.ReactElement {
  const { t } = useLocale();
  const { openAssistant } = useHqModern();
  const [open, setOpen] = useState(false);
  const [listen, setListen] = useState(0);
  const askButton = useRef<HTMLButtonElement>(null);
  const panelId = useId().replace(/:/g, '');
  const close = () => { setOpen(false); requestAnimationFrame(() => askButton.current?.focus()); };
  // Leaving the dashboard for the full assistant folds the in-place chat first, so only one HON chat is open.
  const expand = () => { setOpen(false); openAssistant(); };
  return <div className={styles.honOrbAsk} data-hon-orb-ask={open ? 'open' : 'closed'}>
    <div className={styles.honEntry} role="group" aria-label={t("Ask HON anything")}>
      <button type="button" className={styles.honEntryMic} aria-label={t("Talk to HON")} aria-controls={open ? panelId : undefined} data-hon-orb-mic=""
        onClick={() => { setOpen(true); setListen((n) => n + 1); }}><HqIcon name="mic" size={22}/></button>
      <button ref={askButton} type="button" className={styles.honEntryAsk} aria-expanded={open} aria-controls={open ? panelId : undefined} data-hon-orb-open=""
        onClick={() => (open ? close() : setOpen(true))}><span>{t("Ask HON anything")}</span></button>
      <button type="button" className={styles.honEntryExpand} aria-label={t("Expand HON conversation")} title={t("Open HON assistant")} data-hon-orb-expand=""
        onClick={expand}><HqIcon name="expand" size={15}/></button>
    </div>
    {open ? <HqHonOrbChat id={panelId} listen={listen} onClose={close}/> : null}
  </div>;
}

function HqHonOrbChat({ id, listen, onClose }: { id: string; listen: number; onClose: () => void }): React.ReactElement {
  const { t } = useLocale();
  const panel = useRef<HTMLElement>(null);
  useEffect(() => { panel.current?.scrollIntoView?.({ block: 'nearest' }); }, []);
  // A new answer shows in the list under the question box: bring the newest one into view, like a chat.
  useEffect(() => {
    const node = panel.current;
    if (!node || typeof MutationObserver === 'undefined') return;
    let newest = node.querySelector('li[data-turn-status]');
    const observer = new MutationObserver(() => {
      const first = node.querySelector('li[data-turn-status]');
      if (first && first !== newest) { newest = first; first.scrollIntoView?.({ block: 'nearest' }); }
    });
    observer.observe(node, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);
  // A tap outside does not close it (the owner reads the answer while using the page); Escape and X do.
  useOrbChatEscape(panel, onClose);
  return <section id={id} ref={panel} className={styles.honOrbChat} role="region" aria-label={t("HON conversation")} data-hon-orb-chat="">
    <header><strong>{t("HON")}</strong><button type="button" aria-label={t("Close HON chat")} onClick={onClose}><HqIcon name="close" size={16}/></button></header>
    {/* The real HQ Ask HON (0263): the server decides access, budget, route and provider. Spoken questions take the same path. */}
    <HqHonPanel agentKey="hon" name="HON" compact voice startVoice={listen} focusQuestion={listen === 0}/>
  </section>;
}
