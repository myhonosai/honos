'use client';

import React, { useEffect, useRef, useState } from 'react';
import { HON_CORE_SOURCE } from './roster';
import { ORB_LIVE_STATES, orbLevel, type HonOrbSignal, type HonOrbState } from './hon-orb-signal';
import styles from './hon-orb.module.css';

/** Eight direction ticks on the outer ring (HON's own detail: the eight directions of a stance). */
const TICKS = [0, 45, 90, 135, 180, 225, 270, 315] as const;

/** Follows the viewer's reduced-motion setting, including a change while the page is open. */
function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let query: MediaQueryList | null = null;
    try { query = window.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null; } catch { query = null; }
    if (!query) return;
    const update = () => setReduced(query!.matches);
    update();
    query.addEventListener?.('change', update);
    return () => query!.removeEventListener?.('change', update);
  }, []);
  return reduced;
}

/**
 * The living HON orb. Decorative only (the voice status line carries the words). Size comes from `className`.
 * Everything is CSS (transform/opacity) except one animation-frame loop that runs only while listening or speaking
 * and writes a single CSS variable, `--orb-level`. Reduced motion shows the orb still. See HON_ORB_PRESENCE.md.
 */
export function HonOrb({ state = 'idle', signal, className }: { state?: HonOrbState; signal?: HonOrbSignal | undefined; className?: string | undefined }): React.ReactElement {
  const root = useRef<HTMLSpanElement>(null);
  const reduced = useReducedMotion();
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    element.style.setProperty('--orb-level', '0');
    if (!signal || !ORB_LIVE_STATES.has(state) || reduced || typeof requestAnimationFrame !== 'function') return;
    let frame = 0;
    const tick = (now: number) => {
      element.style.setProperty('--orb-level', orbLevel(state, signal.sample(now), now).toFixed(3));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(frame); element.style.setProperty('--orb-level', '0'); };
  }, [state, signal, reduced]);

  return <span ref={root} className={`${styles.orb}${className ? ` ${className}` : ''}`} data-orb-state={state} aria-hidden="true">
    <span className={styles.auraLevel}><span className={styles.aura} /></span>
    <span className={styles.ripple} /><span className={`${styles.ripple} ${styles.rippleLate}`} />
    <span className={styles.body}>
      <span className={styles.core}>
        <span className={styles.swirl}><span className={styles.swirlBoost}><img src={HON_CORE_SOURCE} alt="" draggable={false} /></span></span>
        <span className={styles.shimmer} />
      </span>
    </span>
    <svg className={styles.rings} viewBox="0 0 200 200" focusable="false">
      <g className={styles.dial}>
        <circle cx="100" cy="100" r="96" className={styles.dialRing} />
        {TICKS.map((angle) => <line key={angle} data-orb-tick="" x1="100" y1="2" x2="100" y2={angle % 90 === 0 ? 10 : 7} transform={`rotate(${angle} 100 100)`} className={styles.tick} />)}
      </g>
      <g className={styles.scan}><circle cx="100" cy="100" r="89" pathLength={100} className={styles.scanArc} /></g>
      <g className={`${styles.spin} ${styles.spinA}`}><g className={`${styles.boost} ${styles.boostA}`}>
        <ellipse cx="100" cy="100" rx="88" ry="27" transform="rotate(-20 100 100)" className={styles.orbit} />
        <ellipse cx="100" cy="100" rx="88" ry="27" transform="rotate(-20 100 100)" pathLength={100} className={`${styles.spark} ${styles.sparkA}`} />
      </g></g>
      <g className={`${styles.spin} ${styles.spinB}`}><g className={`${styles.boost} ${styles.boostB}`}>
        <ellipse cx="100" cy="100" rx="82" ry="36" transform="rotate(28 100 100)" className={styles.orbit} />
        <ellipse cx="100" cy="100" rx="82" ry="36" transform="rotate(28 100 100)" pathLength={100} className={`${styles.spark} ${styles.sparkB}`} />
      </g></g>
    </svg>
  </span>;
}
