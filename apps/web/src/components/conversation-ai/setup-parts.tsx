'use client';
import React, { useState } from 'react';
import type { ConversationAiMode, ConversationAiProgramStatus } from '@hon/contracts';
import type { SetupCopy } from './setup-copy';
import { LENGTH_PRESETS, addHandoffWord, handoffList, removeHandoffWord, statusTone, type ModeSummary, type SetupChecklist } from './setup-model';
import s from './setup.module.css';

const CHOICES: readonly ConversationAiMode[] = ['OFF', 'ASSIST', 'AUTOMATIC'];

/** Three plain choices instead of a mode menu. "MIXED" presses none (each channel is set on its own). */
export function ModeChoice({ copy, value, disabled, onChoose }: { copy: SetupCopy; value: ModeSummary; disabled: boolean; onChoose: (mode: ConversationAiMode) => void }): React.ReactElement {
  return <div className={s.choices} role="group" aria-label={copy.choiceLabel}>
    {CHOICES.map(mode => <button key={mode} type="button" className={s.choice} data-mode={mode} aria-pressed={value === mode} disabled={disabled} onClick={() => onChoose(mode)}>
      <span className={s.choiceDot} aria-hidden="true" />
      <strong>{copy.choice[mode].title}</strong>
      <span>{copy.choice[mode].body}</span>
    </button>)}
  </div>;
}

export function StatusCard({ copy, program, summary }: { copy: SetupCopy; program: ConversationAiProgramStatus; summary: ModeSummary }): React.ReactElement {
  const tone = statusTone(program, summary);
  return <section className={s.status} data-tone={tone} aria-label={copy.title}>
    <span className={s.statusDot} aria-hidden="true" />
    <div><p className={s.statusNow}>{copy.now[summary]}</p>{program !== 'LIVE' && <p className={s.statusHq}>{copy.hq[program]}</p>}</div>
  </section>;
}

export type StepKey = 'how' | 'answers' | 'handoff' | 'tryIt';
export function Checklist({ copy, state, onGo }: { copy: SetupCopy; state: SetupChecklist; onGo: (step: StepKey) => void }): React.ReactElement {
  const rows: { key: StepKey; done: boolean; label: string; soon?: boolean }[] = [
    { key: 'how', done: state.how, label: copy.steps.how },
    { key: 'answers', done: state.answers, label: copy.steps.answers(state.answerCount) },
    { key: 'handoff', done: state.handoff, label: copy.steps.handoff },
    { key: 'tryIt', done: state.tryIt, label: copy.steps.tryIt, soon: true },
  ];
  return <section className={s.checklist} aria-labelledby="ca-checklist"><h2 id="ca-checklist">{copy.checklist}</h2>
    <ol>{rows.map((row, i) => <li key={row.key} data-done={row.done}>
      <span className={s.tick} aria-hidden="true">{row.done ? '✓' : i + 1}</span>
      <span className={s.stepLabel}>{row.label}</span>
      {row.soon ? <span className={s.soon}>{copy.tryItSoon}</span> : !row.done && <button type="button" className={s.link} onClick={() => onGo(row.key)}>{copy.go}</button>}
    </li>)}</ol>
  </section>;
}

export function HandoffChips({ copy, text, disabled, onChange }: { copy: SetupCopy; text: string; disabled: boolean; onChange: (text: string) => void }): React.ReactElement {
  const [word, setWord] = useState(''), [bad, setBad] = useState(false);
  const words = handoffList(text);
  function add(event: React.FormEvent | React.MouseEvent) {
    event.preventDefault();
    const next = addHandoffWord(text, word);
    if (next === null) { setBad(true); return; }
    setBad(false); setWord(''); onChange(next);
  }
  return <div className={s.chipsBox}>
    {words.length === 0 ? <p className={s.meta}>{copy.noWords}</p> : <ul className={s.chips}>{words.map(w => <li key={w} className={s.chip}>{w}
      <button type="button" aria-label={copy.remove(w)} disabled={disabled} onClick={() => onChange(removeHandoffWord(text, w))}>×</button></li>)}</ul>}
    <div className={s.inline}>
      <input aria-label={copy.wordPlaceholder} placeholder={copy.wordPlaceholder} value={word} disabled={disabled} maxLength={30} aria-invalid={bad}
        onChange={e => { setWord(e.target.value); setBad(false); }} onKeyDown={e => { if (e.key === 'Enter') add(e as unknown as React.FormEvent); }} />
      <button type="button" className={s.secondary} disabled={disabled || !word.trim()} onClick={add}>{copy.addWord}</button>
    </div>
    {bad && <p className={s.error} role="alert">{copy.wordInvalid}</p>}
  </div>;
}

export function LengthPresets({ copy, label, value, disabled, onChange }: { copy: SetupCopy; label: string; value: number; disabled: boolean; onChange: (chars: number) => void }): React.ReactElement {
  const custom = !LENGTH_PRESETS.some(p => p.chars === value);
  return <div className={s.lengthRow}><span className={s.lengthLabel}>{label}</span>
    <div className={s.segment} role="group" aria-label={label}>
      {LENGTH_PRESETS.map(p => <button key={p.key} type="button" aria-pressed={p.chars === value} disabled={disabled} onClick={() => onChange(p.chars)}>
        {copy.preset[p.key]}<small>{p.chars}</small></button>)}
    </div>
    <span className={s.meta}>{custom ? copy.chars(value) : ''}</span>
  </div>;
}
