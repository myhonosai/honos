'use client';

import React, { useRef, useState } from 'react';
import { HonPanel } from '../hon-command/hon-command';
import styles from './shell.module.css';

/**
 * The corner HON button (owner 2026-11-19): opens HON as a pop-up over the current page instead of
 * leaving it, so whatever the person was doing stays exactly where it was. The pop-up is the same
 * HON as the full workspace (same verified school, same conversation) and links there to expand.
 * The school is resolved from the signed-in session when it opens; the button itself reads nothing.
 */
export function ShellHonCorner({ path, label, title, inert, asleep = false }: { path: string; label: string; title: string; inert?: boolean; asleep?: boolean }): React.ReactElement {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const close = () => { setOpen(false); requestAnimationFrame(() => button.current?.focus()); };
  return <>
    <button ref={button} type="button" inert={inert} className={styles.honLauncher} data-hon-corner="" aria-haspopup="dialog" aria-expanded={open}
      aria-label={label} title={title} onClick={() => setOpen(true)}>
      <img src="/ai/hon-core.webp" alt="" width={44} height={44} /><span>{label}</span></button>
    {/* Behind the screensaver the pop-up stays open (nothing typed is lost) but is hidden and inert, never shown over it. */}
    {open ? <div hidden={asleep} inert={asleep} data-hon-corner-popup=""><HonPanel open placement="corner" onClose={close} returnPath={path} /></div> : null}
  </>;
}
