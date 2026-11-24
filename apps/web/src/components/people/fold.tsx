import React, { useEffect, useId, useState } from 'react';
import styles from './people.module.css';

/** Remembered per browser only (a viewer convenience); losing it just opens every section again. */
const KEY = 'hon.people.folds.v1';
function readFolds(): Record<string, boolean> {
  try { const v = JSON.parse(window.localStorage.getItem(KEY) ?? '{}') as unknown; return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, boolean> : {}; }
  catch { return {}; }
}
function writeFold(id: string, closed: boolean): void {
  try { const all = readFolds(); if (closed) all[id] = true; else delete all[id]; window.localStorage.setItem(KEY, JSON.stringify(all)); } catch { /* storage unavailable: nothing to keep */ }
}

/**
 * One section of the contact card that staff can minimize to cut clutter (owner, 2026-11-21). Every section starts open;
 * a section someone minimized stays minimized on this browser. The content is only hidden, never dropped or re-read.
 */
export function Fold({ id, title, count, children, testId }: { id: string; title: string; count?: number | undefined; children: React.ReactNode; testId?: string | undefined }): React.ReactElement {
  const [open, setOpen] = useState(true);
  const body = useId();
  useEffect(() => { if (readFolds()[id] === true) setOpen(false); }, [id]);
  const toggle = () => setOpen(was => { writeFold(id, was); return !was; });
  return <section className={styles.fold} data-fold={id} data-open={open ? 'true' : 'false'} data-testid={testId}>
    <h3 className={styles.foldHead}>
      <button type="button" className={styles.foldButton} aria-expanded={open} aria-controls={body} onClick={toggle}>
        <span>{title}{count === undefined ? null : <span className={styles.count}>{count}</span>}</span>
        <span className={styles.foldIcon} aria-hidden="true">{open ? '−' : '+'}</span>
      </button>
    </h3>
    <div id={body} className={styles.foldBody} hidden={!open}>{children}</div>
  </section>;
}
