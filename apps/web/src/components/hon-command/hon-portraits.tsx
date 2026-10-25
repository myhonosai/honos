'use client';

import React, { useEffect, useRef, useState } from 'react';
import { HON_MARK_SOURCE } from '../classic-dashboard/portraits';
import type { HonCommandAgent } from './roster';
import styles from './hon-command.module.css';

/** HON mark and approved agent portraits with initial fallbacks, shared by every HON surface. */
export function HonMark({ size = 'md' }: { size?: 'sm' | 'md' | 'lg' }): React.ReactElement {
  const [failed, setFailed] = useState(false);
  const image = useRef<HTMLImageElement>(null);
  useEffect(() => {
    const element = image.current;
    if (element?.complete && element.naturalWidth === 0) setFailed(true);
  }, []);
  return <span className={styles.mark} data-size={size} aria-hidden="true">
    {failed ? <span className={styles.markFallback}>H</span> : <img ref={image} src={HON_MARK_SOURCE} alt="" onError={() => setFailed(true)} />}
  </span>;
}

export function AgentPortrait({ agent, size = 'md' }: { agent: Pick<HonCommandAgent, 'name' | 'color' | 'portrait'>; size?: 'sm' | 'md' | 'lg' }): React.ReactElement {
  const [failed, setFailed] = useState(false);
  const image = useRef<HTMLImageElement>(null);
  useEffect(() => {
    const element = image.current;
    if (element?.complete && element.naturalWidth === 0) setFailed(true);
  }, []);
  return <span className={styles.portrait} data-size={size} style={{ '--agent': agent.color } as React.CSSProperties} aria-hidden="true">
    {failed ? <span>{agent.name.charAt(0)}</span> : <img ref={image} src={agent.portrait} alt="" onError={() => setFailed(true)} />}
  </span>;
}
