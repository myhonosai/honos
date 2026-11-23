'use client';
import React, { useState } from 'react';
import { RANK_SETUP_LIMITS, isValidRankSetupName, type RankSetupRankInput } from '@hon/contracts';
import { RANK_TEMPLATES, beltListProblem, buildBelts, choicesFor, type QuickChoices, type RankTemplate } from './templates';
import s from '../curriculum-look/look.module.css';

/**
 * Rank setup > Quick setup (docs/architecture/RANK_SETUP_AND_PLAIN_CURRICULUM_PAGES.md section 5a). Three steps: pick the martial
 * art, answer a few questions, check the list. Nothing is saved until "Create"; the whole program and its belts are then one command.
 */
const num = (v: string, max: number) => Math.min(max, Math.max(0, Math.trunc(Number(v) || 0)));
let rowId = 0;
type Row = RankSetupRankInput & { key: number };
const rows = (list: RankSetupRankInput[]): Row[] => list.map((b) => ({ ...b, key: ++rowId }));

export function QuickSetup({ busy, onCreate, onCancel }: { busy: boolean; onCreate: (name: string, ranks: RankSetupRankInput[]) => Promise<boolean>; onCancel?: () => void }): React.ReactElement {
  const [template, setTemplate] = useState<RankTemplate | null>(null), [choices, setChoices] = useState<QuickChoices>({ stripes: 0, degrees: 0, classes: 0, days: 0 });
  const [name, setName] = useState(''), [list, setList] = useState<Row[]>([]);
  const pick = (t: RankTemplate) => { const c = choicesFor(t); setTemplate(t); setChoices(c); setName(t.programName); setList(rows(buildBelts(t, c))); };
  const choose = (patch: Partial<QuickChoices>) => { if (!template) return; const next = { ...choices, ...patch }; setChoices(next); setList(rows(buildBelts(template, next))); };
  const edit = (key: number, patch: Partial<RankSetupRankInput>) => setList((l) => l.map((b) => b.key === key ? { ...b, ...patch } : b));
  const move = (i: number, by: number) => setList((l) => { const next = [...l], [row] = next.splice(i, 1); next.splice(i + by, 0, row!); return next; });
  const clean = name.trim(), tidy = list.map(({ key: _key, ...b }) => ({ ...b, name: b.name.trim() }));
  const problem = beltListProblem(tidy) || (tidy.some((b) => !isValidRankSetupName(b.name)) ? 'Belt names can be up to 120 characters, without < or >.' : '');

  return <section className={s.panel} aria-labelledby="quick-setup">
    <div className={s.beltHead}><h2 id="quick-setup">Quick setup</h2>{onCancel && <button type="button" className={s.ghost} disabled={busy} onClick={onCancel}>Close</button>}</div>
    <p className={s.muted}>Answer a few questions and HON OS builds the belt list for you. You check it before it is saved, and you can change anything later.</p>
    <fieldset disabled={busy} className={s.stack}><legend className={s.label}>1. What do you teach?</legend>
      <div className={s.choices}>{RANK_TEMPLATES.map((t) => <button key={t.id} type="button" className={s.choice} aria-pressed={template?.id === t.id} onClick={() => pick(t)}>
        <span><strong>{t.art}</strong><br /><span className={s.muted}>{t.hint}</span></span></button>)}</div></fieldset>
    {template && <form className={s.stack} onSubmit={(e) => { e.preventDefault(); if (!problem && isValidRankSetupName(clean)) void onCreate(clean, tidy); }}>
      <fieldset disabled={busy} className={s.stack}><legend className={s.label}>2. A few questions</legend>
        <div className={s.grid2}>
          <label className={s.label}>Program name<input className={s.field} required maxLength={120} value={name} placeholder="Kids Taekwondo" onChange={(e) => setName(e.target.value)} /></label>
          <label className={s.label}>Stripes on each belt<select className={s.field} value={choices.stripes} onChange={(e) => choose({ stripes: Number(e.target.value) })}>
            {[0, 1, 2, 3, 4].map((n) => <option key={n} value={n}>{n === 0 ? 'No stripes' : n === 1 ? '1 stripe' : `${n} stripes`}</option>)}</select></label>
          {template.black && <label className={s.label}>Black belt degrees<select className={s.field} value={choices.degrees} onChange={(e) => choose({ degrees: Number(e.target.value) })}>
            <option value={0}>Just one black belt</option>{[2, 3, 4, 5, 6, 7, 8, 9].map((n) => <option key={n} value={n}>1st to {n}{n === 2 ? 'nd' : n === 3 ? 'rd' : 'th'} degree</option>)}</select></label>}
          <label className={s.label}>Classes before the next belt<input className={s.field} type="number" inputMode="numeric" min={0} max={RANK_SETUP_LIMITS.classes} value={choices.classes}
            onChange={(e) => choose({ classes: num(e.target.value, RANK_SETUP_LIMITS.classes) })} /></label>
          <label className={s.label}>Days at each belt<input className={s.field} type="number" inputMode="numeric" min={0} max={RANK_SETUP_LIMITS.days} value={choices.days}
            onChange={(e) => choose({ days: num(e.target.value, RANK_SETUP_LIMITS.days) })} /></label>
        </div>
        <p className={s.muted}>Use 0 for no minimum. Changing an answer here rebuilds the list below.</p></fieldset>
      <fieldset disabled={busy} className={s.stack}><legend className={s.label}>3. Check the list ({list.length} {list.length === 1 ? 'belt' : 'belts'}, first to last)</legend>
        <ol className={s.quickList}>{list.map((b, i) => <li key={b.key} className={s.quickRow}>
          <span className={s.pos}>{i + 1}</span>
          <input type="color" className={s.colorInput} aria-label={`Color of belt ${i + 1}`} value={b.color ?? '#888888'} onChange={(e) => edit(b.key, { color: e.target.value.toUpperCase() })} />
          <input className={s.field} aria-label={`Name of belt ${i + 1}`} maxLength={120} value={b.name} onChange={(e) => edit(b.key, { name: e.target.value })} />
          <label className={s.quickNum}>Classes<input className={s.field} type="number" inputMode="numeric" min={0} max={RANK_SETUP_LIMITS.classes} aria-label={`Classes for belt ${i + 1}`} value={b.classes}
            onChange={(e) => edit(b.key, { classes: num(e.target.value, RANK_SETUP_LIMITS.classes) })} /></label>
          <label className={s.quickNum}>Days<input className={s.field} type="number" inputMode="numeric" min={0} max={RANK_SETUP_LIMITS.days} aria-label={`Days for belt ${i + 1}`} value={b.days}
            onChange={(e) => edit(b.key, { days: num(e.target.value, RANK_SETUP_LIMITS.days) })} /></label>
          <span className={s.actions}>
            <button type="button" className={s.icon} aria-label={`Move belt ${i + 1} up`} disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
            <button type="button" className={s.icon} aria-label={`Move belt ${i + 1} down`} disabled={i === list.length - 1} onClick={() => move(i, 1)}>↓</button>
            <button type="button" className={s.icon} aria-label={`Remove belt ${i + 1}`} onClick={() => setList((l) => l.filter((x) => x.key !== b.key))}>✕</button></span>
        </li>)}</ol>
        <div className={s.actions}><button type="button" className={s.add} disabled={list.length >= RANK_SETUP_LIMITS.ranks}
          onClick={() => setList((l) => [...l, { key: ++rowId, name: '', color: null, classes: 0, days: 0 }])}>Add a belt to the end</button></div>
        {problem && <p role="alert" className={s.flash} data-tone="bad">{problem}</p>}
        <div className={s.actions}><button className={s.primary} disabled={busy || !!problem || !isValidRankSetupName(clean)}>Create {clean || 'program'} with {list.length} {list.length === 1 ? 'belt' : 'belts'}</button></div>
      </fieldset>
    </form>}
  </section>;
}
