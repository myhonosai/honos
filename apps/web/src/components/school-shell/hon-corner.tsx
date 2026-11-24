'use client';

import React, { useEffect, useRef, useState } from 'react';
import { HonCornerDock } from '../hon-command/hon-command';
import styles from './shell.module.css';

/** How long the dock takes to shrink back into the corner; matches `hon-dock-out` in hon-command.module.css. */
const SHRINK_MS = 160;

type DockState = 'closed' | 'open' | 'minimized';

function reducedMotion(): boolean {
  return typeof window === 'undefined' || typeof window.matchMedia !== 'function' || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * The corner HON orb (owner 2026-11-19, reworked 2026-11-22 "like Manus CRM"): tapping it opens HON as a chat window
 * docked in this same corner, over the page instead of leaving it. Minimize or close shrinks it back into the orb.
 * Minimize keeps the window (and any half-typed message) for the next tap; close ends it. The conversation itself is
 * remembered per school either way, and is the same one the full workspace shows.
 * The school is resolved from the signed-in session when it opens; the orb itself reads nothing.
 */
export function ShellHonCorner({ path, label, title, inert, asleep = false }: { path: string; label: string; title: string; inert?: boolean; asleep?: boolean }): React.ReactElement {
  const [state, setState] = useState<DockState>('closed');
  const [closing, setClosing] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const timer = useRef<number | null>(null);
  useEffect(() => () => { if (timer.current !== null) window.clearTimeout(timer.current); }, []);

  const settle = (next: Exclude<DockState, 'open'>) => {
    setClosing(false); setState(next);
    requestAnimationFrame(() => button.current?.focus());
  };
  const shrinkTo = (next: Exclude<DockState, 'open'>) => {
    if (closing) return;
    if (reducedMotion()) { settle(next); return; }
    setClosing(true);
    timer.current = window.setTimeout(() => { timer.current = null; settle(next); }, SHRINK_MS);
  };
  const open = state === 'open';
  return <>
    {/* While the chat is open it sits in this corner, so the orb steps aside; it comes back when the chat shrinks away. */}
    <button ref={button} type="button" inert={inert} hidden={open} className={styles.honLauncher} data-hon-corner="" aria-haspopup="dialog" aria-expanded={open}
      aria-label={label} title={title} onClick={() => setState('open')}>
      <img src="/ai/hon-core.webp" alt="" width={44} height={44} /><span>{label}</span></button>
    {/* Behind the screensaver the chat stays as it is (nothing typed is lost) but is hidden and inert, never shown over it. */}
    {state !== 'closed' ? <div hidden={asleep} inert={asleep || inert} data-hon-corner-popup="">
      <HonCornerDock hidden={state === 'minimized'} closing={closing} returnPath={path}
        onMinimize={() => shrinkTo('minimized')} onClose={() => shrinkTo('closed')} />
    </div> : null}
  </>;
}
