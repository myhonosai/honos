'use client';
import React, { useEffect, useRef, useState } from 'react';
import { RANK_CHART_LIMITS, RANK_SETUP_LIMITS, isValidRankSetupName, type RankChartCurrent, type RankChartView, type RankSetupRankInput } from '@hon/contracts';
import { rankChartOutcome } from './ai-draft-http';
import { RANK_TEMPLATES, beltListProblem, buildBelts, choicesFor, type QuickChoices, type RankTemplate } from './templates';
import { honAgentVoice, honVoiceLang } from '../hon-command/hon-voice';
import { useHonVoice } from '../hon-command/hon-voice-controls';
import s from '../curriculum-look/look.module.css';

/**
 * Rank setup > Quick setup (docs/architecture/RANK_SETUP_AND_PLAIN_CURRICULUM_PAGES.md section 5a). Three steps: pick the martial
 * art, answer a few questions, check the list. Nothing is saved until "Create"; the whole program and its belts are then one command.
 * Section 5b: the school can instead describe its ranks in its own words and Kai drafts the list (0636); the draft lands in the
 * same editable list and is saved by the same command.
 */
export interface QuickSetupAi {
  /** null while unknown, false when AI drafting is not switched on or not allowed. */
  available: boolean | null;
  /** One turn: what the person said and, when a list is on screen, that list for Kai to change. */
  draft(description: string, current: RankChartCurrent | null): Promise<RankChartView>;
  /** Tells the server the draft was saved as a program. Best effort. */
  used(id: string): void;
}
/** Things a person might say once a list is on screen. */
export const AI_FOLLOW_UPS: readonly string[] = ['Add a white stripe step between every belt.', 'Make every belt 36 classes and 3 months.', 'Add 2nd and 3rd degree black belt at the end.'];
type Turn = { id: number; said: string; kai: string; ok: boolean };
export const AI_EXAMPLES: readonly string[] = [
  'Kids Taekwondo. White, yellow, orange, green, blue, purple, brown, red, then junior black. A white stripe step between each color. About 24 classes and 2 months per belt.',
  'Brazilian Jiu-Jitsu for adults. White, blue, purple, brown, black, with 4 stripes on each belt.',
  'Shotokan Karate with 9 kyu grades from white to brown, then 1st to 3rd dan black belt.',
];
const num = (v: string, max: number) => Math.min(max, Math.max(0, Math.trunc(Number(v) || 0)));
let rowId = 0;
type Row = RankSetupRankInput & { key: number };
const rows = (list: RankSetupRankInput[]): Row[] => list.map((b) => ({ ...b, key: ++rowId }));

/**
 * Talk to Kai out loud (HON_VOICE_CONVERSATION.md, the same controller as Ask HON): tap, say it, and Kai says back what it did
 * and listens for the next thing. The browser turns speech into text; Kai gets only the text, exactly as if it was typed.
 */
function KaiVoice({ canAsk, working, onSay }: { canAsk: boolean; working: boolean; onSay: (heard: string, answer: (text: string) => void) => boolean }): React.ReactElement | null {
  const say = useRef(onSay); say.current = onSay;
  const [lang, setLang] = useState(() => honVoiceLang('en'));
  useEffect(() => { setLang(honVoiceLang(document.documentElement.lang)); }, []);
  const back = useRef<(text: string) => void>(() => {});
  const voice = useHonVoice(lang, (text) => say.current(text, (reply) => back.current(reply)));
  back.current = (reply) => voice.replyParts([{ text: reply, profile: honAgentVoice('kai') }]);
  const c = voice.controls(canAsk), state = c.snapshot.state;
  if (!c.support.checked) return null;
  if (!c.support.recognition) return <p className={s.muted} data-kai-voice="unsupported">Talking out loud is not supported in this browser. Try Chrome, Edge or Safari, or type above.</p>;
  const listening = state === 'LISTENING' || state === 'FOLLOW_UP';
  const label = listening ? (state === 'FOLLOW_UP' ? 'Listening for what to change next. Say "thank you" to finish.' : 'Listening…') : state === 'SENDING' || working ? 'Kai is working…'
    : state === 'SPEAKING' ? 'Kai is answering…' : state === 'BLOCKED' ? 'The microphone is blocked. Allow it in your browser, then tap again.' : 'Or say it out loud.';
  return <div className={s.kaiVoice} data-kai-voice={state}>
    <div className={s.actions}>
      {listening ? <button type="button" className={s.ghost} onClick={c.onCancelListening}>Stop listening</button>
        : <button type="button" className={s.primary} disabled={!canAsk || state === 'SENDING'} onClick={c.onTalk}>🎤 Talk to Kai</button>}
      {state === 'SPEAKING' && <button type="button" className={s.ghost} onClick={c.onStopSpeaking}>Stop talking</button>}
      <span role="status" aria-live="polite" className={s.muted}>{label}{c.snapshot.heard ? ` “${c.snapshot.heard}”` : ''}{c.snapshot.message && !listening ? ` ${c.snapshot.message.replace(/\bHON\b/g, 'Kai')}` : ''}</span>
    </div>
    <p className={s.muted}>Your browser turns your speech into text; some browsers (like Chrome and Edge) do that on the browser maker&apos;s servers. Kai gets only the text, just like typing. HON OS records and saves no audio.{!c.support.synthesis ? ' This browser cannot read answers aloud; they appear on screen.' : ''}</p>
  </div>;
}

