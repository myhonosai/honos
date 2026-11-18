'use client';
import React, { useEffect, useRef } from 'react';
import { WALKIN_LIMITS, type WalkInStroke } from '@hon/contracts';
import styles from './walk-in-kiosk.module.css';

/** Pad coordinates are whole numbers 0-1000 on both axes (the 0396 stroke rule), whatever the drawn size. */
export const PAD_SIZE = 1000;
const clamp = (n: number) => Math.max(0, Math.min(PAD_SIZE, Math.round(n)));
export function padPoint(x: number, y: number, width: number, height: number): [number, number] {
  return [clamp((x / Math.max(1, width)) * PAD_SIZE), clamp((y / Math.max(1, height)) * PAD_SIZE)];
}
/** Adds a point to the open stroke, keeping inside the stroke and point limits; repeated points are skipped. */
export function addPadPoint(strokes: readonly WalkInStroke[], point: [number, number], newStroke: boolean): WalkInStroke[] {
  const total = strokes.reduce((n, s) => n + s.length, 0);
  if (total >= WALKIN_LIMITS.points) return [...strokes];
  if (newStroke) return strokes.length >= WALKIN_LIMITS.strokes ? [...strokes] : [...strokes, [point]];
  const last = strokes.at(-1);
  if (!last) return [[point]];
  const prev = last.at(-1);
  if (prev && prev[0] === point[0] && prev[1] === point[1]) return [...strokes];
  return [...strokes.slice(0, -1), [...last, point]];
}
/** Only strokes of at least two points count as a signature. */
export const signedStrokes = (strokes: readonly WalkInStroke[]): WalkInStroke[] => strokes.filter(s => s.length >= 2);
export function strokePath(strokes: readonly WalkInStroke[]): string {
  return strokes.map(s => s.map(([x, y], i) => `${i ? 'L' : 'M'}${x} ${y}`).join(' ')).join(' ');
}

/** A finger signature pad drawn as an SVG path (no canvas, no image upload). */
export function SignaturePad({ strokes, onChange, label, clearLabel }: {
  strokes: readonly WalkInStroke[]; onChange: (strokes: WalkInStroke[]) => void; label: string; clearLabel: string;
}): React.ReactElement {
  const box = useRef<SVGSVGElement | null>(null);
  const drawing = useRef(false);
  const latest = useRef(strokes);
  useEffect(() => { latest.current = strokes; }, [strokes]);
  const point = (e: React.PointerEvent<SVGSVGElement>): [number, number] => {
    const r = e.currentTarget.getBoundingClientRect();
    return padPoint(e.clientX - r.left, e.clientY - r.top, r.width, r.height);
  };
  const push = (next: WalkInStroke[]) => { latest.current = next; onChange(next); };
  return <div className={styles.pad}>
    <svg ref={box} role="img" aria-label={label} viewBox={`0 0 ${PAD_SIZE} ${PAD_SIZE / 3}`} preserveAspectRatio="none" data-testid="walkin-pad"
      onPointerDown={e => { e.currentTarget.setPointerCapture?.(e.pointerId); drawing.current = true; const [x, y] = point(e); push(addPadPoint(latest.current, [x, clamp(y)], true)); }}
      onPointerMove={e => { if (!drawing.current) return; const [x, y] = point(e); push(addPadPoint(latest.current, [x, clamp(y)], false)); }}
      onPointerUp={() => { drawing.current = false; }} onPointerCancel={() => { drawing.current = false; }} onPointerLeave={() => { drawing.current = false; }}>
      <g transform={`scale(1 ${1 / 3})`}><path d={strokePath(strokes)} fill="none" stroke="currentColor" strokeWidth={12} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke"/></g>
    </svg>
    <div className={styles.padFoot}><span>{label}</span><button type="button" className={styles.ghost} onClick={() => push([])}>{clearLabel}</button></div>
  </div>;
}
