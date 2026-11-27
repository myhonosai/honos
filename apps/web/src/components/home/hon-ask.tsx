'use client';

import React, { useId, useRef, useState } from 'react';
import { HonConversation } from '../hon-command/hon-conversation-panel';
import { honExpandHref } from '../hon-command/hon-command';
import { ShellIcon } from '../school-shell/icons';
import { useOrbChatEscape } from '../hon-command/orb-chat-escape';
import { homeText } from './copy';
import styles from './home.module.css';

type School = Readonly<{ organizationId: string; schoolId: string }>;

/**
 * The HON card on the school Home (owner 2026-11-27: "this should be working from here, not sent to workspace").
 * "Ask HON anything" opens the real school Ask HON conversation right under the card; the microphone opens it and starts
 * listening; expand still opens the full HON workspace. The school is the one the shell verified (as for the Team chat),
 * and the conversation is the same one the corner chat and the full workspace show. Not modal: the page stays usable.
 */
export function HonHomeAsk({ school, language, returnPath = '/staff/dashboard' }: { school: School; language: string; returnPath?: string }): React.ReactElement {
  const t = (key: Parameters<typeof homeText>[1]) => homeText(language, key);
  const [open, setOpen] = useState(false);
  const [listen, setListen] = useState(0);
  const askButton = useRef<HTMLButtonElement>(null);
  const panelId = useId().replace(/:/g, '');
  const close = () => { setOpen(false); requestAnimationFrame(() => askButton.current?.focus()); };
  return <div className={styles.honAsk} data-hon-home-ask={open ? 'open' : 'closed'}>
    <div className={styles.honAskBar} role="group" aria-label={t('honAskAnything')}>
      <button type="button" className={styles.honAskMic} aria-label={t('honTalk')} aria-controls={open ? panelId : undefined} data-hon-orb-mic=""
        onClick={() => { setOpen(true); setListen((n) => n + 1); }}><MicIcon/></button>
      <button ref={askButton} type="button" className={styles.honAskOpen} aria-expanded={open} aria-controls={open ? panelId : undefined} data-hon-orb-open=""
        onClick={() => (open ? close() : setOpen(true))}><ShellIcon name="hon"/><span>{t('honAskAnything')}</span></button>
      <a className={styles.honAskExpand} href={honExpandHref(returnPath, null)} aria-label={t('honExpand')} title={t('honExpand')} data-hon-orb-expand=""><ExpandIcon/></a>
    </div>
    {open ? <HomeChat id={panelId} label={t('honChat')} onClose={close}>
      <button type="button" className={styles.honAskClose} aria-label={t('honClose')} onClick={close}><CloseIcon/></button>
      {/* The real school Ask HON: the server checks the person, the school, readiness and every rule; voice takes the same send path. */}
      <HonConversation school={school} presentation="dock" startVoice={listen}/>
    </HomeChat> : null}
  </div>;
}

function HomeChat({ id, label, onClose, children }: { id: string; label: string; onClose: () => void; children: React.ReactNode }): React.ReactElement {
  const panel = useRef<HTMLElement>(null);
  // A tap outside does not close it (the person reads the answer while using the page); Escape and X do.
  useOrbChatEscape(panel, onClose);
  return <section id={id} ref={panel} className={styles.honAskChat} role="region" aria-label={label} data-hon-orb-chat="">{children}</section>;
}

const svg = (d: string) => <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d}/></svg>;
const MicIcon = () => svg('M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3zM5 11v1a7 7 0 0 0 14 0v-1M12 19v3M8 22h8');
const ExpandIcon = () => svg('M14 4h6v6M20 4l-7 7M10 20H4v-6M4 20l7-7');
const CloseIcon = () => svg('M6 6l12 12M18 6L6 18');