export function QuickSetup({ busy, onCreate, onCancel, ai }: { busy: boolean; onCreate: (name: string, ranks: RankSetupRankInput[]) => Promise<boolean>; onCancel?: () => void; ai?: QuickSetupAi }): React.ReactElement {
  const [template, setTemplate] = useState<RankTemplate | null>(null), [choices, setChoices] = useState<QuickChoices>({ stripes: 0, degrees: 0, classes: 0, days: 0 });
  const [name, setName] = useState(''), [list, setList] = useState<Row[]>([]);
  // Talking to Kai: every turn sends what the person said and the list on screen; the answer replaces that list. The id of the
  // last draft is kept so a saved one can be marked used. Nothing is saved until the person creates the program.
  const [words, setWords] = useState(''), [drafting, setDrafting] = useState(false), [turns, setTurns] = useState<Turn[]>([]), [aiError, setAiError] = useState(''), [drafted, setDrafted] = useState<string | null>(null);
  const said = words.trim(), asking = useRef(false), turnId = useRef(0);
  const pick = (t: RankTemplate) => { const c = choicesFor(t); setTemplate(t); setChoices(c); setName(t.programName); setList(rows(buildBelts(t, c))); setDrafted(null); };
  const clean = name.trim(), tidy = list.map(({ key: _key, ...b }) => ({ ...b, name: b.name.trim() }));
  const problem = beltListProblem(tidy) || (tidy.some((b) => !isValidRankSetupName(b.name)) ? 'Belt names can be up to 120 characters, without < or >.' : '');
  const shown = Boolean(template || drafted);
  /**
   * One turn, typed or spoken. Returns false when nothing was sent. `heard` is the spoken sentence (the typed box is left alone)
   * and `answer` gets the words Kai should say back.
   */
  function askAi(heard?: string, answer?: (text: string) => void): boolean {
    const text = (heard ?? said).replace(/\s+/g, ' ').trim().slice(0, RANK_CHART_LIMITS.description).trim();
    if (!ai || ai.available !== true || busy || asking.current || !text) return false;
    // Kai changes the list exactly as it stands, so a list that could not be saved is fixed by hand first.
    if (shown && (problem || !isValidRankSetupName(clean))) { setAiError(`Fix the list below first, then ask Kai again. ${problem || 'The program needs a name.'}`); return false; }
    asking.current = true; setDrafting(true); setAiError('');
    const current: RankChartCurrent | null = shown ? { name: clean, ranks: tidy.map((b) => ({ ...b, color: b.color ? b.color.toUpperCase() : null })) } : null;
    const add = (kai: string, ok: boolean) => { setTurns((t) => [...t, { id: ++turnId.current, said: text, kai, ok }].slice(-6)); answer?.(kai); };
    void (async () => {
      try {
        const view = await ai.draft(text, current); const trouble = rankChartOutcome(view);
        if (trouble || !view.draft) { add(trouble, false); return; }
        setTemplate(null); setDrafted(view.id); setName(view.draft.name); setList(rows(view.draft.ranks)); add(view.draft.summary, true); if (heard === undefined) setWords('');
      } catch (e) { const m = e instanceof Error ? e.message : 'Kai could not be reached. Use the choices below.'; setAiError(m); answer?.(m); }
      finally { asking.current = false; setDrafting(false); }
    })();
    return true;
  }
  const choose = (patch: Partial<QuickChoices>) => { if (!template) return; const next = { ...choices, ...patch }; setChoices(next); setList(rows(buildBelts(template, next))); };
  const edit = (key: number, patch: Partial<RankSetupRankInput>) => setList((l) => l.map((b) => b.key === key ? { ...b, ...patch } : b));
  const move = (i: number, by: number) => setList((l) => { const next = [...l], [row] = next.splice(i, 1); next.splice(i + by, 0, row!); return next; });

  return <section className={s.panel} aria-labelledby="quick-setup">
    <div className={s.beltHead}><h2 id="quick-setup">Quick setup</h2>{onCancel && <button type="button" className={s.ghost} disabled={busy} onClick={onCancel}>Close</button>}</div>
    <p className={s.muted}>Answer a few questions and HON OS builds the belt list for you. You check it before it is saved, and you can change anything later.</p>
    {ai && <fieldset disabled={busy || drafting} className={s.aiBox}><legend className={s.label}>Set it up by talking to Kai</legend>
      <p className={s.muted}>Tell Kai, your AI teaching assistant, what you teach and how your ranks work. Kai builds the list, and you can keep talking to change it. You check it before anything is saved.</p>
      {turns.length > 0 && <ol className={s.aiTalk} role="log" aria-label="Your conversation with Kai">{turns.map((t) => <li key={t.id}>
        <p className={s.aiYou}><strong>You:</strong> {t.said}</p><p className={s.aiKai} data-tone={t.ok ? 'ok' : 'bad'}><strong>Kai:</strong> {t.kai}</p></li>)}</ol>}
      <label className={s.label}>{shown ? 'Tell Kai what to change' : 'Your martial art and ranks'}<textarea className={s.field} maxLength={RANK_CHART_LIMITS.description} rows={3} value={words}
        placeholder={shown ? 'Add a stripe between every belt. Make each belt 36 classes.' : 'Kids Taekwondo. White, yellow, green, blue, red, black. A stripe between each belt.'} onChange={(e) => setWords(e.target.value)} /></label>
      <div className={s.actions}>{shown ? AI_FOLLOW_UPS.map((x) => <button key={x} type="button" className={s.add} onClick={() => setWords(x)}>{x}</button>)
        : AI_EXAMPLES.map((x, i) => <button key={x} type="button" className={s.add} onClick={() => setWords(x)}>Example {i + 1}: {x.split('.')[0]}</button>)}</div>
      <div className={s.actions}><button type="button" className={s.primary} disabled={busy || drafting || !said || ai.available !== true} onClick={() => { askAi(); }}>{drafting ? 'Kai is working…' : shown ? 'Send to Kai' : 'Draft my ranks with AI'}</button>
        <span className={s.muted}>{said.length}/{RANK_CHART_LIMITS.description}</span></div>
      {ai.available === true && <KaiVoice canAsk={!busy && !drafting} working={drafting} onSay={askAi} />}
      {ai.available === false && <p className={s.muted}>Kai is not available on your account yet. Use the choices below; they need no AI.</p>}
      {ai.available === true && <p className={s.muted}>Each message uses your school&apos;s AI allowance. Kai sees only what you type here, the list on this screen and the names of your programs.</p>}
      {aiError && <p role="alert" className={s.flash} data-tone="bad">{aiError}</p>}
    </fieldset>}
    <fieldset disabled={busy} className={s.stack}><legend className={s.label}>{ai ? '1. Or pick what you teach' : '1. What do you teach?'}</legend>
      <div className={s.choices}>{RANK_TEMPLATES.map((t) => <button key={t.id} type="button" className={s.choice} aria-pressed={template?.id === t.id} onClick={() => pick(t)}>
        <span><strong>{t.art}</strong><br /><span className={s.muted}>{t.hint}</span></span></button>)}</div></fieldset>
    {shown && <form className={s.stack} onSubmit={(e) => { e.preventDefault(); if (!problem && isValidRankSetupName(clean)) void onCreate(clean, tidy).then((ok) => { if (ok && drafted && ai) ai.used(drafted); }); }}>
      {drafted && <p role="status" className={s.flash} data-tone="ok">Kai built this list. Check every belt before you create it, and change anything by hand or by telling Kai above.</p>}
      <fieldset disabled={busy} className={s.stack}><legend className={s.label}>{template ? '2. A few questions' : '2. Program name'}</legend>
        <div className={s.grid2}>
          <label className={s.label}>Program name<input className={s.field} required maxLength={120} value={name} placeholder="Kids Taekwondo" onChange={(e) => setName(e.target.value)} /></label>
          {template && <label className={s.label}>Stripes on each belt<select className={s.field} value={choices.stripes} onChange={(e) => choose({ stripes: Number(e.target.value) })}>
            {[0, 1, 2, 3, 4].map((n) => <option key={n} value={n}>{n === 0 ? 'No stripes' : n === 1 ? '1 stripe' : `${n} stripes`}</option>)}</select></label>}
          {template?.black && <label className={s.label}>Black belt degrees<select className={s.field} value={choices.degrees} onChange={(e) => choose({ degrees: Number(e.target.value) })}>
            <option value={0}>Just one black belt</option>{[2, 3, 4, 5, 6, 7, 8, 9].map((n) => <option key={n} value={n}>1st to {n}{n === 2 ? 'nd' : n === 3 ? 'rd' : 'th'} degree</option>)}</select></label>}
          {template && <label className={s.label}>Classes before the next belt<input className={s.field} type="number" inputMode="numeric" min={0} max={RANK_SETUP_LIMITS.classes} value={choices.classes}
            onChange={(e) => choose({ classes: num(e.target.value, RANK_SETUP_LIMITS.classes) })} /></label>}
          {template && <label className={s.label}>Days at each belt<input className={s.field} type="number" inputMode="numeric" min={0} max={RANK_SETUP_LIMITS.days} value={choices.days}
            onChange={(e) => choose({ days: num(e.target.value, RANK_SETUP_LIMITS.days) })} /></label>}
        </div>
        {template ? <p className={s.muted}>Use 0 for no minimum. Changing an answer here rebuilds the list below.</p>
          : <p className={s.muted}>Change any belt in the list below. Use 0 for no minimum.</p>}</fieldset>
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
